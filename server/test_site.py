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
        os.makedirs(os.path.join(self.site, "assets"))
        os.makedirs(os.path.join(self.site, "privacy"))
        os.makedirs(os.path.join(self.site, "pl", "privacy"))
        files = {
            "index.html": '<html lang="en"><body>en</body></html>',
            "pl/index.html": '<html lang="pl"><body>pl</body></html>',
            "privacy/index.html": '<html lang="en"><body>privacy en</body></html>',
            "pl/privacy/index.html": '<html lang="pl"><body>privacy pl</body></html>',
            "assets/style.css": "body{}",
            "assets/.hidden": "hidden",
            "secret.txt": "secret",
        }
        for rel, content in files.items():
            with open(os.path.join(self.site, rel), "w") as f:
                f.write(content)
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

    def request(self, method, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path)
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
            self.assertNotIn(" - ", html, rel)
            self.assertNotIn("-", html, rel)
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


if __name__ == "__main__":
    unittest.main()
