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


class SiteTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.site = os.path.join(self.tmp, "site")
        os.makedirs(os.path.join(self.site, "pl"))
        os.makedirs(os.path.join(self.site, "assets", "video"))
        os.makedirs(os.path.join(self.site, "privacy"))
        os.makedirs(os.path.join(self.site, "pl", "privacy"))
        os.makedirs(os.path.join(self.site, "video"))
        files = {
            "index.html": '<html lang="en"><body>en</body></html>',
            "pl/index.html": '<html lang="pl"><body>pl</body></html>',
            "privacy/index.html": '<html lang="en"><body>privacy en</body></html>',
            "pl/privacy/index.html": '<html lang="pl"><body>privacy pl</body></html>',
            "video/index.html": '<html lang="en"><body>video</body></html>',
            "assets/video/captions.vtt": "WEBVTT\n",
            "assets/style.css": "body{}",
            "assets/.hidden": "hidden",
            "secret.txt": "secret",
        }
        for rel, content in files.items():
            with open(os.path.join(self.site, rel), "w") as f:
                f.write(content)
        self.clip = bytes(i % 251 for i in range(1000))
        for rel in ("assets/video/clip.mp4", "assets/video/clip.webm", "assets/video/poster.jpg"):
            with open(os.path.join(self.site, rel), "wb") as f:
                f.write(self.clip)
        self.server = app.make_server(
            os.path.join(self.tmp, "logs.db"), "ingest", "read", port=0, host="127.0.0.1",
            site_dir=self.site,
        )
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.server.app.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def request(self, method, path, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, headers=headers or {})
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, raw, resp

    def test_root_english(self):
        status, raw, resp = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "text/html; charset=utf-8")
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn(b'lang="en"', raw)

    def test_polish(self):
        status, raw, _ = self.request("GET", "/pl/")
        self.assertEqual(status, 200)
        self.assertIn(b'lang="pl"', raw)

    def test_privacy_pages(self):
        for path, body in (("/privacy/", b"privacy en"), ("/pl/privacy/", b"privacy pl")):
            status, raw, resp = self.request("GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(resp.getheader("Content-Type"), "text/html; charset=utf-8", path)
            self.assertIn(body, raw, path)

    def test_privacy_redirects(self):
        for path, target in (("/privacy", "/privacy/"), ("/pl/privacy", "/pl/privacy/")):
            status, _, resp = self.request("GET", path)
            self.assertEqual(status, 301, path)
            self.assertEqual(resp.getheader("Location"), target, path)

    def test_real_site_has_privacy_pages_and_links(self):
        site = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
        for rel, lang in (("privacy/index.html", "en"), ("pl/privacy/index.html", "pl")):
            with open(os.path.join(site, rel), encoding="utf-8") as f:
                html = f.read()
            self.assertIn(f'lang="{lang}"', html, rel)
            self.assertIn('href="/privacy/"', html, rel)
            self.assertIn('href="/pl/privacy/"', html, rel)
            for dash in (chr(0x2014), chr(0x2013)):  # em and en dash: house style forbids them
                self.assertNotIn(dash, html, rel)
        for rel, target in (("index.html", "/privacy/"), ("pl/index.html", "/pl/privacy/")):
            with open(os.path.join(site, rel), encoding="utf-8") as f:
                html = f.read()
            self.assertIn(f'href="{target}"', html, rel)
        with open(os.path.join(site, "sitemap.xml"), encoding="utf-8") as f:
            sitemap = f.read()
        self.assertIn("<loc>https://superpixel.run/privacy/</loc>", sitemap)
        self.assertIn("<loc>https://superpixel.run/pl/privacy/</loc>", sitemap)

    def test_pl_redirects(self):
        status, _, resp = self.request("GET", "/pl")
        self.assertEqual(status, 301)
        self.assertEqual(resp.getheader("Location"), "/pl/")

    def test_asset(self):
        status, _, resp = self.request("GET", "/assets/style.css")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/css"))
        self.assertIn("max-age=86400", resp.getheader("Cache-Control"))

    def test_traversal_and_hidden_are_404(self):
        for path in ("/assets/../secret.txt", "/assets/%2e%2e/secret.txt", "/assets/.hidden", "/assets/"):
            status, raw, _ = self.request("GET", path)
            self.assertEqual(status, 404, path)
            self.assertEqual(json.loads(raw), {"error": "not found"}, path)

    def test_head_root(self):
        status, raw, resp = self.request("HEAD", "/")
        self.assertEqual(status, 200)
        self.assertGreater(int(resp.getheader("Content-Length")), 0)
        self.assertEqual(raw, b"")

    def test_head_unknown_404(self):
        status, _, _ = self.request("HEAD", "/nope")
        self.assertEqual(status, 404)

    def test_get_unknown_json_404(self):
        status, raw, _ = self.request("GET", "/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw), {"error": "not found"})

    def test_logs_still_need_token(self):
        status, _, _ = self.request("GET", "/v1/logs")
        self.assertEqual(status, 401)

    def test_healthz(self):
        status, raw, _ = self.request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"ok")

    def test_video_page(self):
        status, raw, resp = self.request("GET", "/video/")
        self.assertEqual(status, 200)
        self.assertEqual(resp.getheader("Content-Type"), "text/html; charset=utf-8")
        self.assertIn(b"video", raw)

    def test_video_redirects(self):
        status, _, resp = self.request("GET", "/video")
        self.assertEqual(status, 301)
        self.assertEqual(resp.getheader("Location"), "/video/")

    def test_media_content_types(self):
        for path, ctype in (
            ("/assets/video/clip.mp4", "video/mp4"),
            ("/assets/video/clip.webm", "video/webm"),
            ("/assets/video/poster.jpg", "image/jpeg"),
            ("/assets/video/captions.vtt", "text/vtt; charset=utf-8"),
        ):
            status, _, resp = self.request("GET", path)
            self.assertEqual(status, 200, path)
            self.assertEqual(resp.getheader("Content-Type"), ctype, path)

    def test_full_video_advertises_ranges(self):
        status, raw, resp = self.request("GET", "/assets/video/clip.mp4")
        self.assertEqual(status, 200)
        self.assertEqual(resp.getheader("Accept-Ranges"), "bytes")
        self.assertEqual(resp.getheader("Content-Length"), "1000")
        self.assertIsNone(resp.getheader("Content-Range"))
        self.assertEqual(raw, self.clip)

    def test_range_requests(self):
        cases = {
            "bytes=0-99": (0, 99),
            "bytes=0-1": (0, 1),
            "bytes=900-": (900, 999),
            "bytes=-10": (990, 999),
            "bytes=500-5000": (500, 999),
            "bytes=999-999": (999, 999),
        }
        for header, (start, end) in cases.items():
            status, raw, resp = self.request("GET", "/assets/video/clip.mp4", {"Range": header})
            self.assertEqual(status, 206, header)
            self.assertEqual(resp.getheader("Content-Range"), f"bytes {start}-{end}/1000", header)
            self.assertEqual(resp.getheader("Content-Length"), str(end - start + 1), header)
            self.assertEqual(resp.getheader("Content-Type"), "video/mp4", header)
            self.assertEqual(raw, self.clip[start:end + 1], header)

    def test_unsatisfiable_range_is_416(self):
        for header in ("bytes=1000-", "bytes=5000-6000", "bytes=-0"):
            status, raw, resp = self.request("GET", "/assets/video/clip.mp4", {"Range": header})
            self.assertEqual(status, 416, header)
            self.assertEqual(resp.getheader("Content-Range"), "bytes */1000", header)
            self.assertEqual(raw, b"", header)

    def test_ignored_ranges_send_whole_file(self):
        for header in ("bytes=abc", "items=0-10", "bytes=0-10,20-30", "bytes=50-10", "bytes="):
            status, raw, _ = self.request("GET", "/assets/video/clip.mp4", {"Range": header})
            self.assertEqual(status, 200, header)
            self.assertEqual(raw, self.clip, header)

    def test_head_with_range(self):
        status, raw, resp = self.request("HEAD", "/assets/video/clip.webm", {"Range": "bytes=0-9"})
        self.assertEqual(status, 206)
        self.assertEqual(resp.getheader("Content-Range"), "bytes 0-9/1000")
        self.assertEqual(resp.getheader("Content-Length"), "10")
        self.assertEqual(raw, b"")

    def test_html_also_accepts_ranges(self):
        status, raw, _ = self.request("GET", "/", {"Range": "bytes=0-5"})
        self.assertEqual(status, 206)
        self.assertEqual(raw, b"<html ")


class ParseRangeTestCase(unittest.TestCase):
    def test_parse_range(self):
        self.assertIsNone(app.parse_range(None, 100))
        self.assertIsNone(app.parse_range("", 100))
        self.assertEqual(app.parse_range("bytes=0-0", 100), (0, 0))
        self.assertEqual(app.parse_range("bytes=10-", 100), (10, 99))
        self.assertEqual(app.parse_range("bytes=-200", 100), (0, 99))
        self.assertEqual(app.parse_range(" bytes = 5 - 9 ", 100), (5, 9))
        self.assertEqual(app.parse_range("bytes=100-", 100), "unsatisfiable")
        self.assertEqual(app.parse_range("bytes=0-", 0), "unsatisfiable")
        self.assertIsNone(app.parse_range("bytes=1-2,4-5", 100))
        self.assertIsNone(app.parse_range("bytes=x-5", 100))
        self.assertIsNone(app.parse_range("bytes=-", 100))


if __name__ == "__main__":
    unittest.main()
