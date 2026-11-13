/* One-off import of rounds from the old Firebase sync into this server (migrate.html).
 *
 * Firestore rules only let a Google account read its own rounds, so this runs in the user's
 * browser: sign in to this server, sign in with Google, then every Firestore round
 * (clayScorerUsers/{uid}/rounds/*) is PUT to /api/rounds/:discipline/:roundKey. The server
 * keeps whichever copy is newer, so re-running is safe.
 */
import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK_VERSION = '12.16.0';
const COLLECTION_ROOT = 'clayScorerUsers';
const DISCIPLINE_NAMES = { sporting: 'English Sporting', sportrap: 'Sportrap', compak: 'Compak Sporting', skeet: 'English Skeet' };

const $ = (id) => document.getElementById(id);
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let serverUser = null;
let firebaseRounds = [];

async function api(method, path, body) {
    const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-ClayScorer': '1' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data) throw new Error(data?.error || `Server error (${res.status})`);
    return data;
}

function updateImportButton() {
    $('import-btn').disabled = !(serverUser && firebaseRounds.length);
}

async function checkServer() {
    try {
        ({ user: serverUser } = await api('GET', '/api/me'));
    } catch (e) {
        $('server-status').textContent = "This server's API isn't reachable.";
        return;
    }
    $('server-status').innerHTML = serverUser
        ? `Signed in as <strong>${escapeHtml(serverUser.username)}</strong>. Rounds will be imported into this account.`
        : `Not signed in. <a href="users.html" class="underline font-semibold">Sign in on the account page</a>, then reload this page.`;
    updateImportButton();
}

function showFound() {
    if (!firebaseRounds.length) {
        $('found').textContent = 'No rounds found in Firebase for this Google account.';
        return;
    }
    const byDiscipline = {};
    firebaseRounds.forEach(r => { (byDiscipline[r.disciplineId] ||= []).push(r); });
    $('found').innerHTML = Object.entries(byDiscipline).map(([id, rounds]) => `
        <div class="mt-1"><strong>${escapeHtml(DISCIPLINE_NAMES[id] || id)}</strong> — ${rounds.length} round${rounds.length !== 1 ? 's' : ''}
            <ul class="list-disc pl-5 text-xs text-slate-600">${rounds
                .sort((a, b) => (b.state.date || '').localeCompare(a.state.date || ''))
                .map(r => `<li>${escapeHtml(r.state.date || '')} · ${escapeHtml(r.state.ground || r.state.event || r.roundKey)}${r.state.ground && r.state.event ? ` · ${escapeHtml(r.state.event)}` : ''}</li>`).join('')}</ul>
        </div>`).join('');
}

async function startFirebase() {
    let authSdk, firestoreSdk, auth, db;
    try {
        const [{ initializeApp }, a, f] = await Promise.all([
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`)
        ]);
        authSdk = a;
        firestoreSdk = f;
        const app = initializeApp(FIREBASE_CONFIG);
        auth = authSdk.getAuth(app);
        db = firestoreSdk.getFirestore(app);
    } catch (err) {
        console.warn(err);
        $('firebase-status').textContent = `Couldn't load Firebase: ${err.message}`;
        return;
    }

    $('google-btn').disabled = false;
    $('google-btn').addEventListener('click', async () => {
        $('google-btn').disabled = true;
        try {
            await authSdk.signInWithPopup(auth, new authSdk.GoogleAuthProvider());
        } catch (err) {
            $('firebase-status').textContent = `Google sign-in failed (${err.code || err.message}).`;
            $('google-btn').disabled = false;
        }
    });

    authSdk.onAuthStateChanged(auth, async (fbUser) => {
        if (!fbUser) return;
        $('firebase-status').innerHTML = `Signed in as <strong>${escapeHtml(fbUser.email || fbUser.uid)}</strong>. Reading rounds…`;
        $('google-btn').classList.add('hidden');
        try {
            const { collection, getDocs } = firestoreSdk;
            const snapshot = await getDocs(collection(db, COLLECTION_ROOT, fbUser.uid, 'rounds'));
            firebaseRounds = [];
            snapshot.forEach(docSnap => {
                const d = docSnap.data();
                if (!d.disciplineId || !d.roundKey || !d.state) return;
                firebaseRounds.push({
                    disciplineId: d.disciplineId,
                    roundKey: d.roundKey,
                    state: d.state,
                    updatedAt: d.state._updatedAt || d.updatedAtMs || Date.now()
                });
            });
            $('firebase-status').innerHTML = `Signed in as <strong>${escapeHtml(fbUser.email || fbUser.uid)}</strong>.`;
            showFound();
        } catch (err) {
            $('firebase-status').textContent = `Couldn't read rounds from Firebase (${err.code || err.message}).`;
        }
        updateImportButton();
    });
}

$('import-btn').addEventListener('click', async () => {
    $('import-btn').disabled = true;
    let added = 0, kept = 0;
    const failed = [];
    for (const r of firebaseRounds) {
        try {
            const path = `/api/rounds/${encodeURIComponent(r.disciplineId)}/${encodeURIComponent(r.roundKey)}`;
            const { applied } = await api('PUT', path, { state: { ...r.state, _roundKey: r.roundKey, _updatedAt: r.updatedAt }, updatedAt: r.updatedAt });
            if (applied) added++; else kept++;
        } catch (err) {
            failed.push(`${r.disciplineId} · ${r.roundKey}: ${err.message}`);
        }
        $('result').textContent = `Importing… ${added + kept + failed.length}/${firebaseRounds.length}`;
    }
    $('result').className = `text-sm mt-2 ${failed.length ? 'text-red-700' : 'text-green-700'}`;
    $('result').innerHTML = `Imported ${added}. ${kept ? `${kept} already had a newer copy on the server. ` : ''}`
        + (failed.length ? `<br>${failed.length} failed:<br>${failed.map(escapeHtml).join('<br>')}` : '')
        + `<br>Open a discipline page and sign in as ${escapeHtml(serverUser.username)} to see them.`;
    $('import-btn').disabled = false;
});

checkServer();
startFirebase();
