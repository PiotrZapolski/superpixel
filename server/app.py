"""Superpixel log ingest service.

The extension POSTs debug log entries to /v1/logs, the developer reads them
back with a secret bearer token. Python stdlib only.
"""

import hmac
import json
import os
import sqlite3
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

MAX_BODY = 256 * 1024
MAX_ENTRIES = 500
LEVELS = {"info": 0, "warn": 1, "error": 2}
DEFAULT_LIMIT = 200
MAX_LIMIT = 2000
RETENTION_DAYS = 30
MAX_ROWS = 200_000
PRUNE_EVERY = 600  # seconds

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    received_at TEXT,
    install TEXT,
    version TEXT,
    scan_id TEXT,
    domain TEXT,
    t TEXT,
    level TEXT,
    src TEXT,
    msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_received_at ON entries(received_at);
CREATE INDEX IF NOT EXISTS idx_entries_level_received_at ON entries(level, received_at);
"""


def iso(dt):
    """UTC timestamp in one fixed format, so string comparison orders by time."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso():
    return iso(datetime.now(timezone.utc))


class Store:
    """One shared SQLite connection guarded by a lock."""

    def __init__(self, path, max_rows=MAX_ROWS):
        self.lock = threading.Lock()
        self.max_rows = max_rows
        self.last_prune = 0.0
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def insert(self, rows):
        with self.lock:
            with self.db:
                self.db.executemany(
                    "INSERT INTO entries (received_at, install, version, scan_id, domain, t, level, src, msg)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
            if time.monotonic() - self.last_prune >= PRUNE_EVERY or self.last_prune == 0.0:
                self.last_prune = time.monotonic()
                self._prune()

    def _prune(self):
        cutoff = iso(datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS))
        with self.db:
            self.db.execute("DELETE FROM entries WHERE received_at < ?", (cutoff,))
            self.db.execute(
                "DELETE FROM entries WHERE id <= (SELECT id FROM entries ORDER BY id DESC LIMIT 1 OFFSET ?)",
                (self.max_rows,),
            )

    def query(self, since=None, min_level=None, src=None, install=None, domain=None, limit=DEFAULT_LIMIT):
        where, args = [], []
        if since:
            where.append("received_at >= ?")
            args.append(since)
        if min_level:
            allowed = [lv for lv, rank in LEVELS.items() if rank >= LEVELS[min_level]]
            where.append("level IN (%s)" % ",".join("?" * len(allowed)))
            args.extend(allowed)
        for col, val in (("src", src), ("install", install), ("domain", domain)):
            if val:
                where.append(f"{col} = ?")
                args.append(val)
        sql = "SELECT id, received_at, install, version, scan_id, domain, t, level, src, msg FROM entries"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
        return [dict(r) for r in reversed(rows)]

    def close(self):
        with self.lock:
            self.db.close()


class RateLimiter:
    """Rolling window counter per client IP, in memory."""

    def __init__(self, max_hits, window=60.0):
        self.max_hits = max_hits
        self.window = window
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, key):
        now = time.monotonic()
        with self.lock:
            q = self.hits.setdefault(key, deque())
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.max_hits:
                return False
            q.append(now)
            # Drop idle IPs now and then so the dict does not grow forever.
            if len(self.hits) > 10_000:
                self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] <= self.window}
            return True


class BadRequest(Exception):
    pass


