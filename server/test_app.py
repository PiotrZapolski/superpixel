import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app  # noqa: E402

INGEST_KEY = "ingest-test-key"
READ_TOKEN = "read-test-token"


def payload(entries=None, **extra):
    body = {
        "install": "11111111-2222-3333-4444-555555555555",
        "version": "0.1.0",
        "scan": {"id": "scan-1", "domain": "example.com"},
        "entries": entries if entries is not None else [
            {"t": "2026-10-05T12:00:00.000Z", "level": "warn", "src": "bing", "msg": "hello"}
        ],
    }
    body.update(extra)
    return body


class ServerTestCase(unittest.TestCase):
    read_token = READ_TOKEN

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.server = app.make_server(
            os.path.join(self.tmp, "logs.db"), INGEST_KEY, self.read_token, port=0, host="127.0.0.1"
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.app.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(body).encode()
        conn.request(method, path, body=data, headers=headers or {})
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, raw, resp

    def post(self, body, key=INGEST_KEY, ip=None):
        headers = {"Content-Type": "application/json"}
        if key is not None:
            headers["X-Superpixel-Key"] = key
        if ip:
            headers["X-Forwarded-For"] = ip
        return self.request("POST", "/v1/logs", body, headers)

    def get_logs(self, query="", token=READ_TOKEN):
        headers = {}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        status, raw, _ = self.request("GET", "/v1/logs" + query, headers=headers)
        return status, (json.loads(raw) if raw else None)


class IngestAndReadTests(ServerTestCase):
    def test_healthz(self):
        status, raw, resp = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"ok")
        self.assertTrue(resp.getheader("Content-Type").startswith("text/plain"))

    def test_unknown_path_is_404_json(self):
        status, raw, _ = self.request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw), {"error": "not found"})

    def test_bad_ingest_key_is_401(self):
        self.assertEqual(self.post(payload(), key="wrong")[0], 401)
        self.assertEqual(self.post(payload(), key=None)[0], 401)

    def test_options_preflight(self):
        status, _, resp = self.request("OPTIONS", "/v1/logs")
        self.assertEqual(status, 204)
        self.assertEqual(resp.getheader("Access-Control-Allow-Origin"), "*")
        self.assertIn("X-Superpixel-Key", resp.getheader("Access-Control-Allow-Headers"))

    def test_ingest_then_read_with_truncation(self):
        entry = {"t": "2026-10-05T12:00:00.000Z", "level": "debug", "src": "s" * 50, "msg": "m" * 1500}
        body = payload([entry], install="i" * 100, version="v" * 30)
        body["scan"] = {"id": "x" * 100, "domain": "d" * 300}
        status, raw, _ = self.post(body)
        self.assertEqual(status, 204)
        self.assertEqual(raw, b"")

        status, data = self.get_logs()
        self.assertEqual(status, 200)
        self.assertEqual(len(data["entries"]), 1)
        row = data["entries"][0]
        self.assertEqual(len(row["msg"]), 1000)
        self.assertEqual(len(row["src"]), 40)
        self.assertEqual(len(row["install"]), 64)
        self.assertEqual(len(row["version"]), 20)
        self.assertEqual(len(row["scan_id"]), 64)
        self.assertEqual(len(row["domain"]), 253)
        self.assertEqual(row["level"], "info")
        self.assertEqual(row["t"], "2026-10-05T12:00:00.000Z")
        for field in ("id", "received_at", "install", "version", "scan_id", "domain", "t", "level", "src", "msg"):
            self.assertIn(field, row)

    def test_null_scan_is_accepted(self):
        self.assertEqual(self.post(payload(scan=None))[0], 204)
        _, data = self.get_logs()
        self.assertEqual(data["entries"][0]["domain"], "")

    def test_bad_shape_is_400(self):
        self.assertEqual(self.post(b"not json")[0], 400)
        self.assertEqual(self.post([1, 2])[0], 400)
        self.assertEqual(self.post(payload(entries=[]))[0], 400)
        self.assertEqual(self.post(payload(entries=["x"]))[0], 400)
        self.assertEqual(self.post(payload(entries=[{"msg": "x"}] * 501))[0], 400)
        self.assertEqual(self.post(payload(install=None))[0], 400)
        self.assertEqual(self.post(payload(scan="example.com"))[0], 400)
        self.assertEqual(self.post(payload(entries=[{"msg": 5}]))[0], 400)

    def test_oversized_content_length_is_413(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.putrequest("POST", "/v1/logs")
        conn.putheader("X-Superpixel-Key", INGEST_KEY)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(300 * 1024))
        conn.endheaders()
        resp = conn.getresponse()
        resp.read()
        conn.close()
        self.assertEqual(resp.status, 413)

    def test_level_filter(self):
        entries = [
            {"level": "info", "src": "a", "msg": "1"},
            {"level": "warn", "src": "b", "msg": "2"},
            {"level": "error", "src": "c", "msg": "3"},
        ]
        self.assertEqual(self.post(payload(entries))[0], 204)
        _, data = self.get_logs("?level=warn")
        self.assertEqual([e["msg"] for e in data["entries"]], ["2", "3"])
        _, data = self.get_logs("?level=error")
        self.assertEqual([e["msg"] for e in data["entries"]], ["3"])
        _, data = self.get_logs("?src=b")
        self.assertEqual([e["msg"] for e in data["entries"]], ["2"])
        status, _ = self.get_logs("?level=loud")
        self.assertEqual(status, 400)

    def test_limit_returns_latest_in_ascending_order(self):
        entries = [{"level": "info", "src": "x", "msg": str(i)} for i in range(10)]
        self.assertEqual(self.post(payload(entries))[0], 204)
        _, data = self.get_logs("?limit=3")
        self.assertEqual([e["msg"] for e in data["entries"]], ["7", "8", "9"])
        ids = [e["id"] for e in data["entries"]]
        self.assertEqual(ids, sorted(ids))

    def test_since_filter(self):
        self.assertEqual(self.post(payload())[0], 204)
        _, data = self.get_logs("?since=2000-01-01T00:00:00Z")
        self.assertEqual(len(data["entries"]), 1)
        _, data = self.get_logs("?since=2999-01-01T00:00:00Z")
        self.assertEqual(data["entries"], [])
        status, _ = self.get_logs("?since=yesterday")
        self.assertEqual(status, 400)

    def test_bad_read_token_is_401(self):
        self.assertEqual(self.get_logs(token="wrong")[0], 401)
        self.assertEqual(self.get_logs(token=None)[0], 401)
        self.assertEqual(self.get_logs(token="")[0], 401)

    def test_rate_limit_after_30_posts(self):
        for _ in range(30):
            self.assertEqual(self.post(payload(), ip="203.0.113.7")[0], 204)
        self.assertEqual(self.post(payload(), ip="203.0.113.7")[0], 429)
        # A different client is not affected.
        self.assertEqual(self.post(payload(), ip="203.0.113.8")[0], 204)


class EmptyReadTokenTests(ServerTestCase):
    read_token = ""

    def test_reads_always_401_when_token_unset(self):
        self.assertEqual(self.get_logs(token="")[0], 401)
        self.assertEqual(self.get_logs(token="anything")[0], 401)


class RetentionTests(unittest.TestCase):
    def test_prune_keeps_newest_rows(self):
        tmp = tempfile.mkdtemp()
        try:
            store = app.Store(os.path.join(tmp, "logs.db"), max_rows=5)
            old = "2000-01-01T00:00:00.000Z"
            store.db.execute(
                "INSERT INTO entries (received_at, install, version, scan_id, domain, t, level, src, msg)"
                " VALUES (?, 'i', 'v', '', '', '', 'info', 's', 'old')",
                (old,),
            )
            store.db.commit()
            rows = [(app.now_iso(), "i", "v", "", "", "", "info", "s", str(i)) for i in range(8)]
            store.insert(rows)
            msgs = [e["msg"] for e in store.query(limit=100)]
            self.assertEqual(msgs, ["3", "4", "5", "6", "7"])
            store.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
