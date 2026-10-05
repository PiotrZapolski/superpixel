# superpixel-log

A tiny log ingest service at https://superpixel.run. The Superpixel extension POSTs its debug log
warnings here, and the developer reads them back with a secret token. Python 3.12 stdlib only
(`http.server` + `sqlite3`), no dependencies. Data lives in SQLite at `/data/logs.db` on the
`superpixel_data` Docker volume.

## Keys

- `SUPERPIXEL_INGEST_KEY` is public by design. It ships in the open-source extension, so it only
  keeps out casual noise. Abuse is limited by the per-IP rate limit and the size limits.
- `SUPERPIXEL_READ_TOKEN` is secret. Anyone with it can read every log entry. If it is empty, all
  reads return 401.

## API

### `GET /healthz`

200 `ok` (text/plain).

### `POST /v1/logs`

Headers: `X-Superpixel-Key: <ingest key>`, `Content-Type: application/json`.

```json
{
  "install": "<uuid>",
  "version": "0.1.0",
  "scan": {"id": "<string>", "domain": "example.com"},
  "entries": [
    {"t": "<ISO time>", "level": "info|warn|error", "src": "bing", "msg": "..."}
  ]
}
```

`scan` may be `null`.

- Body at most 256 KiB, checked from `Content-Length` before reading (413).
- 1 to 500 entries (400 otherwise).
- Truncation: `msg` 1000 chars, `src` 40, `install` 64, `version` 20, `scan.domain` 253,
  `scan.id` 64, `t` 40. A `level` other than info, warn or error is stored as info.
- Missing or wrong key: 401. Bad JSON or shape: 400. Success: 204.
- Rate limit: 30 POSTs per rolling minute per client IP (first hop of `X-Forwarded-For`, which
  Caddy sets), in memory: 429.
- `OPTIONS /v1/logs` answers 204 with `Access-Control-Allow-Origin: *`.

### `GET /v1/logs`

Header: `Authorization: Bearer <read token>`, otherwise 401.

Optional query params:

| param     | meaning                                              |
|-----------|------------------------------------------------------|
| `since`   | ISO time, returns rows with `received_at >= since`   |
| `level`   | minimum level: info < warn < error                   |
| `src`     | exact match                                          |
| `install` | exact match                                          |
| `domain`  | exact match on the scan domain                       |
| `limit`   | default 200, max 2000                                |

Returns the latest `limit` matching rows, ordered oldest to newest:

```json
{"entries": [{"id": 1, "received_at": "2026-10-05T12:00:00.000Z", "install": "...",
  "version": "0.1.0", "scan_id": "...", "domain": "example.com",
  "t": "...", "level": "warn", "src": "bing", "msg": "..."}]}
```

`received_at` is server time in UTC. Anything else returns 404 `{"error":"not found"}`.

Retention: on insert, at most every 10 minutes, rows older than 30 days are deleted and only the
newest 200000 rows are kept.

## Reading logs

```sh
source ~/.superpixel.env
curl -s -H "Authorization: Bearer $SUPERPIXEL_READ_TOKEN" 'https://superpixel.run/v1/logs?level=warn&limit=100'
```

## Tests

`python -m unittest -v server/test_app.py` (runs in GitHub CI, job `server`).

## Deploy

Every push to `main` touching `server/**` runs `.github/workflows/deploy-server.yml`. It SSHes to
the prod box with a deploy key whose forced command is `server/deploy/remote-deploy.sh`: that
script pulls `origin/main`, rebuilds and restarts the container, and waits for it to be healthy.
The workflow then checks `https://superpixel.run/healthz`.

### One-time server setup (as root on 65.108.140.190)

1. Clone the repo: `git clone https://github.com/PiotrZapolski/superpixel.git /var/www/superpixel`.
2. Create `server/.env` from `server/.env.example`, fill both values, `chmod 600 server/.env`.
3. Add `server/deploy/Caddyfile.snippet` to the shared Caddy config as described in
   `/root/SERVER.md` section 5, then reload Caddy. Point the `superpixel.run` and
   `www.superpixel.run` DNS A records at the box.
4. Generate a deploy key pair (`ssh-keygen -t ed25519 -C superpixel-deploy -N ''`) and add the
   public key to `/root/.ssh/authorized_keys` with a forced command:

   ```
   command="/var/www/superpixel/server/deploy/remote-deploy.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... superpixel-deploy
   ```

5. In the GitHub repo secrets, set `SUPERPIXEL_DEPLOY_KEY` (the private key) and
   `SUPERPIXEL_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 65.108.140.190`).
6. First deploy: run the workflow manually (`workflow_dispatch`) or run the script once by hand.