def text(value, limit, field):
    """Coerce an optional string field and truncate it."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise BadRequest(f"{field} must be a string")
    return value[:limit]


def parse_payload(body):
    try:
        data = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise BadRequest("invalid json")
    if not isinstance(data, dict):
        raise BadRequest("body must be an object")

    install = text(data.get("install"), 64, "install")
    if not install:
        raise BadRequest("install is required")
    version = text(data.get("version"), 20, "version")

    scan = data.get("scan")
    if scan is not None and not isinstance(scan, dict):
        raise BadRequest("scan must be an object or null")
    scan_id = text(scan.get("id"), 64, "scan.id") if scan else ""
    domain = text(scan.get("domain"), 253, "scan.domain") if scan else ""

    entries = data.get("entries")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_ENTRIES:
        raise BadRequest(f"entries must be a list of 1 to {MAX_ENTRIES} items")

    received = now_iso()
    rows = []
    for e in entries:
        if not isinstance(e, dict):
            raise BadRequest("each entry must be an object")
        level = e.get("level")
        if level not in LEVELS:
            level = "info"
        rows.append((
            received, install, version, scan_id, domain,
            text(e.get("t"), 40, "t"),
            level,
            text(e.get("src"), 40, "src"),
            text(e.get("msg"), 1000, "msg"),
        ))
    return rows


def parse_since(value):
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        raise BadRequest("since must be an ISO time")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return iso(dt)


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
}
SHORT_CACHE_EXTS = {".html", ".txt", ".xml"}
SITE_FILES = {"/": "index.html", "/pl/": "pl/index.html", "/robots.txt": "robots.txt", "/sitemap.xml": "sitemap.xml"}


def resolve_static(site_dir, raw_path):
    """Map a request path to a regular file inside site_dir, or None."""
    if not site_dir:
        return None
    path = unquote(raw_path)
    if path in SITE_FILES:
        rel = SITE_FILES[path]
    elif path.startswith("/assets/"):
        rel = path[1:]
    else:
        return None
    if "\0" in rel or "\\" in rel:
        return None
    for seg in rel.split("/"):
        if seg == "" or seg.startswith("."):
            return None
    root = os.path.realpath(site_dir)
    full = os.path.realpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = "superpixel-log"
    sys_version = ""
    timeout = 30  # socket timeout, so a slow or stalled client cannot hold a thread forever

    # -- helpers --------------------------------------------------------

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def send(self, status, body=None, content_type="application/json", headers=None):
        payload = b""
        if body is not None:
            payload = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if body is not None:
            self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload and self.command != "HEAD":
            self.wfile.write(payload)

    def error(self, status, message):
        self.send(status, {"error": message})

    def log_message(self, fmt, *args):
        # Request line only; headers (and therefore keys) are never logged.
        sys.stderr.write("%s %s\n" % (self.client_ip(), fmt % args))

    # -- routes ---------------------------------------------------------

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/healthz":
            return self.send(200, "ok", "text/plain")
        if url.path == "/v1/logs":
            return self.read_logs(url.query)
        if self.serve_static(url.path):
            return
        self.error(404, "not found")

    def do_HEAD(self):
        url = urlsplit(self.path)
        if url.path == "/healthz":
            return self.send(200, "ok", "text/plain")
        if self.serve_static(url.path):
            return
        self.error(404, "not found")

    def serve_static(self, raw_path):
        """Serve a site file (headers only for HEAD). Returns False if the path is not a static route."""
        if raw_path == "/pl":
            self.send(301, headers={"Location": "/pl/"})
            return True
        full = resolve_static(self.server.app.site_dir, raw_path)
        if full is None:
            return False
        try:
            with open(full, "rb") as f:
                payload = f.read()
        except OSError:
            return False
        ext = os.path.splitext(full)[1].lower()
        max_age = 300 if ext in SHORT_CACHE_EXTS else 86400
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", f"public, max-age={max_age}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)
        return True

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if length > MAX_BODY:
            self.close_connection = True
            return self.error(413, "body too large")
        # Always consume the body: closing a socket with unread data sends a
        # TCP reset, which can make the client lose our error response.
        body = self.rfile.read(length) if length > 0 else b""

        if urlsplit(self.path).path != "/v1/logs":
            return self.error(404, "not found")
        app = self.server.app
        if not app.limiter.allow(self.client_ip()):
            return self.error(429, "rate limited")
        key = self.headers.get("X-Superpixel-Key", "")
        if not app.ingest_key or not hmac.compare_digest(key.encode(), app.ingest_key.encode()):
            return self.error(401, "unauthorized")
        if length < 0:
            return self.error(400, "content-length required")
        try:
            rows = parse_payload(body)
        except BadRequest as e:
            return self.error(400, str(e))
        app.store.insert(rows)
        self.send(204, headers={"Access-Control-Allow-Origin": "*"})

    def do_OPTIONS(self):
        if urlsplit(self.path).path != "/v1/logs":
            return self.error(404, "not found")
        self.send(204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type, X-Superpixel-Key",
            "Access-Control-Max-Age": "86400",
        })

    def do_PUT(self):
        self.error(404, "not found")

    do_DELETE = do_PATCH = do_PUT

    def read_logs(self, query):
        app = self.server.app
        auth = self.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if not app.read_token or not token or not hmac.compare_digest(token.encode(), app.read_token.encode()):
            return self.error(401, "unauthorized")
        q = {k: v[-1] for k, v in parse_qs(query).items()}
        try:
            since = parse_since(q["since"]) if q.get("since") else None
            level = q.get("level") or None
            if level and level not in LEVELS:
                raise BadRequest("level must be info, warn or error")
            try:
                limit = int(q.get("limit", DEFAULT_LIMIT))
            except ValueError:
                raise BadRequest("limit must be an integer")
            limit = max(1, min(limit, MAX_LIMIT))
        except BadRequest as e:
            return self.error(400, str(e))
        entries = app.store.query(
            since=since, min_level=level, src=q.get("src"),
            install=q.get("install"), domain=q.get("domain"), limit=limit,
        )
        self.send(200, {"entries": entries})


class App:
    def __init__(self, store, ingest_key, read_token, rate_limit, site_dir=None):
        self.site_dir = site_dir
        self.store = store
        self.ingest_key = ingest_key or ""
        self.read_token = read_token or ""
        self.limiter = RateLimiter(rate_limit)


def make_server(db_path, ingest_key, read_token, port=8000, host="0.0.0.0", rate_limit=30, site_dir=None):
    """Build (but do not start) the HTTP server. Port 0 picks a free port."""
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.app = App(Store(db_path), ingest_key, read_token, rate_limit, site_dir)
    return server


def main():
    server = make_server(
        os.environ.get("SUPERPIXEL_DB", "/data/logs.db"),
        os.environ.get("SUPERPIXEL_INGEST_KEY", ""),
        os.environ.get("SUPERPIXEL_READ_TOKEN", ""),
        port=int(os.environ.get("PORT", "8000")),
        site_dir=os.environ.get("SUPERPIXEL_SITE", "/app/site"),
    )
    if not server.app.ingest_key:
        print("warning: SUPERPIXEL_INGEST_KEY is empty, all ingest requests will be rejected", flush=True)
    if not server.app.read_token:
        print("warning: SUPERPIXEL_READ_TOKEN is empty, all reads will be rejected", flush=True)
    print("superpixel-log listening on %s:%d" % server.server_address[:2], flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.app.store.close()


if __name__ == "__main__":
    main()
