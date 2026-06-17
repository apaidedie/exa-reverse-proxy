# Exa Reverse Proxy

[![CI](https://github.com/apaidedie/exa-reverse-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/apaidedie/exa-reverse-proxy/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/al1ya/exa-reverse-proxy?logo=docker)](https://hub.docker.com/r/al1ya/exa-reverse-proxy)
[![Docker Image Size](https://img.shields.io/docker/image-size/al1ya/exa-reverse-proxy/latest?logo=docker&label=image%20size)](https://hub.docker.com/r/al1ya/exa-reverse-proxy/tags)
[![Version](https://img.shields.io/badge/version-0.1.1-blue)](https://github.com/apaidedie/exa-reverse-proxy/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green?logo=node.js)](https://github.com/apaidedie/exa-reverse-proxy/blob/main/package.json)

Docker-deployable reverse proxy for Exa that balances requests across multiple upstream Exa API keys while exposing one Exa-compatible endpoint.

## One-Line Deploy (Docker Hub)

The fastest path on any VPS with Docker installed — pull the prebuilt image and bring it up:

```bash
# 1. Fetch the deployment compose file
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/docker-compose.yml -o docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/apaidedie/exa-reverse-proxy/main/.env.example -o .env

# 2. Put your real Exa API keys (one per line, or id:key:weight) in a secrets file
printf '%s\n' 'your_real_exa_key' > exa_api_key.txt

# 3. Set your own client/admin tokens in .env, then start
$EDITOR .env   # set EXA_PROXY_TOKENS, EXA_ADMIN_TOKENS, EXA_ADMIN_HEALTHCHECK_TOKEN
docker compose up -d
```

The service listens on `127.0.0.1:8787` by default (put it behind your HTTPS reverse proxy). Verify with:

```bash
curl -H "Authorization: Bearer admin_local_token" http://127.0.0.1:8787/_proxy/health
```

Pin a specific release with `image: al1ya/exa-reverse-proxy:0.1.1` if you do not want `latest`.

> **Admin console preview:** run `npm run demo:ui` locally and open `http://127.0.0.1:8787` to explore the built-in Web UI (keys, usage, logs, observability). Screenshots are welcome in `docs/screenshots/`.

## Features

* Pools multiple upstream Exa API keys behind one service.
* Authenticates downstream clients with proxy-owned tokens.
* Selects healthy keys with round-robin, weighted round-robin, least-recently-used, or adaptive weighted scheduling.
* Fails over on rate limits, transient upstream statuses, timeouts, and connection errors when retrying is safe.
* Tracks per-key usage, cooldowns, request logs, and resource affinity in SQLite.
* Serves a built-in Chinese admin console for key pool operations, usage, alerts, logs, and admin audit. Raw key reveal is policy-gated and audited. The console UI is split across HTML, CSS, and ES modules under `src/admin-ui/`, subscribes to SSE live refresh hints, and is served with a strict CSP.

## Quick Start

### Use The Docker Hub Image

See the **One-Line Deploy** section at the top — clone/fetch `docker-compose.yml`, drop your Exa keys in `exa_api_key.txt`, set tokens in `.env`, and `docker compose up -d`. The prebuilt `al1ya/exa-reverse-proxy:latest` image persists SQLite data in a Docker volume and binds `127.0.0.1:8787` for safer reverse-proxy deployments. Pin `image: al1ya/exa-reverse-proxy:0.1.1` if you want a fixed release instead of `latest`.

### Build Locally

1. Copy `.env.example` to `.env`.
2. Put real Exa keys in `exa_api_key.txt` or replace `EXA_KEYS` entries, then set proxy/admin tokens.
3. Start the service:

```bash
docker compose up --build -d
```

4. Check health:

```bash
curl -H "Authorization: Bearer admin_local_token" http://127.0.0.1:8787/_proxy/health
```

5. Call Exa through the proxy:

```bash
curl -X POST http://127.0.0.1:8787/search   -H "Authorization: Bearer client_local_token"   -H "Content-Type: application/json"   -d '{"query":"latest LLM research","numResults":3}'
```

## 本地控制台演示

不接真实 Exa Key 时，可以直接启动内置演示环境查看运维控制台：

```bash
npm run demo:ui
```

打开 `http://127.0.0.1:8787`，使用管理员令牌 `admin_local_token` 登录。管理员令牌来自 `EXA_ADMIN_TOKENS`，用于进入控制台和管理接口，不是 Exa API Key。脚本会自动灌入 6 把模拟密钥、成功请求、429 限流、503 临时错误、504 超时、冷却状态和 1 把禁用密钥，方便检查表格、右侧详情和请求日志。客户端令牌为 `client_local_token`。

## Configuration

See `.env.example` for the full environment contract. `EXA_KEYS` uses comma-separated `id:key:weight` entries, for example:

```dotenv
EXA_KEYS=exa_a:replace_with_exa_key_a:1,exa_b:replace_with_exa_key_b:2
EXA_PROXY_TOKENS=client_local_token
EXA_ADMIN_TOKENS=admin_local_token
EXA_ADMIN_HEALTHCHECK_TOKEN=admin_local_token
```

For large pools, use `EXA_KEYS_FILE` instead of a huge environment variable. The file can be one raw Exa key per line, or `id:key:weight` when you want stable key IDs across reorders. Lines like `EXA_API_KEY=...`, blank lines, duplicate keys, and `#` comments are handled safely. Docker Compose mounts local `exa_api_key.txt` read-only at `/run/secrets/exa_api_key.txt`.

```text
# exa_api_key.txt
stable_prod_a:replace_with_exa_key_a:2
stable_prod_b:replace_with_exa_key_b:1
replace_with_exa_key_without_custom_id
```

```dotenv
EXA_KEYS_FILE=/run/secrets/exa_api_key.txt
EXA_PROXY_TOKENS=client_local_token
EXA_ADMIN_TOKENS=admin_local_token
```

`EXA_ADMIN_TOKENS` is the console/admin API login token. It is separate from real Exa API keys and is never forwarded upstream. A successful console login creates a server-side admin session, so the browser does not need to keep sending the admin token after login.

Alert webhooks are disabled unless `EXA_ALERT_WEBHOOK_URL` is set. When enabled, active observability alerts are sent as sanitized JSON and deduplicated by `EXA_ALERT_WEBHOOK_COOLDOWN_SECONDS`; use `EXA_ALERT_WEBHOOK_BEARER_TOKEN` if the receiver expects a bearer token, `EXA_ALERT_WEBHOOK_HMAC_SECRET` for `x-exa-alert-signature`, and `EXA_ALERT_WEBHOOK_MAX_ATTEMPTS` / `EXA_ALERT_WEBHOOK_RETRY_BACKOFF_MS` for simple retry/backoff.

`EXA_SELECTION_STRATEGY=adaptive_weighted` enables adaptive key-pool routing. The scheduler starts from each key's configured weight, then raises or lowers runtime weight from observed success rate, recent latency, 429s, 5xx/transient failures, and timeouts. Existing `round_robin`, `weighted_round_robin`, and `least_recently_used` behavior remains available.

Raw Exa keys must never be committed. The proxy injects upstream keys as `x-api-key` and strips downstream `Authorization`, `x-api-key`, proxy auth, and hop-by-hop headers before forwarding. By default, the admin API does not bulk-return raw Exa keys. Raw key display can be enabled only with `EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY=true`; keep it disabled on VPS deployments unless there is a short maintenance need.

## Admin API

Admin endpoints require one value from `EXA_ADMIN_TOKENS`. `GET /` is the recommended built-in Web UI entry and asks for the admin token in the browser; `GET /_proxy/ui` remains a 兼容入口 for older bookmarks.

* `GET /` - built-in Web UI for keys, usage, and request logs.
* `GET /_proxy/ui` - compatibility alias for the built-in Web UI.
* `GET /_proxy/health` - service health and configured key count.
* `GET /_proxy/config-summary` - sanitized runtime configuration for the console.
* `POST /_proxy/session` - create a server-side admin session; failed attempts are rate-limited.
* `DELETE /_proxy/session` - revoke the current admin session.
* `GET /_proxy/keys` - key stats and scheduler state. By default `displayId` is the internal key ID and the response never returns a `value` field.
* `GET /_proxy/keys/:id/failures` - recent sanitized failure summary for one key.
* `GET /_proxy/logs?limit=100&path=/search&status=4xx` - filtered proxy request logs with key IDs only.
* `GET /_proxy/logs/trace/:requestId` - requestId trace across matching request log records.
* `GET /_proxy/logs/export` - export filtered request logs as CSV.
* `POST /_proxy/logs/prune` - prune request logs older than a cutoff or retention day count.
* `GET /_proxy/observability` - trend buckets, failure/429 spike detection, available-key alerts, log-retention summary, and alert webhook status.
* `POST /_proxy/alerts/webhook/test` - send a sanitized test alert to the configured webhook.
* `GET /_proxy/events` - authenticated SSE stream for console refresh hints.
* `GET /_proxy/audit?limit=50` - admin login and operation audit records.
* `GET /_proxy/audit/export` - export filtered admin audit records as CSV.
* `GET /_proxy/metrics` - Prometheus-style key counters plus healthy/cooldown key counts, active alerts, log-retention gauges, status groups, p95 latency, retry totals, low-cardinality error reasons, and cooldown reasons.
* `POST /_proxy/keys/batch` - batch enable, disable, reset, or test selected keys.
* `POST /_proxy/keys/:id/disable` - manually disable a key.
* `POST /_proxy/keys/:id/enable` - re-enable a key.
* `POST /_proxy/keys/:id/test` - test one upstream key with a health-check search.
* `POST /_proxy/keys/:id/secret` - reveal one raw key only when `EXA_ADMIN_ALLOW_RAW_KEY_DISPLAY=true`; every attempt is audited.
* `POST /_proxy/keys/:id/reset-circuit` - clear cooldown for a key.


## Security And Operations

For production deployments, set `EXA_ADMIN_REQUIRE_HTTPS=true` when the service is behind an HTTPS reverse proxy that forwards `x-forwarded-proto: https`. Use `docker-compose.yml` for the prebuilt Docker Hub image, or combine `docker-compose.yml` with `config/docker-compose.vps.yml` when building locally. Both compose paths bind port 8787 to localhost by default. Admin sessions expire after `EXA_ADMIN_SESSION_TTL_SECONDS`; repeated failed logins are locked using `EXA_ADMIN_LOCKOUT_MAX_FAILURES`, `EXA_ADMIN_LOCKOUT_WINDOW_SECONDS`, and `EXA_ADMIN_LOCKOUT_SECONDS`.

The console includes trend buckets, alert summaries, audit records, real runtime configuration, requestId trace, per-key recent failure reasons, log filtering/export, retention pruning and retention status, batch key actions, webhook status/testing, and a masked display toggle. Raw key reveal is policy-gated and audited. Request logs remain sanitized and store internal key IDs rather than raw Exa key values. The service prunes expired request logs on startup and then continues enforcing `EXA_LOG_RETENTION_DAYS` while it is running.

The admin UI serves HTML with `no-store`, injects hashed `?v=` asset URLs, returns long-lived immutable cache headers for versioned assets, and exposes `/_proxy/ui/asset-manifest.json` with SHA-256 hashes. Production builds generate the same manifest under `dist/src/admin-ui/`.

### SQLite Operations

The state database is a normal SQLite file with WAL enabled. For backup, stop the container or use SQLite's online backup tooling against `EXA_STATE_PATH`; copy the main database together with `-wal` and `-shm` files when the service is still running. For restore, stop the service, replace the database files as a set, then start the service and check `/_proxy/health`, `/_proxy/keys`, and `/_proxy/metrics`.

For Docker deployments, use the packaged backup helpers. `backup:docker` stops the compose service, archives `/data/exa-proxy.sqlite*`, and starts the service again. `restore:docker` requires `--yes` because it replaces the state files in the Docker volume.

```bash
npm run backup:docker
npm run restore:docker -- backups/exa-proxy-state-2026-06-14T00-00-00-000Z.tar.gz --yes
```

For long-running deployments, keep `EXA_LOG_RETENTION_DAYS` enabled, monitor WAL size next to the database file, and schedule periodic maintenance during a quiet window:

```bash
sqlite3 /data/exa-proxy.sqlite "PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA integrity_check;"
sqlite3 /data/exa-proxy.sqlite "PRAGMA index_list('request_logs'); PRAGMA index_list('admin_audit_logs');"
```

## Development

```bash
npm ci
npm run verify
npm run scan:secrets
npm run test:e2e
npm run dev
```

CI runs on Node.js 22.x, matching the Docker image. Local Node.js 22 or newer is supported; if `better-sqlite3` was compiled under a different Node version, run `npm rebuild better-sqlite3`.

For local development without Docker, provide environment variables matching `.env.example`; the default listen address is `0.0.0.0:8787`. Deployment notes are in `docs/DEPLOYMENT.md`.

## Notes

* Resource affinity is enabled by default so follow-up requests for created resources prefer the key that created them.
* Streaming responses such as `text/event-stream` pass through without JSON parsing.
* Request logs and metrics use internal key IDs and never include raw Exa key values. The authenticated admin console can reveal a single raw key only when the server-side policy allows it, and every reveal attempt is audited.
