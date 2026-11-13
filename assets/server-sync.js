/* Server sync for the self-hosted (Docker) build.
 *
 * Rounds always save to this device first (offline-first). When a user is signed in, round
 * history is mirrored to the server's SQLite store: changes push automatically a moment after
 * they happen, and the server copy is pulled on open, sign-in, reconnect and when the page
 * comes back into view. Newest `_updatedAt` wins; deletes are sent as tombstones.
 *
 * Talks to the scorer only through `window.ClayScorerCloud` and the
 * `clayscorer:history-written` event. Does nothing when no server API is present
 * (e.g. opened from file:// or a plain static server).
 */
(function () {
    'use strict';

    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    const bridge = window.ClayScorerCloud;
    if (!bridge) return;

    const discipline = bridge.getDiscipline();
    // { roundKey: updatedAt } — the version of each round this device last agreed with the server.
    // A key here that's missing from local history means "deleted on this device, tell the server".
    const SYNCED_KEY = `${discipline.storageKey}:synced`;
    const PUSH_DELAY_MS = 1500;
    const REFRESH_AFTER_MS = 30 * 1000;
    const MUTATE_HEADERS = { 'Content-Type': 'application/json', 'X-ClayScorer': '1' };

    let available = false;
    let user = null;
    let syncing = false;
    let rerun = false;
    let applyingRemote = false;
    let pushTimer = null;
    let lastSyncedAt = 0;
    let lastError = '';
    let ui = {};

    const readSynced = () => { try { return JSON.parse(localStorage.getItem(SYNCED_KEY) || '{}'); } catch (e) { return {}; } };
    const writeSynced = (m) => { try { localStorage.setItem(SYNCED_KEY, JSON.stringify(m)); } catch (e) {} };
    const roundPath = (key) => `/api/rounds/${discipline.id}/${encodeURIComponent(key)}`;
    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    async function api(method, path, body) {
        const res = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: method === 'GET' ? {} : MUTATE_HEADERS,
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok || !data) {
            const err = new Error(data?.error || `Server error (${res.status})`);
            err.status = res.status;
            throw err;
        }
        return data;
    }

    // ---------- Sync ----------

    async function pull() {
        const { rounds } = await api('GET', `/api/rounds/${discipline.id}`);
        const local = bridge.getHistory();
        const synced = readSynced();
        const currentKey = bridge.getCurrentState()._roundKey;
        let changed = false;
        let currentChanged = false;

        for (const r of rounds) {
            const mine = local[r.roundKey];
            const localUpdated = mine?._updatedAt || 0;
            if (r.deleted) {
                if (mine && localUpdated <= r.updatedAt) {
                    delete local[r.roundKey];
                    changed = true;
                    if (r.roundKey === currentKey) currentChanged = true;
                }
                if (!mine || localUpdated <= r.updatedAt) delete synced[r.roundKey];
                continue;
            }
            if (!mine) {
                // Deleted on this device since the last sync, and nobody has changed it since: keep it deleted.
                if (synced[r.roundKey] !== undefined && synced[r.roundKey] >= r.updatedAt) continue;
                local[r.roundKey] = r.state;
                synced[r.roundKey] = r.updatedAt;
                changed = true;
            } else if (r.updatedAt > localUpdated) {
                local[r.roundKey] = r.state;
                synced[r.roundKey] = r.updatedAt;
                changed = true;
                if (r.roundKey === currentKey) currentChanged = true;
            } else if (r.updatedAt === localUpdated) {
                synced[r.roundKey] = r.updatedAt;
            }
        }

        writeSynced(synced);
        if (changed) {
            applyingRemote = true;
            try { bridge.replaceHistory(local); } finally { applyingRemote = false; }
            if (currentChanged) bridge.refreshCurrentRoundFromHistory();
        }
    }

    async function push() {
        const local = bridge.getHistory();
        const synced = readSynced();
        let serverHadNewer = false;

        for (const key of Object.keys(synced)) {
            if (local[key]) continue;
            await api('DELETE', `${roundPath(key)}?deletedAt=${Date.now()}`);
            delete synced[key];
            writeSynced(synced);
        }
        for (const [key, round] of Object.entries(local)) {
            const updatedAt = round._updatedAt || 0;
            if (synced[key] !== undefined && synced[key] >= updatedAt) continue;
            const result = await api('PUT', roundPath(key), { state: round, updatedAt });
            if (result.applied) synced[key] = updatedAt;
            else serverHadNewer = true;
            writeSynced(synced);
        }
        if (serverHadNewer) await pull();
    }

    async function syncNow({ pullFirst = true } = {}) {
        if (!user) return;
        if (!navigator.onLine) { renderPanel(); return; }
        if (syncing) { rerun = true; return; }
        syncing = true;
        renderPanel();
        try {
            if (pullFirst) await pull();
            await push();
            lastSyncedAt = Date.now();
            lastError = '';
        } catch (err) {
            console.warn('[ClayScorer] Sync failed', err);
            if (err.status === 401) {
                user = null;
                lastError = 'Your session has ended. Sign in again to keep syncing.';
            } else {
                lastError = navigator.onLine ? err.message : '';
            }
        } finally {
            syncing = false;
            renderPanel();
            if (rerun) { rerun = false; syncNow(); }
        }
    }

    function schedulePush() {
        if (!user || applyingRemote) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => syncNow({ pullFirst: false }), PUSH_DELAY_MS);
    }

    // ---------- Account ----------

    async function signIn(username, password) {
        const { user: signedIn } = await api('POST', '/api/login', { username, password });
        user = signedIn;
        lastError = '';
        renderPanel();
        await syncNow();
    }

    async function signOut() {
        try { await api('POST', '/api/logout', {}); } catch (e) {}
        user = null;
        // Rounds stay on this device; forget sync bookkeeping so the next account starts clean.
        localStorage.removeItem(SYNCED_KEY);
        lastSyncedAt = 0;
        lastError = '';
        renderPanel();
    }

    // ---------- UI ----------

    const BTN = 'text-xs font-bold px-3 py-2 rounded-lg border inline-flex items-center justify-center gap-1';
    const INPUT = 'block w-full h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold';

    function setBadge(label, tone) {
        const badge = document.getElementById('cloud-status-badge');
        if (!badge) return;
        const tones = {
            slate: 'bg-slate-700 text-slate-300',
            green: 'bg-green-600 text-white',
            amber: 'bg-amber-500 text-slate-900',
            red: 'bg-red-600 text-white'
        };
        badge.textContent = label;
        badge.className = `h-5 px-1.5 rounded text-[11px] font-black leading-5 text-center uppercase ${tones[tone] || tones.slate}`;
    }

    function statusLine() {
        if (syncing) return { text: 'Syncing…', tone: 'slate', badge: 'Sync' };
        if (lastError) return { text: lastError, tone: 'red', badge: 'Error' };
        if (!navigator.onLine) return { text: "Offline — changes will sync when you're back online.", tone: 'amber', badge: 'Offline' };
        if (lastSyncedAt) {
            const time = new Date(lastSyncedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            return { text: `Synced at ${time}`, tone: 'green', badge: 'On' };
        }
        return { text: 'Connected', tone: 'green', badge: 'On' };
    }

    function renderPanel() {
        const slot = document.getElementById('cloud-sync-panel');
        if (!slot) return;
        const toneText = { slate: 'text-slate-600', green: 'text-green-700', amber: 'text-amber-700', red: 'text-red-700' };
        let body;

        if (!available) {
            setBadge('Off', 'slate');
            body = `<p class="text-sm text-slate-700">Server sync isn't available here. Rounds are saved on this device only.</p>`;
        } else if (!user) {
            setBadge('Sign in', 'slate');
            body = `
                <p class="text-sm text-slate-700 mb-2">Sign in to back up rounds to the server and see them on your other devices. Without signing in, rounds stay on this device only.</p>
                <form id="sync-signin-form" class="space-y-2" autocomplete="on">
                    <div>
                        <label for="sync-username" class="block text-xs font-semibold text-slate-800 mb-1">Username</label>
                        <input id="sync-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required class="${INPUT}">
                    </div>
                    <div>
                        <label for="sync-password" class="block text-xs font-semibold text-slate-800 mb-1">Password</label>
                        <input id="sync-password" name="password" type="password" autocomplete="current-password" required class="${INPUT}">
                    </div>
                    ${lastError ? `<p class="text-xs text-red-700">${escapeHtml(lastError)}</p>` : ''}
                    <button type="submit" class="${BTN} w-full h-11 bg-slate-900 text-white border-slate-900">Sign in</button>
                </form>`;
        } else {
            const status = statusLine();
            setBadge(status.badge, status.tone === 'slate' ? 'slate' : status.tone);
            body = `
                <div class="text-sm text-slate-800">Signed in as <strong>${escapeHtml(user.displayName || user.username)}</strong></div>
                <div class="text-xs font-semibold mt-0.5 ${toneText[status.tone]}">${escapeHtml(status.text)}</div>
                <div class="grid grid-cols-2 gap-1.5 mt-3">
                    <button type="button" data-sync-action="sync" ${syncing ? 'disabled' : ''} class="${BTN} bg-slate-900 text-white border-slate-900 disabled:opacity-50">Sync now</button>
                    <button type="button" data-sync-action="signout" class="${BTN} bg-white text-slate-700 border-slate-300">Sign out</button>
                    <a href="users.html" class="${BTN} col-span-2 bg-slate-100 text-slate-700 border-slate-300">${user.role === 'admin' ? 'Account &amp; users' : 'My account'}</a>
                </div>`;
        }

        slot.innerHTML = `<section class="bg-white text-slate-900 rounded-xl shadow-xl border border-slate-200 p-3 no-print">
            <h3 class="text-xs font-bold uppercase tracking-wider text-slate-700 mb-2">Sync &amp; account</h3>
            ${body}
        </section>`;

        const form = slot.querySelector('#sync-signin-form');
        if (form) {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const button = form.querySelector('button[type="submit"]');
                button.disabled = true;
                button.textContent = 'Signing in…';
                try {
                    await signIn(form.username.value.trim(), form.password.value);
                } catch (err) {
                    lastError = err.message;
                    renderPanel();
                }
            });
        }
        slot.querySelectorAll('[data-sync-action]').forEach(btn => btn.addEventListener('click', () => {
            if (btn.dataset.syncAction === 'sync') syncNow();
            else if (btn.dataset.syncAction === 'signout') signOut();
        }));
    }

    // ---------- Start ----------

    async function start() {
        bridge.isSignedIn = () => !!user;
        document.addEventListener('clayscorer:history-written', schedulePush);
        window.addEventListener('online', () => syncNow());
        window.addEventListener('offline', renderPanel);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && Date.now() - lastSyncedAt > REFRESH_AFTER_MS) syncNow();
        });

        renderPanel();
        try {
            const me = await api('GET', '/api/me');
            available = true;
            user = me.user;
        } catch (err) {
            // 404/HTML from a plain static host means there's no API: stay local-only.
            available = false;
        }
        renderPanel();
        if (user) syncNow();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0));
    else setTimeout(start, 0);
})();
