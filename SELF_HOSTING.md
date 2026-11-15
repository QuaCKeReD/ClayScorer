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

- **Caddy** (automatic Let's Encrypt certificates for a public domain), e.g. on your firewall:
  ```
  scores.example.com {
      reverse_proxy 192.168.1.50:8080   # the Docker host and HTTP_PORT
  }
  ```
- **Traefik** or **Nginx Proxy Manager**, if you already run one.
- **Tailscale Serve** (`tailscale serve --bg 8080`) for private access from your own devices,
  with no public exposure. See https://tailscale.com/kb/1312/serve.

Point the proxy at `http://<docker-host>:8080` (or your `HTTP_PORT`). Caddy forwards
`X-Forwarded-For` and `X-Forwarded-Proto` by default. In `.env`:

- `COOKIE_SECURE=true` — always mark the session cookie `Secure` (it is also set automatically
  whenever the proxy sends `X-Forwarded-Proto: https`).
- `TRUST_PROXY=true` — take the client IP for login throttling from `X-Forwarded-For`. Only
  enable it if clients can't bypass the proxy and reach port 8080 directly (firewall it to the
  proxy), otherwise they could forge that header.

## Weather

Round notes › Weather looks up weather from [Open-Meteo](https://open-meteo.com) directly from the
user's browser (no key, nothing for the server to configure). **Use my location** only works when
the app is served over https (or localhost); over plain http, users can still search for a place
or type the weather in.

## Scorecard photo import

**Import scorecard photos** (`import.html`) reads photos of paper scorecards and turns them into a round. The server sends the photos to the [Anthropic API](https://docs.anthropic.com/) (Claude) to be read, so it needs an API key:

1. Create a key in the [Anthropic Console](https://console.anthropic.com/settings/keys).
2. Add `ANTHROPIC_API_KEY=sk-ant-…` to `.env`.
3. Run `docker compose up -d --build`.

Without a key, the page says the feature isn't set up. Everything else works as before.

- **Who can use it.** Only signed-in users. Each user can do `SCORECARD_READS_PER_HOUR` reads an hour (default 30).
- **Cost.** Each read is billed to your Anthropic account by tokens, roughly a few pence for a few photos. See [pricing](https://www.anthropic.com/pricing).
- **Privacy.** Photos go to Anthropic to be read. ClayScorer doesn't store them.
- **Model.** The default is `claude-opus-5-5`; set `SCORECARD_MODEL` to change it. If that model is unavailable, the API may fall back to another Claude model automatically.
- **Testing.** `SCORECARD_READER_MOCK=1` returns made-up cards without calling the API.

## Moving existing rounds

**From the old Firebase cloud sync:** sign in to this server (Account & users), then open
`/migrate.html` on a computer, sign in with Google, check the list of rounds found and press
**Import into my account**. It copies every round you uploaded to Firebase into your account
here; nothing in Firebase changes, and re-running is safe (the newer copy of each round wins).
`localhost` is allowed for Google sign-in by default; if you run it from another address, add
that domain under Firebase › Authentication › Settings › Authorized domains first.

**From a device's local storage:**

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
| `TRUST_PROXY`     | `false`  | Use `X-Forwarded-For` for the client IP (behind a reverse proxy) |
| `PUID` / `PGID`   | `1000`   | User/group the container runs as (must own `./data`) |
| `ANTHROPIC_API_KEY` | —      | Enables scorecard photo import |
| `SCORECARD_READS_PER_HOUR` | `30` | Photo reads per user per hour |
| `SCORECARD_MODEL` | `claude-opus-5-5` | Claude model used to read scorecards |
