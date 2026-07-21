# Echo

[Р СѓСЃСЃРєР°СЏ РІРµСЂСЃРёСЏ](README.ru.md)

Echo is a temporary registration-free chat. Rooms, messages, PIN hashes, sessions and temporary counters live only in server memory and disappear after a restart or room deletion.

```text
             HTTPS / WSS
Browser в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв–є Nginx в”Ђв”Ђв”Ђв”Ђв”Ђв–є Echo (Express + Socket.IO)
  в”‚                            в”‚                    в”‚
  в”‚  sessionStorage:           в”‚                    в”њв”Ђ rooms (memory)
  в”‚  short-lived token         в”‚                    в”њв”Ђ messages (memory)
  в””в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”ґв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”ґв”Ђ PIN hashes (bcrypt)

No accounts В· No database В· No permanent message history
```

## What Echo protects

| Area | Implementation |
| --- | --- |
| Room PIN | 4вЂ“8 digits, `bcrypt` hash only; never included in a URL or storage |
| Sessions | Random, room-bound, short-lived token stored only in `sessionStorage` |
| XSS | Client data is rendered with `textContent`; Helmet CSP blocks injected scripts |
| Socket.IO | Strict origin check, packet-size limit, server-owned room membership and roles |
| Abuse | PIN, connection, room-creation, join, typing and message rate limits |
| Deletion | Empty rooms, inactive rooms and closed rooms erase their in-memory data |

## Production structure

```text
mini-chat/
в”њв”Ђв”Ђ .env.example
в”њв”Ђв”Ђ .gitignore
в”њв”Ђв”Ђ package.json
в”њв”Ђв”Ђ server.js
в”њв”Ђв”Ђ public/
в”њв”Ђв”Ђ src/
в”њв”Ђв”Ђ test/
в”њв”Ђв”Ђ vitest.config.js
в””в”Ђв”Ђ deploy/
    в”њв”Ђв”Ђ mini-chat.service
    в”њв”Ђв”Ђ mini-chat-hardening.conf
    в””в”Ђв”Ђ nginx/
        в””в”Ђв”Ђ echo.erised.click.conf
```

`.env` is intentionally listed in `.gitignore`. Do not commit it, copy it into a public archive, or put secrets in it. The current app has no persistent secret; it does contain the exact public URL and operating limits.

## Environment

Copy `.env.example` to `.env` and set the real public address. `CLIENT_ORIGIN` must be the exact browser origin (scheme + domain, no trailing slash). Wildcards are deliberately unsupported.

```dotenv
NODE_ENV=production
PORT=3000
PUBLIC_URL=https://echo.example.com
CLIENT_ORIGIN=https://echo.example.com
MAX_SOCKET_PACKET_BYTES=10240
MAX_ROOM_PARTICIPANTS=20
MAX_MESSAGE_LENGTH=2000
ROOM_TTL_MINUTES=360
EMPTY_ROOM_TTL_MINUTES=10
ROOM_CLEANUP_INTERVAL_MINUTES=5
PIN_ATTEMPT_LIMIT=5
PIN_BLOCK_MINUTES=5
```

`MAX_SOCKET_PACKET_BYTES` limits each Socket.IO payload at the transport layer. The application also validates names, room limits, PIN format and message text. The hard upper bounds for participants and messages are 50 and 2,000 respectively, even if an environment value is accidentally higher.

## Installation on Ubuntu/Debian

