import io
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app  # noqa: E402
import triage  # noqa: E402

NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def at(hours_ago):
    return app.iso(NOW - timedelta(hours=hours_ago))


class TriageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.db = os.path.join(self.tmp, "logs.db")
        self.store = app.Store(self.db)

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, hours_ago, scan, domain, level, src, msg, install="inst-1"):
        rec = at(hours_ago)
        # Raw insert: Store.insert would prune by the real clock, and NOW is fixed.
        with self.store.db:
            self.store.db.execute(
                "INSERT INTO entries (received_at, install, version, scan_id, domain, t, level, src, msg)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (rec, install, "0.2.0", scan, domain, rec, level, src, msg),
            )

    def run_triage(self, *argv):
        out = io.StringIO()
        code = triage.main(["--db", self.db, *argv], now=NOW, out=out)
        self.assertEqual(code, 0)
        return out.getvalue()

    def test_empty_window_prints_no_entries(self):
        self.add(30, "old", "old.com", "info", "scan", "too old")
        text = self.run_triage()
        self.assertIn("0 entries", text)
        self.assertTrue(text.rstrip().endswith("no entries"))
        self.assertNotIn("too old", text)

    def test_missing_db_exits_zero(self):
        out = io.StringIO()
        code = triage.main(["--db", os.path.join(self.tmp, "nope.db")], now=NOW, out=out)
        self.assertEqual(code, 0)
        self.assertIn("no entries", out.getvalue())
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "nope.db")))

    def test_summary_finish_table_and_scans(self):
        self.add(3, "s1", "aiagenthub.pl", "warn", "snap", "HTTP 429 adsapi.snapchat.com/v1/ads_library/ads/search")
        self.add(2.9, "s1", "aiagenthub.pl", "warn", "snap", "HTTP 429 adsapi.snapchat.com/v1/ads_library/ads/search")
        self.add(2.8, "s1", "aiagenthub.pl", "info", "snap", "Adapter finish: rate_limited, 0 ads, 3 requests, 20123ms")
        self.add(2.7, "s1", "aiagenthub.pl", "warn", "meta", "Adapter finish: changed, 0 ads, 1 requests, 9293ms")
        self.add(1, "s2", "example.com", "info", "meta", "Adapter finish: ok, 12 ads, 3 requests, 8000ms")
        self.add(0.5, "s3", "smoke.com", "error", "meta", "smoke only", install="claude-smoke")
        self.add(40, "s0", "old.com", "info", "meta", "Adapter finish: ok, 1 ads, 1 requests, 10ms")

        text = self.run_triage("--hours", "26")

        self.assertIn("superpixel triage: last 26h, 2026-10-04T10:00:00.000Z .. 2026-10-05T12:00:00.000Z", text)
        self.assertIn("5 entries, 2 scans, 1 installs", text)
        self.assertNotIn("smoke", text)
        self.assertNotIn("old.com", text)

        summary = text.split("== summary")[1].split("== adapter finish")[0]
        first = summary.splitlines()[1]
        self.assertEqual(first, "    2  [snap] WARN: HTTP # adsapi.snapchat.com/v#/ads_library/ads/search")
        self.assertIn(f"domains: aiagenthub.pl; first {at(3)}; last {at(2.9)}", summary)
        self.assertIn("[meta] INFO: Adapter finish: ok, # ads, # requests, #ms", summary)

        finish = text.split("== adapter finish by platform ==")[1].split("== entries by scan ==")[0]
        self.assertIn("meta: changed 1, ok 1", finish)
        self.assertIn("snap: rate_limited 1", finish)

        scans = text.split("== entries by scan ==")[1]
        self.assertIn("-- scan s1 domain aiagenthub.pl install inst-1 version 0.2.0 (4 entries)", scans)
        self.assertIn("-- scan s2 domain example.com", scans)
        self.assertLess(scans.index("HTTP 429"), scans.index("rate_limited"))
        self.assertIn(f"{at(2.7)} WARN [meta] Adapter finish: changed, 0 ads, 1 requests, 9293ms", scans)

    def test_domains_capped_at_five(self):
        for i in range(7):
            self.add(1, f"s{i}", f"d{i}.com", "warn", "bing", f"HTTP 500 {i}")
        text = self.run_triage()
        self.assertIn("    7  [bing] WARN: HTTP # #", text)
        self.assertIn("domains: d0.com, d1.com, d2.com, d3.com, d4.com +2 more;", text)


if __name__ == "__main__":
    unittest.main()
