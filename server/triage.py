"""Superpixel log triage: a plain-text digest of recent debug log entries.

Run inside the log container:

    python triage.py [--hours 26] [--db /data/logs.db]

Prints a header, a summary of repeated messages (digits folded to '#'), adapter
finish statuses per platform, and the raw entries grouped by scan. Python stdlib only.
"""

import argparse
import os
import re
import sqlite3
import sys
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

DEFAULT_HOURS = 26
DEFAULT_DB = os.environ.get("SUPERPIXEL_DB", "/data/logs.db")
EXCLUDED_INSTALLS = ("claude-smoke",)
MAX_DOMAINS = 5
DIGITS_RE = re.compile(r"\d+")
FINISH_RE = re.compile(r"^Adapter finish: ([a-z_]+)")


def iso(dt):
    """Same fixed UTC format as app.py, so string comparison orders by time."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def load_entries(db_path, since):
    if not os.path.exists(db_path):
        raise sqlite3.OperationalError("no such file")
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    try:
        marks = ",".join("?" * len(EXCLUDED_INSTALLS))
        rows = db.execute(
            "SELECT id, received_at, install, version, scan_id, domain, t, level, src, msg FROM entries"
            f" WHERE received_at >= ? AND (install IS NULL OR install NOT IN ({marks}))"
            " ORDER BY id",
            (since, *EXCLUDED_INSTALLS),
        ).fetchall()
    finally:
        db.close()
    return [dict(r) for r in rows]


def fold(msg):
    return DIGITS_RE.sub("#", msg or "")


def summarize(entries):
    """Rows of (count, src, level, folded msg, domains, first, last), most frequent first."""
    groups = {}
    for e in entries:
        key = (e["src"] or "", e["level"] or "", fold(e["msg"]))
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"count": 0, "domains": [], "first": e["received_at"], "last": e["received_at"]}
        g["count"] += 1
        d = e["domain"] or ""
        if d and d not in g["domains"]:
            g["domains"].append(d)
        g["first"] = min(g["first"], e["received_at"])
        g["last"] = max(g["last"], e["received_at"])
    rows = [(g["count"], k[0], k[1], k[2], g["domains"], g["first"], g["last"]) for k, g in groups.items()]
    rows.sort(key=lambda r: (-r[0], r[1], r[2], r[3]))
    return rows


def finish_counts(entries):
    """{platform: {status: count}} from 'Adapter finish: <status>' lines."""
    out = {}
    for e in entries:
        m = FINISH_RE.match(e["msg"] or "")
        if not m:
            continue
        per = out.setdefault(e["src"] or "", {})
        per[m.group(1)] = per.get(m.group(1), 0) + 1
    return out


def by_scan(entries):
    scans = OrderedDict()
    for e in entries:
        scans.setdefault(e["scan_id"] or "-", []).append(e)
    return scans


def render(entries, since, until, hours):
    lines = []
    installs = {e["install"] for e in entries if e["install"]}
    scans = by_scan(entries)
    lines.append(
        f"superpixel triage: last {hours:g}h, {since} .. {until}, {len(entries)} entries,"
        f" {len(scans)} scans, {len(installs)} installs"
    )
    if not entries:
        lines.append("no entries")
        return "\n".join(lines) + "\n"

    lines.append("")
    lines.append("== summary (src level count: message, digits as #) ==")
    for count, src, level, msg, domains, first, last in summarize(entries):
        more = len(domains) - MAX_DOMAINS
        dom = ", ".join(domains[:MAX_DOMAINS]) + (f" +{more} more" if more > 0 else "")
        lines.append(f"{count:>5}  [{src}] {level.upper()}: {msg}")
        lines.append(f"       domains: {dom or '-'}; first {first}; last {last}")

    lines.append("")
    lines.append("== adapter finish by platform ==")
    finishes = finish_counts(entries)
    if not finishes:
        lines.append("(none)")
    for platform in sorted(finishes):
        per = finishes[platform]
        parts = ", ".join(f"{s} {n}" for s, n in sorted(per.items(), key=lambda x: (-x[1], x[0])))
        lines.append(f"{platform}: {parts}")

    lines.append("")
    lines.append("== entries by scan ==")
    for scan_id, rows in scans.items():
        domains = sorted({e["domain"] for e in rows if e["domain"]})
        lines.append("")
        lines.append(
            f"-- scan {scan_id} domain {', '.join(domains) or '-'} install {rows[0]['install'] or '-'}"
            f" version {rows[0]['version'] or '-'} ({len(rows)} entries)"
        )
        for e in rows:
            lines.append(f"{e['t'] or e['received_at']} {(e['level'] or 'info').upper()} [{e['src']}] {e['msg']}")
    return "\n".join(lines) + "\n"


def main(argv=None, now=None, out=None):
    parser = argparse.ArgumentParser(description="Plain-text digest of recent superpixel log entries.")
    parser.add_argument("--hours", type=float, default=DEFAULT_HOURS, help="window size (default 26)")
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite path (default /data/logs.db)")
    args = parser.parse_args(argv)
    out = out or sys.stdout
    now = now or datetime.now(timezone.utc)
    since = iso(now - timedelta(hours=args.hours))
    until = iso(now)
    try:
        entries = load_entries(args.db, since)
    except sqlite3.Error as e:
        out.write(f"superpixel triage: cannot read {args.db}: {e}\nno entries\n")
        return 0
    out.write(render(entries, since, until, args.hours))
    return 0


if __name__ == "__main__":
    sys.exit(main())
