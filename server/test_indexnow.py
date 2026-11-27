import io
import json
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import app  # noqa: E402
import indexnow  # noqa: E402

SITE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")


class IndexNowTestCase(unittest.TestCase):
    def test_payload_has_every_sitemap_url(self):
        payload = indexnow.build_payload()
        with open(os.path.join(SITE, "sitemap.xml"), encoding="utf-8") as f:
            self.assertEqual(len(payload["urlList"]), f.read().count("<loc>"))
        self.assertIn("https://superpixel.run/pl/", payload["urlList"])
        self.assertEqual(payload["host"], "superpixel.run")
        self.assertEqual(payload["keyLocation"], f"https://superpixel.run/{indexnow.KEY}.txt")

    def test_key_file_and_llms_txt_are_served(self):
        key_path = app.resolve_static(SITE, f"/{indexnow.KEY}.txt")
        with open(key_path, "rb") as f:
            self.assertEqual(f.read(), indexnow.KEY.encode())
        with open(app.resolve_static(SITE, "/llms.txt"), encoding="utf-8") as f:
            self.assertTrue(f.read().startswith("# Superpixel\n\n> "))

    def test_submit_posts_json_once_and_returns_status(self):
        seen = []

        class Response(io.BytesIO):
            status = 202

        def opener(request, timeout):
            seen.append(request)
            return Response()

        self.assertEqual(indexnow.submit({"host": "superpixel.run"}, opener), 202)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].get_method(), "POST")
        self.assertEqual(seen[0].full_url, "https://api.indexnow.org/indexnow")
        self.assertEqual(json.loads(seen[0].data), {"host": "superpixel.run"})

    def test_http_error_returns_its_code(self):
        def opener(request, timeout):
            raise urllib.error.HTTPError(request.full_url, 422, "bad", {}, None)

        self.assertEqual(indexnow.submit({}, opener), 422)


if __name__ == "__main__":
    unittest.main()
