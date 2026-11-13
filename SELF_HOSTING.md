# Self-hosting ClayScorer (Docker Compose)

ClayScorer runs as a single container: a small Node server that serves the app and stores
signed-in users' rounds in SQLite. Scoring works offline on each device as before; signing in
adds backup and sync across devices. Anyone who doesn't sign in keeps their rounds on their own
device only.

## Start

```bash
cp .env.example .env        # set ADMIN_PASSWORD; on Linux set PUID/PGID (see below)
mkdir -p data
docker compose up -d --build
```

Open `http://<host>:8080` (or the `HTTP_PORT` you set). Sign in from the cloud button on any
discipline page, or go to **Account & users** (`/users.html`) on the landing page.

The first admin is created from `ADMIN_USERNAME` / `ADMIN_PASSWORD` **only when the database has no
users**. After that, manage everyone from `/users.html`; changing the `.env` values does nothing.
You can remove `ADMIN_PASSWORD` from `.env` once you've signed in.

## Storage

- `./data` on the host is bind-mounted to `/data` in the container.
- The database is `./data/clayscorer.db` (plus `-wal` / `-shm` files while running).
- **Backup:** stop the stack (`docker compose stop`) and copy the `data` folder, or while running
  use `sqlite3 data/clayscorer.db ".backup 'backup.db'"`.
- The container runs as `PUID:PGID` (default `1000:1000`). That user must be able to write
  `./data`. On Linux: `mkdir -p data && sudo chown "$(id -u):$(id -g)" data`, then put the same
  `id -u` / `id -g` values in `.env`. Docker Desktop on macOS/Windows handles this for you.

## Users

`/users.html`:

- Everyone signed in can change their own password (this signs out their other devices).
- Admins can add users, change username / display name / role, reset passwords (signs that user
  out everywhere), and delete users. Deleting a user deletes their rounds on the server; copies
  already on their devices stay there.
- There must always be at least one admin, and you can't delete your own account.

Each user only sees their own rounds.

## HTTPS (needed for iPhone)

iPhones (and Android) only allow offline use and *Add to Home Screen* over HTTPS. Put a TLS
reverse proxy in front of the container and set `COOKIE_SECURE=true` in `.env`. Any of these work:

- **Caddy** (automatic Let's Encrypt certificates for a public domain):
  ```
  scores.example.com {
      reverse_proxy clayscorer:8080
  }
  ```
- **Traefik** or **Nginx Proxy Manager**, if you already run one.
- **Tailscale Serve** (`tailscale serve --bg 8080`) for private access from your own devices,
  with no public exposure. See https://tailscale.com/kb/1312/serve.

The server sets the cookie's `Secure` flag automatically when the proxy sends
`X-Forwarded-Proto: https`; `COOKIE_SECURE=true` forces it.

## Moving existing rounds

Each website address keeps its own saved data on a phone, so rounds saved on another address
(e.g. the old GitHub Pages site) don't appear automatically. Either:

- open the old site, **Download CSV** for each round, then **Import CSV** on the new one; or
- on a device that already has rounds *at the new address*, simply sign in: everything in its
  local history is uploaded to that account.

## Updating

```bash
git pull
docker compose up -d --build
```

The app's service worker picks up new versions when `CACHE_NAME` in `service_worker.js` changes.

## Configuration

| Variable          | Default  | Purpose |
|-------------------|----------|---------|
| `ADMIN_USERNAME`  | `admin`  | First admin's username (first start only) |
| `ADMIN_PASSWORD`  | —        | First admin's password (8+ characters, first start only) |
| `HTTP_PORT`       | `8080`   | Host port |
| `COOKIE_SECURE`   | `false`  | Force the `Secure` cookie flag (set `true` behind HTTPS) |
| `SESSION_DAYS`    | `30`     | How long a sign-in lasts |
| `PUID` / `PGID`   | `1000`   | User/group the container runs as (must own `./data`) |
