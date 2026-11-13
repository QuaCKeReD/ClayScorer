/* Account & user management page (users.html) for the self-hosted build.
 *
 * Everyone signed in can change their own password. Admins can also add users, edit
 * username / display name / role, reset passwords, and delete users. All rules (last admin,
 * can't delete yourself, password length) are enforced by the server; this page just shows
 * its error messages.
 */
(function () {
    'use strict';

    const root = document.getElementById('users-root');
    const MUTATE_HEADERS = { 'Content-Type': 'application/json', 'X-ClayScorer': '1' };
    const CARD = 'bg-white rounded-xl shadow border border-slate-300 p-3';
    const HEAD = 'text-xs font-bold uppercase tracking-wider text-slate-700 mb-2';
    const LABEL = 'block text-xs font-semibold text-slate-800 mb-1';
    const INPUT = 'block w-full min-w-0 h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold';
    const BTN = 'text-sm font-bold px-3 h-10 rounded-lg border inline-flex items-center justify-center gap-1 disabled:opacity-50';
    const BTN_PRIMARY = `${BTN} bg-slate-900 text-white border-slate-900`;
    const BTN_PLAIN = `${BTN} bg-white text-slate-700 border-slate-300`;
    const BTN_DANGER = `${BTN} bg-white text-red-600 border-red-200`;

    let me = null;
    let users = [];
    let editingId = null;

    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmtDate = (ms) => ms ? new Date(ms).toLocaleDateString('en-GB') : '';

    let toastTimer = null;
    function notify(message, tone = 'info') {
        const el = document.getElementById('toast');
        el.textContent = message;
        el.className = `toast toast-${tone}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 4000);
    }

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

    // Runs a form's async action with its submit button disabled, showing errors as a toast.
    function bindForm(form, action) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const button = form.querySelector('button[type="submit"]');
            if (button) button.disabled = true;
            try {
                await action(new FormData(form));
            } catch (err) {
                notify(err.message, 'error');
                if (err.status === 401) { me = null; render(); }
            } finally {
                if (button) button.disabled = false;
            }
        });
    }

    // ---------- Views ----------

    function signInView(setupNeeded) {
        return `<section class="${CARD}">
            <h2 class="${HEAD}">Sign in</h2>
            ${setupNeeded ? `<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2 mb-2">No users exist yet. Set <code>ADMIN_USERNAME</code> and <code>ADMIN_PASSWORD</code> for the server and restart it to create the first admin.</p>` : ''}
            <form id="signin-form" class="space-y-2" autocomplete="on">
                <div><label for="si-username" class="${LABEL}">Username</label>
                    <input id="si-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required class="${INPUT}"></div>
                <div><label for="si-password" class="${LABEL}">Password</label>
                    <input id="si-password" name="password" type="password" autocomplete="current-password" required class="${INPUT}"></div>
                <button type="submit" class="${BTN_PRIMARY} w-full h-11">Sign in</button>
            </form>
        </section>`;
    }

    function accountView() {
        return `<section class="${CARD}">
            <div class="flex items-start justify-between gap-2">
                <div>
                    <h2 class="${HEAD}">My account</h2>
                    <p class="text-sm text-slate-800">Signed in as <strong>${escapeHtml(me.displayName || me.username)}</strong>
                        <span class="text-slate-600">(${escapeHtml(me.username)} · ${me.role === 'admin' ? 'Admin' : 'User'})</span></p>
                </div>
                <button type="button" id="signout-btn" class="${BTN_PLAIN} flex-shrink-0">Sign out</button>
            </div>
            <form id="password-form" class="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 items-end" autocomplete="on">
                <input type="text" name="username" value="${escapeHtml(me.username)}" autocomplete="username" hidden>
                <div><label for="pw-current" class="${LABEL}">Current password</label>
                    <input id="pw-current" name="currentPassword" type="password" autocomplete="current-password" required class="${INPUT}"></div>
                <div><label for="pw-new" class="${LABEL}">New password (8+ characters)</label>
                    <input id="pw-new" name="newPassword" type="password" autocomplete="new-password" minlength="8" required class="${INPUT}"></div>
                <button type="submit" class="${BTN_PRIMARY} h-11">Change password</button>
            </form>
        </section>`;
    }

    function userRow(u) {
        const isMe = u.id === me.id;
        if (editingId === u.id) {
            return `<li class="p-3 bg-orange-50">
                <form data-edit-form="${u.id}" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div><label class="${LABEL}" for="ed-username-${u.id}">Username</label>
                        <input id="ed-username-${u.id}" name="username" value="${escapeHtml(u.username)}" autocapitalize="none" spellcheck="false" required class="${INPUT}"></div>
                    <div><label class="${LABEL}" for="ed-display-${u.id}">Display name</label>
                        <input id="ed-display-${u.id}" name="displayName" value="${escapeHtml(u.displayName)}" class="${INPUT}"></div>
                    <div><label class="${LABEL}" for="ed-role-${u.id}">Role</label>
                        <select id="ed-role-${u.id}" name="role" class="${INPUT}">
                            <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
                            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                        </select></div>
                    <div><label class="${LABEL}" for="ed-password-${u.id}">New password (leave blank to keep)</label>
                        <input id="ed-password-${u.id}" name="password" type="password" autocomplete="new-password" minlength="8" class="${INPUT}"></div>
                    <div class="sm:col-span-2 flex gap-2 justify-end">
                        <button type="button" data-cancel-edit class="${BTN_PLAIN}">Cancel</button>
                        <button type="submit" class="${BTN_PRIMARY}">Save</button>
                    </div>
                </form>
            </li>`;
        }
        return `<li class="p-3 flex items-center gap-2">
            <div class="flex-1 min-w-0">
                <div class="text-sm font-bold truncate">${escapeHtml(u.displayName || u.username)}${isMe ? ' <span class="text-xs font-semibold text-orange-700">(you)</span>' : ''}</div>
                <div class="text-xs text-slate-600">${escapeHtml(u.username)} · ${u.role === 'admin' ? 'Admin' : 'User'} · added ${fmtDate(u.createdAt)}</div>
            </div>
            <button type="button" data-edit="${u.id}" class="${BTN_PLAIN}">Edit</button>
            ${isMe ? '' : `<button type="button" data-delete="${u.id}" class="${BTN_DANGER}" aria-label="Delete ${escapeHtml(u.username)}">Delete</button>`}
        </li>`;
    }

    function usersView() {
        return `<section class="${CARD}">
            <h2 class="${HEAD}">Users <span class="normal-case font-semibold text-slate-500">(${users.length})</span></h2>
            <ul class="divide-y divide-slate-200 border border-slate-200 rounded-lg overflow-hidden">${users.map(userRow).join('')}</ul>
        </section>
        <section class="${CARD}">
            <h2 class="${HEAD}">Add user</h2>
            <form id="add-form" class="grid grid-cols-1 sm:grid-cols-2 gap-2" autocomplete="off">
                <div><label for="add-username" class="${LABEL}">Username</label>
                    <input id="add-username" name="username" autocapitalize="none" spellcheck="false" required pattern="[A-Za-z0-9._\\-]{3,32}" class="${INPUT}"></div>
                <div><label for="add-display" class="${LABEL}">Display name (optional)</label>
                    <input id="add-display" name="displayName" class="${INPUT}"></div>
                <div><label for="add-password" class="${LABEL}">Password (8+ characters)</label>
                    <input id="add-password" name="password" type="password" autocomplete="new-password" minlength="8" required class="${INPUT}"></div>
                <div><label for="add-role" class="${LABEL}">Role</label>
                    <select id="add-role" name="role" class="${INPUT}">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                    </select></div>
                <div class="sm:col-span-2 flex justify-end">
                    <button type="submit" class="${BTN_PRIMARY}">+ Add user</button>
                </div>
            </form>
            <p class="text-xs text-slate-600 mt-2">Each user only sees their own rounds. Deleting a user also deletes their rounds on the server (copies already on their devices stay there).</p>
        </section>`;
    }

    // ---------- Render & wire ----------

    async function loadUsers() {
        if (me?.role !== 'admin') { users = []; return; }
        ({ users } = await api('GET', '/api/users'));
    }

    function render(setupNeeded = false) {
        if (!me) {
            root.innerHTML = signInView(setupNeeded);
            bindForm(root.querySelector('#signin-form'), async (fd) => {
                ({ user: me } = await api('POST', '/api/login', { username: fd.get('username').trim(), password: fd.get('password') }));
                await loadUsers();
                render();
            });
            return;
        }

        root.innerHTML = accountView() + (me.role === 'admin' ? usersView() : '');

        root.querySelector('#signout-btn').addEventListener('click', async () => {
            try { await api('POST', '/api/logout', {}); } catch (e) {}
            me = null;
            users = [];
            render();
        });
        bindForm(root.querySelector('#password-form'), async (fd) => {
            await api('POST', '/api/me/password', { currentPassword: fd.get('currentPassword'), newPassword: fd.get('newPassword') });
            notify('Password changed. Other devices have been signed out.', 'success');
            render();
        });

        if (me.role !== 'admin') return;

        bindForm(root.querySelector('#add-form'), async (fd) => {
            await api('POST', '/api/users', {
                username: fd.get('username').trim(),
                displayName: fd.get('displayName').trim(),
                password: fd.get('password'),
                role: fd.get('role')
            });
            notify(`Added ${fd.get('username').trim()}.`, 'success');
            await loadUsers();
            render();
        });
        root.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', () => {
            editingId = Number(btn.dataset.edit);
            render();
        }));
        root.querySelectorAll('[data-cancel-edit]').forEach(btn => btn.addEventListener('click', () => {
            editingId = null;
            render();
        }));
        root.querySelectorAll('[data-edit-form]').forEach(form => bindForm(form, async (fd) => {
            const id = Number(form.dataset.editForm);
            const body = { username: fd.get('username').trim(), displayName: fd.get('displayName').trim(), role: fd.get('role') };
            if (fd.get('password')) body.password = fd.get('password');
            const { user } = await api('PATCH', `/api/users/${id}`, body);
            if (user.id === me.id) me = user;
            editingId = null;
            notify(`Saved ${user.username}.`, 'success');
            await loadUsers();
            render();
        }));
        root.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
            const target = users.find(u => u.id === Number(btn.dataset.delete));
            if (!target || !confirm(`Delete ${target.username} and all of their rounds on the server? This can't be undone.`)) return;
            try {
                await api('DELETE', `/api/users/${target.id}`);
                notify(`Deleted ${target.username}.`, 'success');
                await loadUsers();
                render();
            } catch (err) {
                notify(err.message, 'error');
            }
        }));
    }

    (async () => {
        try {
            const data = await api('GET', '/api/me');
            me = data.user;
            await loadUsers();
            render(data.setupNeeded);
        } catch (err) {
            root.innerHTML = `<section class="${CARD}"><p class="text-sm text-slate-800">The ClayScorer server isn't available here, so accounts can't be managed. Scoring still works on this device.</p>
                <a href="index.html" class="${BTN_PLAIN} mt-3">Back to disciplines</a></section>`;
        }
    })();
})();
