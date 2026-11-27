"""Submit every sitemap URL to IndexNow. Run by deploy/remote-deploy.sh inside the container.

Prints the HTTP status. Exits non-zero on failure; the deploy script ignores that.
"""

import json
import os
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

ENDPOINT = "https://api.indexnow.org/indexnow"
HOST = "superpixel.run"
KEY = "16910976d82a85d6e7a36ddeef16e2eb"  # public by design, served at /<KEY>.txt
SITEMAP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "sitemap.xml")
LOC = "{http://www.sitemaps.org/schemas/sitemap/0.9}loc"


def build_payload(sitemap_path=SITEMAP):
    urls = [el.text.strip() for el in ET.parse(sitemap_path).iter(LOC) if el.text]
    return {
        "host": HOST,
        "key": KEY,
        "keyLocation": f"https://{HOST}/{KEY}.txt",
        "urlList": urls,
    }


def submit(payload, opener=urllib.request.urlopen):
    """POST the payload once and return the HTTP status code."""
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with opener(request, timeout=20) as response:
            return response.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    payload = build_payload()
    status = submit(payload)
    print(f"IndexNow: HTTP {status} for {len(payload['urlList'])} URLs", flush=True)
    return 0 if status in (200, 202) else 1


if __name__ == "__main__":
    sys.exit(main())