Install Node.js LTS from a trusted source, Nginx and Certbot. Run the application as an unprivileged service account; Nginx is the only public-facing process.

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /opt/mini-chat
sudo chown -R "$USER":"$USER" /opt/mini-chat
# Upload or clone this project into /opt/mini-chat.
cd /opt/mini-chat
cp .env.example .env
npm install --omit=dev
sudo chown -R www-data:www-data /opt/mini-chat
```

Set `PUBLIC_URL` and `CLIENT_ORIGIN` in `/opt/mini-chat/.env` to the real HTTPS URL. Keep `PORT` bound only to loopback through the service configuration. For development and tests, use `npm install` followed by `npm test`.

## systemd service

The project supplies [deploy/mini-chat.service](deploy/mini-chat.service). Install it and start it:

```bash
sudo install -m 0644 deploy/mini-chat.service /etc/systemd/system/mini-chat.service
sudo systemctl daemon-reload
sudo systemctl enable --now mini-chat
sudo systemctl status mini-chat
curl -fsS http://127.0.0.1:3000/healthz
```

The process handles `SIGTERM` and `SIGINT`: it stops the cleanup interval, informs connected sockets that the room is closed, closes Socket.IO and then stops the HTTP server. `systemd` waits up to ten seconds before escalating.

`deploy/mini-chat-hardening.conf` is retained for an existing unit that uses a drop-in. Do not install it in addition to the supplied full unit, because the full unit already includes the same sandboxing options.

## Nginx reverse proxy and WebSocket

Copy [deploy/nginx/echo.erised.click.conf](deploy/nginx/echo.erised.click.conf) to `/etc/nginx/sites-available/echo.erised.click`, change the domain and upstream port if needed, then enable it:

```bash
sudo ln -s /etc/nginx/sites-available/echo.erised.click /etc/nginx/sites-enabled/echo.erised.click
sudo nginx -t
sudo systemctl reload nginx
```

The `map` shown in the comment at the beginning of the configuration must be added once inside Nginx's `http {}` block. The `/socket.io/` location uses HTTP/1.1, forwards `Upgrade` and `Connection`, disables buffering, and has longer proxy timeouts. The proxy passes the client IP headers used by the server's IP-based limits. Keep the upstream as `127.0.0.1:PORT`; do not expose the Node port publicly.

## TLS certificate

Before requesting a certificate, create an `A`/`AAAA` DNS record for the domain and make ports 80 and 443 reachable. Use the HTTP server block first, then run:

```bash
sudo certbot --nginx -d echo.erised.click
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

Certbot updates the TLS paths in the Nginx site file. The included HTTPS block shows the resulting paths and enables HSTS. Enable HSTS only after HTTPS works reliably for the final domain and its intended subdomains.

## Safe operation and logs

Helmet adds browser security headers and CSP. Socket handshakes are accepted only from `CLIENT_ORIGIN`; requests without an allowed `Origin` are rejected. Nginx terminates TLS, while Node remains on loopback.

Application logs contain event names, socket IDs, client IPs and non-sensitive technical error names only. They must never contain PINs, session tokens, message text, full event payloads or room PIN hashes. Inspect service logs with:

```bash
sudo journalctl -u mini-chat -f
```

## Updating the application

Back up `.env` outside the release directory or leave it in place. Deployment restarts the service, so all temporary rooms and messages are intentionally lost.

```bash
sudo systemctl stop mini-chat
cd /opt/mini-chat
# Replace application files, preserving .env.
npm install --omit=dev
sudo chown -R www-data:www-data /opt/mini-chat
sudo systemctl daemon-reload
sudo systemctl start mini-chat
curl -fsS http://127.0.0.1:3000/healthz
sudo nginx -t && sudo systemctl reload nginx
```

For a release with test dependencies, first run `npm install && npm test`, then run `npm prune --omit=dev` before starting the production service. When a committed lock file is introduced, replace `npm install` with `npm ci` in these commands.

## Post-publication checks

```bash
curl -fsS https://echo.erised.click/healthz
curl -I http://echo.erised.click
curl -i -H 'Origin: https://echo.erised.click' \
  'https://echo.erised.click/socket.io/?EIO=4&transport=polling'
```

The first command returns `{"status":"ok"}`, the second redirects to HTTPS, and the third returns a Socket.IO handshake plus the exact `Access-Control-Allow-Origin` value. Finally open two browser windows, create a room in one, join it from the other and verify a `wss://.../socket.io/` connection in browser Developer Tools (Network в†’ WS). This confirms an actual upgraded WebSocket, not only HTTP polling.

## Production checklist

- [ ] DNS points to the server; only ports 80 and 443 are public.
- [ ] `.env` is present with `NODE_ENV=production`, exact HTTPS `PUBLIC_URL` and exact `CLIENT_ORIGIN`; it is not committed.
- [ ] Node listens only on `127.0.0.1:PORT`; Nginx upstream uses that same port.
- [ ] Nginx configuration passes `nginx -t`, redirects HTTP to HTTPS and proxies `/socket.io/` with WebSocket headers.
- [ ] A valid certificate is installed and `certbot renew --dry-run` succeeds.
- [ ] `mini-chat` is enabled, healthy after reboot and runs as `www-data`.
- [ ] `/healthz` works locally and through the HTTPS domain.
- [ ] Browser tests confirm room creation, joining and `wss` transport.
- [ ] `npm test` passes before deployment; production dependencies are installed without dev dependencies.
- [ ] Logs and monitoring do not capture PINs, tokens, message content or full socket payloads.
- [ ] Backups and deployment expectations explicitly account for temporary in-memory rooms being lost on a restart.
