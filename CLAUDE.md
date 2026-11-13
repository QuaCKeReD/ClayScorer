# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ClayScorer Pro — a static, offline-capable Progressive Web App for scoring CPSA clay pigeon shooting rounds across four disciplines: English Sporting (ESP), Sportrap (STR), Compak Sporting (CSP), and English Skeet (ESK). No build system, no package manager, no tests. Deployed as a Docker Compose stack: one dependency-free Node server (`server/server.js`) serves the static app and stores signed-in users' rounds in SQLite. See `SELF_HOSTING.md`.

## Running / developing

- Open `index.html` directly in a browser, or serve the directory (`python3 -m http.server`) for service-worker + PWA install testing (SW requires http://localhost, not `file://`). With a plain static server the app runs local-only (sync panel says server sync isn't available).
- Full stack locally: `PORT=8080 DATA_DIR=./data ADMIN_USERNAME=admin ADMIN_PASSWORD=… node server/server.js` (Node 24+, uses built-in `node:sqlite`), or `docker compose up -d --build`.
- No install / build / lint / test commands exist. There is no CI.
- Third-party browser libs are vendored under `assets/vendor/` so the app shell is deterministic and installable offline after first load:
  - Tailwind (`assets/vendor/tailwindcss-3.4.17.js`) — utility CSS
  - Lucide (`assets/vendor/lucide-0.468.0.min.js`) — icons, initialised via `lucide.createIcons()` after every `render()`
  - html2canvas (`assets/vendor/html2canvas-1.4.1.min.js`) — used only by `shareAsImage()`
- **Server sync** (`assets/server-sync.js`, loaded by each discipline page) is offline-first: rounds always save to `localStorage`; when a user is signed in, round history mirrors to the server. It listens for the scorer's `clayscorer:history-written` event (fired by `writeHistory()`), debounces, and diffs history against `${storageKey}:synced` (`{ roundKey: updatedAt }` last agreed with the server) to push upserts and deletes — so renames, deletes and delete-all need no extra hooks. It pulls on open, sign-in, `online`, and when the page becomes visible again. Conflicts resolve by newest `_updatedAt`; server deletes are tombstones (`rounds.deleted = 1`). Because of this, `syncHistory()` only re-stamps `_updatedAt` when round content actually changed, and `makeDefaultState()` returns an already-normalised state — don't break either or reopening a round will look like an edit and override other devices.
- **Server API** (`server/server.js`): `/api/login`, `/api/logout`, `/api/me`, `/api/me/password`, `/api/rounds/:discipline[/:roundKey]` (GET list incl. tombstones, PUT upsert-if-newer, DELETE tombstone), `/api/users[/:id]` (admin). Mutating requests must send `X-ClayScorer: 1` (CSRF guard). Sessions are random tokens stored as SHA-256 in `sessions`, sent as an HttpOnly `cs_session` cookie. Passwords are scrypt. The first admin comes from `ADMIN_USERNAME`/`ADMIN_PASSWORD` when the users table is empty. Static serving blocks `server/`, `data/`, `_archive/`, dotfiles and unknown extensions.
- `users.html` + `assets/users.js` — account page (change own password) and admin user management (add, edit username/display name/role/password, delete; server enforces last-admin and no-self-delete).
- **When you change what's cached, bump `CACHE_NAME` in `service_worker.js`** (currently `clayscorer-v14`) so installed PWAs pick up the new bundle instead of serving stale cache. The `activate` handler deletes old cache names. `scorer.js` also logs a `SCORER_BUILD` banner on load — bumping that string when you ship changes gives you a quick DevTools signal that the page is running the new code (not a stale SW-cached copy).
- The SW pre-caches same-origin files with `cache.addAll`. If you add new app shell assets, put them in `LOCAL_ASSETS`.

## Architecture

Multi-page static PWA. The landing page (`index.html`) shows discipline tiles; each discipline is its own named page (`sporting.html`, `sportrap.html`, `compak.html`, `skeet.html`) that can be opened directly. All discipline pages are thin shells that set a `window.DISCIPLINE` config object and load a shared engine (`assets/scorer.js` + `assets/scorer.css`), so scoring/leaderboard/export logic lives in exactly one place.

### Discipline config (`window.DISCIPLINE`)

Each discipline HTML declares its config inline. Shape:

```js
{
  id, name, code,                     // 'sporting', 'English Sporting', 'ESP'
  storageKey,                         // per-discipline localStorage key — DO NOT collide across pages
  standLabel,                         // 'Stand' (ESP/STR/CSP) or 'Station' (ESK)
  maxShooters, showFirstUpRotation,   // ESK sets rotation false — single shooter shoots the whole round
  scrollScoreRows,                    // default true: on phones (<640px) H/M stacks scroll sideways, ~3 pairs in view; ESK + STR set false
  editable: { standCount, targetsPerStand, extraClay },   // ESP true; STR/CSP/ESK all false
  defaults: { standCount, targetsPerStand },              // only when standCount editable
  targetOptions: [4, 6, 8, 10],                           // pair-count buttons for ESP
  fixedStands: [{ id, targets, labels? }] | null          // null for variable ESP; array for fixed disciplines
}
```

Notable per-discipline choices:
- **ESP** uses `fixedStands: null` + `defaults/targetOptions`, so setup lets the user pick stand count (1–20, default 10) and per-stand pair count (2–6 pairs, default 3) plus toggle a +1 extra clay per stand.
- **STR / CSP** hard-code 5 stands × 5 targets = 25.
- **ESK** hard-codes 7 stations × the standard 25-target CPSA sequence with per-target `labels` (`H`, `L`, `H+L`, `L+H`) that the engine renders under each score button.

### State model (`state` in `assets/scorer.js`)

One `state` object per page — populated from `localStorage[D.storageKey]` on load. Every mutating action still follows the original pattern: mutate `state` → call `render()` → call `save()`.

```
state = {
  ground, date, event, notes,
  shooters: [{ id, name, cpsa, class }],
  stands:   [{ id, targets, extraClay, description, labels? }],
  hits:     { [shooterId]: { [standId]: [true|false|null, ...] } },
  activeIdx,
  isLocked,
  _roundKey            // last computed round key (used to detect renames)
}
```

- Total targets on a stand = `standTargets(stand) = stand.targets + (stand.extraClay ? 1 : 0)`. Use this helper everywhere; a raw `stand.targets` will miss the ESP extra clay.
- `stand.description` is a free-text presentation note (e.g. "left-to-right crosser + rabbit") — edited via the "Presentation" input under the active stand's title, persisted per-round through history, echoed into CSV exports as a `Descriptions` line (only emitted when at least one stand has one) and rendered as italic subtext under each stand-column header in the PDF/PNG grid. `parseCSV` reads the `Descriptions` line positionally against `Stands` and attaches it to the imported stands.
- `stand.clayMeta` is a per-clay array (`presentation`, `direction[]`, `starting`, `travelling`, `claySize`, `clayFace`, `clayVisibility`, `colour`) edited in the clay presentation dialog (`renderClayMetaControls`, fields in `CLAY_META_FIELDS`). An untouched clay (all fields empty) shows `CLAY_META_DEFAULTS` pre-selected and stores them on its first edit, so existing rounds aren't rewritten. Direction is two exclusive groups (L→R / R→L and Away / Towards); one from each reads as quartering. `clayMetaDescription()` turns it into natural-language text ("Crosser quartering away left to right, starting low and rising. Orange standard clay showing its full belly.") for the dialog summary (wraps to show it all) and the PDF/PNG stand headers; the dialog itself is a centred modal with a backdrop; CSV keeps the raw JSON (`Clay Metadata` line). Legacy `Batue` is read as `Battue`.
- `hits[shId][stId]` is an array sized to `standTargets`. When targets change (setBirds, setExtraClay), `ensureHitsArray()` resizes preserving existing values.
- The outer `history` variable (in `scorer.js`) is a one-level **undo snapshot** of `state.hits`, cleared on each hit toggle — one-step by design. Not to be confused with the persisted round-history dict below (which is only ever read/written via `readHistory()` / `writeHistory()`).

### Round history

Every discipline keeps a per-page history dict at `localStorage[${D.storageKey}:history]`, shape `{ [roundKey]: fullState }`. It's driven by `syncHistory()` inside `save()`:

- `roundKey(state) = ${ground.trim().toLowerCase()}|${date}|${event.trim().toLowerCase()}` — trimming + lowercasing so typos and casing don't fork the same shoot. `date` is the ISO date the input holds.
- A round is **named** when either ground or event is non-empty. Only named rounds are written to history.
- On save: if `state._roundKey` is set, differs from the new key, and the new state is still named, the old entry is deleted (rename). Then the current state is written to `history[newKey]` with `_updatedAt = Date.now()`. Finally `state._roundKey` is updated to the new key (or `null` if now unnamed). Un-naming a previously named round keeps the old entry as an archive rather than deleting it.
- `state._roundKey` lives inside `state`, so it survives reload and the rename detection continues across sessions.

Actions exposed on `window`:
- `newRound()` — snapshot current, reset to defaults, save.
- `loadRound(key)` — snapshot current, replace state from `history[key]`, save under the same key.
- `deleteRound(key)` — remove the entry; if it was the active round, reset to defaults.
- `resetAll()` — **destructive**: removes both `${storageKey}` and `${storageKey}:history`. Used by the leaderboard's Reset button; `newRound()` is the everyday equivalent that keeps history.

UI: `renderHistory()` populates `#history-section` (between setup and squad), sorted by shoot date desc then `_updatedAt` desc. Rows use `data-history-action` / `data-history-key` and a single click delegate attached once in DOMContentLoaded — safe against innerHTML rewrites.

### Save paths and when history is written

Two persistence entry points, both defined in `scorer.js`:
- `saveStateOnly()` — writes only `${storageKey}` (the live snapshot). No history rename.
- `save()` — calls `syncHistory()` first (rename + write into `${storageKey}:history` if named), then `saveStateOnly()`.

Ground/event `oninput` (per-keystroke) routes through `updateField` → `saveStateOnly()`. This avoids a rename per keystroke while typing "West Wycombe" (which would otherwise produce and delete 12 history keys). Ground/event/date `onchange` (blur / date-picker commit) routes through `commitField` → `save()`, which is the deliberate history write. Other mutations — hit toggle, shooter add/remove, birds, extra clay, nav, notes typing, lock — all still go through `save()`, so history stays in sync with gameplay data as it changes.

On DOMContentLoaded, after `load()`, we call `save()` if the restored state is named. This backfills the history dict for a state that was last edited under the old always-write behaviour but whose history entry may not exist yet.

### Render loop

`render()` is a full re-render of dynamic sections (squad, stand nav, scoring area, leaderboard) from `state`. Static inputs (ground, date, event, notes, stand-count select) are mounted **once** by `mountSkeleton()` and only have their `.value` set inside `render()` — this preserves focus while the user types (`oninput` handlers don't trigger render; `onchange` fires on blur).

Page layout (top to bottom): header (history / cloud / export / lock), collapsible **Round setup** `<details id="setup-panel">` (fields, squad, and for STR/CSP the Stand setup), sticky stand nav (`top: var(--header-h)`, kept in sync by a `ResizeObserver` on the header; each button shows a partial/done marker from `standProgress()`), option-target status (ESK), STR/CSP Presentations panel, lock banner, scoring card, leaderboard + legend, notes, and a fixed bottom Prev/Next bar. `render()` auto-collapses setup (and the Presentations panel) the first time any target is recorded and re-opens it for a fresh round, tracked by `lastAnyShot`; otherwise the user's own open/close choice is left alone. Locking shows `#lock-banner`, dims only the scoring area, and disables Prev/Next.

Non-blocking outcomes (import errors/results) use `notify(message, tone)` → `#toast`; `confirm()` is kept for destructive actions (delete round/history, remove a shooter who has scores, overwrite on import).

### Scoring UI conventions

- Targets are grouped by how they're thrown via `shotGroups(stand, formatMap)`: each group is one `.pair-stack` with its H/M buttons side by side. ESP pairs consecutive targets (captioned `Pair N`) and leaves the +1 extra clay single; labelled stands (ESK) pair the doubles (`H+L` / `L+H` / `H/L`) and keep `H` / `L` single; STR/CSP follow the per-stand format map (`single` / `report` / `sim`). Stacks `flex-wrap` on narrow screens.
- Extra-clay pair-stacks get `.pair-extra` for the orange tint.
- **Phone score strips** (`scrollScoreRows`, ESP + CSP): each shooter's stacks sit in a `.score-strip` that scrolls sideways under 640px, sized so three pairs fill the row (CSS uses the per-stack `--shots` var). `positionScoreStrips()` keeps each strip's scroll across `render()`, opens a new stand on the shooter's first unfinished group, and smooth-scrolls the next group into view when a tap completes one; `fade-left` / `fade-right` mask the edges that have more to scroll.
- **First up vs Shooting**: with rotation (ESP), the "First up" shooter is `state.shooters[state.activeIdx % n]` and the scoring area rotates order so they're at the top (neutral outlined pill). Separately, the orange pulse + "Shooting" pill marks the first shooter in order who hasn't completed the stand; no one is highlighted once the whole squad is done. ESK/STR/CSP don't rotate.
- **Hits tri-state**: `true` = hit, `false` = miss, `null` = not shot. Tapping the same button again clears it back to `null`. Unselected H/M buttons are tinted (`.score-btn-hit` / `.score-btn-miss`); build them with `scoreBtnClass()`.
- **Shared class strings**: `LABEL`, `FIELD`, `CARD`, `SECTION_HEAD`, `BTN_SCORE`, `BTN_SMALL`, `MENU_ITEM` near the top of `scorer.js`. Use them (and keep text ≥ 11px) rather than inventing new tiny arbitrary sizes — the app is used outdoors on phones.
- **Escape user text**: shooter names, ground, event go through `escapeHtml()` whenever interpolated into HTML (including `value="…"`).
- **Target labels** (`stand.labels`) — only ESK sets these currently; the engine renders them as a caption row beneath each pair. Any discipline can opt in.

### Export paths

Three export flows share `generateExportGrid(tid)`, which uses `standTargets()` for column counts (so extra clays get their own pair column, headed e.g. `STA 3+1`):
- `exportToPDF()` — fills `#p-grid` inside `#print-view`, then `window.print()`. Print styles in `assets/scorer.css` (`@media print`) do the visual work. `document.title` is temporarily set to `filenameStem()` so the print dialog's default filename matches the CSV/PNG stem; an `afterprint` listener restores the original title.
- `shareAsImage()` — off-screen `#capture-container` (via `position: absolute; left: -9999px`), briefly moved to `position: fixed; left:0; z-index:-1` for html2canvas measurement, then `navigator.share({ files })` on mobile or falls back to download. Preserve the position dance if you touch it.
- `downloadCSV()` — header block `Discipline / Date / Ground / Event / Stands` (Date as `YYYYMMDD`, `Stands` is a comma-separated list of `targets[+1]` specs), then a per-stand columns + totals block, then a `Details` block (`Shooter,Stand,Shots`) whose shot strings use `H` = hit, `M` = miss, `.` = not shot. The `Stands` line + `Details` block make CSVs fully round-trippable through `importCSV`.

Every export shares the same filename stem — `YYYYMMDD_${D.id}[_ground-slug][_event-slug]` — built by `filenameStem()`. Empty parts are skipped, so an unnamed round yields `YYYYMMDD_${D.id}`. Ground and event are lowercased and non-alphanumerics collapse to single dashes. The PDF/PNG header blocks show ground + date (yyyymmdd) + discipline unconditionally and an italic EVENT row directly below (`#p-event-row` / `#cap-event-row`) that stays hidden unless `state.event` is set.

### CSV import

`parseCSV(text)` returns `{ meta, stands, shooters, totals, details }` and accepts both the current export and legacy exports (no `Stands` line, no `Details` block). Missing `Stands` falls back to `D.defaults.targetsPerStand` for ESP or `D.fixedStands[i].targets` for the fixed disciplines. Missing `Details` reconstructs hits as `hitCount` `true`s followed by the remaining `false`s so per-stand totals still line up in the leaderboard. `csvEscape` / `csvParseLine` handle RFC-4180 quoting, so commas in ground/event/shooter names round-trip. `parseDateField` accepts YYYYMMDD, YYMMDD, or ISO.

`window.importCSV(file)` reads the file, refuses cross-discipline imports (aborts if the CSV's `Discipline` doesn't match `D.name` / `D.code`) and refuses stand-structure mismatches on fixed disciplines (STR/CSP/ESK), then writes the reconstructed state into `history[roundKey]` and offers to load it as the current round. Round must be named (ground or event) to have an identity — unnamed imports are refused. UI: a hidden `<input type="file">` sits inside an "Import CSV" `<label>` in the history section header; `handleImportChange(input)` resets the input value (so re-importing the same file works) and routes to `importCSV`.

## Files

- `index.html` — landing page with 4 discipline tiles. Each tile carries `data-storage-key` and shows a "Continue: …" line when that discipline's live round has scores.
- `sporting.html`, `sportrap.html`, `compak.html`, `skeet.html` — thin per-discipline shells that set `window.DISCIPLINE` and load the shared engine.
- `assets/scorer.js` — shared scoring engine (state, mount, render, exports). All global `window.*` handlers used by inline `onclick`s are defined here.
- `assets/scorer.css` — shared styles including print media, capture container, pair-stack, first-up glow, and discipline tiles.
- `assets/server-sync.js` — sign-in panel (`#cloud-sync-panel`) and round sync. The scorer exposes a narrow `window.ClayScorerCloud` bridge (`getDiscipline`, `getCurrentState`, `getHistory`, `replaceHistory`, `refreshCurrentRoundFromHistory`, `saveCurrent`; sync adds `isSignedIn`); keep server-specific code out of the core scorer.
- `users.html`, `assets/users.js` — account & user management page.
- `migrate.html`, `assets/firebase-migrate.js`, `assets/firebase-config.js` — one-off import of a user's rounds from the old Firebase sync (Firestore `clayScorerUsers/{uid}/rounds`) into their server account. Removable once everyone has migrated (also drop `migrate.html` from the `Dockerfile` COPY line).
- `server/server.js` — Node HTTP server: static files + JSON API + SQLite (`DATA_DIR/clayscorer.db`).
- `Dockerfile`, `docker-compose.yml`, `.env.example`, `.dockerignore` — container build and stack; `./data` is bind-mounted to `/data`. `SELF_HOSTING.md` has deployment notes.
- `service_worker.js` — service worker: cache-first for the listed assets, network fallback for everything else. On activate, deletes any cache whose name isn't the current `CACHE_NAME`.
- `manifest.json` — PWA install metadata. `start_url` is the landing page.
- `_archive/indexv1.html`, `_archive/indexv2.html`, `_archive/indexv3.html` — historical snapshots of the original sporting-only single-file app. Not linked from anywhere; ignore unless the user explicitly refers to them.

## Adding a new discipline

1. Create `<id>.html` mirroring an existing discipline shell.
2. Set `window.DISCIPLINE` with a unique `id`, `code`, and `storageKey` (mirroring an existing one will overwrite its data).
3. Add a tile to `index.html`.
4. Add the page path to the `LOCAL_ASSETS` list in `service_worker.js` and bump `CACHE_NAME`.
5. Add the page to the `COPY` line in `Dockerfile`, and the discipline `id` to `DISCIPLINES` in `server/server.js` (the API rejects unknown disciplines).

If the new discipline needs behaviour the shared engine doesn't yet support (e.g. a new scoring shape), extend `assets/scorer.js` gated by a new config flag rather than forking the engine.

## Future cleanup

Deferred tasks — not urgent, do them only when asked.

- **Remove the Firebase import tool** (the Firebase → server migration was completed 2026-11-13):
  - Delete `migrate.html`, `assets/firebase-migrate.js`, `assets/firebase-config.js`.
  - Drop `migrate.html` from the `COPY` line in `Dockerfile`, then rebuild (`docker compose up -d --build`).
  - Remove the "From the old Firebase cloud sync" paragraph under *Moving existing rounds* in `SELF_HOSTING.md`, and the `migrate.html` entry under *Files* above.
  - Outside the repo: in the Firebase console (Authentication › Settings › Authorized domains), remove any domain added just for the migration.
  - Don't confuse this with `migrateFromStandId` / `migrateFromIndex` in `skeet.html` / `scorer.js` — that's the ESK option-target handling and must stay.
