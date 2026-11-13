import { FIREBASE_CONFIG, FIREBASE_ENABLED } from './firebase-config.js';

const SDK_VERSION = '12.16.0';
const STATUS_IDLE = 'Ready';
const STATUS_DISABLED = 'Firebase not configured';
const COLLECTION_ROOT = 'clayScorerUsers';

const bridge = window.ClayScorerCloud;
let auth = null;
let db = null;
let user = null;
let ui = {};
let busy = false;

// Redirect sign-in only works when the auth helper is served from this site's own domain:
// Safari 16.1+ (and Chrome/Firefox) block the cross-site storage it relies on otherwise.
// https://firebase.google.com/docs/auth/web/redirect-best-practices
const authOnSameSite = () => FIREBASE_CONFIG?.authDomain === location.hostname;
// Installed to the iOS Home Screen: popups open in a separate window that can't hand the
// result back to the app, so popup sign-in typically fails there.
const isStandalone = () => window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const isIos = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Plain-language reason for a failed sign-in; the raw code is shown alongside so it can be reported.
function signInErrorHint(err) {
    const hints = {
        'auth/popup-blocked': 'The Google sign-in window was blocked. Allow pop-ups for this site (iPhone: Settings › Apps › Safari › Block Pop-ups off) and try again.',
        'auth/popup-closed-by-user': isStandalone() && isIos()
            ? 'Sign-in can\'t finish inside the Home Screen app on iPhone. Open ClayScorer in Safari to use cloud sync.'
            : 'The sign-in window closed before sign-in finished.',
        'auth/cancelled-popup-request': 'Another sign-in window was already open. Try again.',
        'auth/unauthorized-domain': `${location.hostname} isn't an authorised domain. Add it in Firebase › Authentication › Settings › Authorized domains.`,
        'auth/network-request-failed': 'No connection to Google. Check signal and try again.',
        'auth/web-storage-unsupported': 'This browser is blocking site storage (Private Browsing, or cookies blocked). Turn that off and try again.',
        'auth/operation-not-supported-in-this-environment': 'Sign-in isn\'t supported in this browser mode. Open the site in Safari.'
    };
    return hints[err?.code] || (isStandalone() && isIos()
        ? 'Sign-in from the Home Screen app is unreliable on iPhone. Open ClayScorer in Safari to use cloud sync.'
        : 'Sign-in didn\'t complete.');
}

function showDetail(message) {
    if (!ui.detail) return;
    ui.detail.textContent = message || '';
    ui.detail.classList.toggle('hidden', !message);
}

const hasConfig = () => FIREBASE_ENABLED && FIREBASE_CONFIG?.apiKey && FIREBASE_CONFIG?.authDomain && FIREBASE_CONFIG?.projectId && FIREBASE_CONFIG?.appId;
const clean = (value) => JSON.parse(JSON.stringify(value || {}));
const roundDocId = (disciplineId, roundKey) => `${disciplineId}_${encodeURIComponent(roundKey)}`;

function setStatus(message, tone = 'slate') {
    if (!ui.status) return;
    const colors = {
        slate: '#64748b',
        green: '#16a34a',
        amber: '#d97706',
        red: '#dc2626'
    };
    ui.status.textContent = message;
    ui.status.className = 'text-xs font-bold uppercase';
    ui.status.style.color = colors[tone] || colors.slate;
    setCloudBadge(message, tone);
}

function setCloudBadge(message, tone = 'slate') {
    const badge = document.getElementById('cloud-status-badge');
    if (!badge) return;
    const labels = {
        [STATUS_DISABLED]: 'Setup',
        [STATUS_IDLE]: 'Ready',
        'Sign in to sync': 'Sign In',
        'Signed in': 'On',
        'Signing in': 'Sync',
        'Opening redirect': 'Sync',
        'Cloud unavailable': 'Error',
        'Sign-in failed': 'Error',
        'Sign-out failed': 'Error',
        'Upload failed': 'Error',
        'Download failed': 'Error',
        'Delete failed': 'Error',
        'Uploading': 'Sync',
        'Uploading current': 'Sync',
        'Downloading': 'Sync',
        'Downloading current': 'Sync',
        'Deleting round': 'Sync',
        'Deleting history': 'Sync',
        'Signed out': 'Off',
        'No named rounds': 'Empty',
        'No current round': 'Empty',
        'Current not found': 'Missing',
        'Uploaded current': 'Done',
        'Downloaded current': 'Done',
        'Deleted round': 'Done',
        'Deleted history': 'Done',
        'Current up to date': 'Ready'
    };
    const classes = {
        slate: 'bg-slate-700 text-slate-300',
        green: 'bg-green-600 text-white',
        amber: 'bg-amber-500 text-white',
        red: 'bg-red-600 text-white'
    };
    const label = labels[message] || (/^Uploaded|^Downloaded/.test(message) ? 'Done' : message);
    badge.textContent = label;
    badge.className = `h-5 px-1.5 rounded text-xs font-black leading-5 text-center uppercase ${classes[tone] || classes.slate}`;
}

function setBusy(isBusy) {
    busy = isBusy;
    updateUi();
}

function updateUi() {
    if (!ui.panel) return;
    const signedIn = !!user;
    const configured = hasConfig();
    ui.identity.textContent = signedIn ? (user.email || 'Signed in') : 'Not signed in';
    ui.signIn.classList.toggle('hidden', signedIn);
    ui.signOut.classList.toggle('hidden', !signedIn);
    ui.signIn.disabled = busy || !configured;
    ui.signOut.disabled = busy || !configured;
    ui.uploadCurrent.disabled = busy || !configured || !signedIn;
    ui.uploadAll.disabled = busy || !configured || !signedIn;
    ui.downloadCurrent.disabled = busy || !configured || !signedIn;
    ui.downloadAll.disabled = busy || !configured || !signedIn;
    if (!signedIn && hasConfig()) setStatus('Sign in to sync', 'slate');
}

function mountUi() {
    if (!bridge || document.getElementById('cloud-sync-section')) return;
    const slot = document.getElementById('cloud-sync-panel');
    if (!slot) return;

    const section = document.createElement('section');
    section.id = 'cloud-sync-section';
    section.className = 'bg-white text-slate-900 rounded-xl shadow-xl border border-slate-200 overflow-hidden no-print';
    section.innerHTML = `
        <div class="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div class="min-w-0">
                <h3 class="text-xs font-black uppercase tracking-widest text-slate-500 flex items-center gap-1">
                    <i data-lucide="cloud" class="w-3 h-3"></i> Cloud Sync
                </h3>
                <div id="cloud-sync-identity" class="text-xs text-slate-500 font-bold mt-0.5">Not signed in</div>
                <div id="cloud-sync-status" class="text-xs font-bold uppercase text-slate-500 mt-0.5">${STATUS_IDLE}</div>
                <p id="cloud-sync-detail" class="hidden text-xs text-red-700 mt-1 leading-snug"></p>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
                <button id="cloud-sign-in" class="text-xs bg-slate-900 text-white px-3 py-1.5 rounded-lg font-black uppercase border border-slate-900 inline-flex items-center gap-1">
                    <i data-lucide="log-in" class="w-3 h-3"></i> Sign In
                </button>
                <button id="cloud-sign-out" class="hidden text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1">
                    <i data-lucide="log-out" class="w-3 h-3"></i> Sign Out
                </button>
                <button id="cloud-upload-current" class="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="upload-cloud" class="w-3 h-3"></i> Upload Current
                </button>
                <button id="cloud-upload-all" class="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="upload-cloud" class="w-3 h-3"></i> Upload All
                </button>
                <button id="cloud-download-current" class="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="download-cloud" class="w-3 h-3"></i> Download Current
                </button>
                <button id="cloud-download-all" class="text-xs bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="download-cloud" class="w-3 h-3"></i> Download All
                </button>
            </div>
        </div>
    `;
    slot.replaceChildren(section);

    ui = {
        panel: section,
        identity: section.querySelector('#cloud-sync-identity'),
        status: section.querySelector('#cloud-sync-status'),
        detail: section.querySelector('#cloud-sync-detail'),
        signIn: section.querySelector('#cloud-sign-in'),
        signOut: section.querySelector('#cloud-sign-out'),
        uploadCurrent: section.querySelector('#cloud-upload-current'),
        uploadAll: section.querySelector('#cloud-upload-all'),
        downloadCurrent: section.querySelector('#cloud-download-current'),
        downloadAll: section.querySelector('#cloud-download-all')
    };

    ui.signIn.addEventListener('click', signIn);
    ui.signOut.addEventListener('click', signOut);
    ui.uploadCurrent.addEventListener('click', () => uploadRounds('current'));
    ui.uploadAll.addEventListener('click', () => uploadRounds('all'));
    ui.downloadCurrent.addEventListener('click', () => downloadRounds('current'));
    ui.downloadAll.addEventListener('click', () => downloadRounds('all'));
    if (window.lucide) lucide.createIcons();
    updateUi();
}

async function initFirebase() {
    if (!hasConfig()) {
        setStatus(STATUS_DISABLED, 'amber');
        updateUi();
        return;
    }

    try {
        const [{ initializeApp }, authSdk, firestoreSdk] = await Promise.all([
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-app.js`),
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-auth.js`),
            import(`https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-firestore.js`)
        ]);
        const app = initializeApp(FIREBASE_CONFIG);
        auth = authSdk.getAuth(app);
        db = firestoreSdk.getFirestore(app);

        ui._authSdk = authSdk;
        ui._firestoreSdk = firestoreSdk;
        authSdk.onAuthStateChanged(auth, (currentUser) => {
            user = currentUser;
            updateUi();
            if (currentUser) {
                setStatus(STATUS_IDLE, 'green');
                showDetail('');
            }
        });
        // Surface the outcome of a redirect sign-in started on a previous page load.
        if (authOnSameSite()) {
            authSdk.getRedirectResult(auth).catch((err) => {
                console.warn('[ClayScorer] Firebase redirect sign-in failed', err);
                setStatus('Sign-in failed', 'red');
                showDetail(`${signInErrorHint(err)} (${err.code || err.message})`);
            });
        }
    } catch (err) {
        console.warn('[ClayScorer] Firebase init failed', err);
        setStatus('Cloud unavailable', 'red');
    }
}

async function signIn() {
    if (!auth || !ui._authSdk) return;
    const provider = new ui._authSdk.GoogleAuthProvider();
    showDetail('');
    // Redirect is the reliable flow for an installed app, but only when the auth helper is
    // same-site; otherwise stick with the popup (which must open straight from the tap).
    if (isStandalone() && authOnSameSite()) {
        setStatus('Opening redirect', 'slate');
        await ui._authSdk.signInWithRedirect(auth, provider);
        return;
    }
    setBusy(true);
    setStatus('Signing in', 'slate');
    try {
        await ui._authSdk.signInWithPopup(auth, provider);
        setStatus(STATUS_IDLE, 'green');
    } catch (err) {
        if (err.code === 'auth/popup-blocked' && authOnSameSite()) {
            setStatus('Opening redirect', 'slate');
            await ui._authSdk.signInWithRedirect(auth, provider);
            return;
        }
        console.warn('[ClayScorer] Firebase sign-in failed', err);
        setStatus('Sign-in failed', 'red');
        showDetail(`${signInErrorHint(err)} (${err.code || err.message})`);
    } finally {
        setBusy(false);
    }
}

async function signOut() {
    if (!auth || !ui._authSdk) return;
    setBusy(true);
    try {
        await ui._authSdk.signOut(auth);
        setStatus('Signed out', 'slate');
    } catch (err) {
        console.warn('[ClayScorer] Firebase sign-out failed', err);
        setStatus('Sign-out failed', 'red');
    } finally {
        setBusy(false);
    }
}

function roundPayload(discipline, roundKey, round) {
    return {
        id: roundDocId(discipline.id, roundKey),
        data: {
            disciplineId: discipline.id,
            disciplineName: discipline.name,
            storageKey: discipline.storageKey,
            roundKey,
            state: clean(round),
            updatedAtMs: round._updatedAt || Date.now()
        }
    };
}

function localRounds(scope) {
    bridge.saveCurrent();
    const discipline = bridge.getDiscipline();
    const history = bridge.getHistory();
    if (scope === 'current') {
        const currentKey = bridge.getCurrentState()._roundKey;
        return currentKey && history[currentKey] ? [roundPayload(discipline, currentKey, history[currentKey])] : [];
    }
    return Object.entries(history).map(([roundKey, round]) => roundPayload(discipline, roundKey, round));
}

async function uploadRounds(scope) {
    if (!user || !db || !ui._firestoreSdk) return;
    const rounds = localRounds(scope);
    if (!rounds.length) {
        setStatus(scope === 'current' ? 'No current round' : 'No named rounds', 'amber');
        return;
    }

    setBusy(true);
    setStatus(scope === 'current' ? 'Uploading current' : 'Uploading', 'slate');
    try {
        const { doc, setDoc, serverTimestamp } = ui._firestoreSdk;
        await Promise.all(rounds.map((round) => setDoc(
            doc(db, COLLECTION_ROOT, user.uid, 'rounds', round.id),
            { ...round.data, syncedAt: serverTimestamp() },
            { merge: true }
        )));
        setStatus(scope === 'current' ? 'Uploaded current' : `Uploaded ${rounds.length}`, 'green');
    } catch (err) {
        console.warn('[ClayScorer] Firebase upload failed', err);
        setStatus('Upload failed', 'red');
    } finally {
        setBusy(false);
    }
}

function mergeRemoteRound(local, data, currentKey, options = {}) {
    if (!data.roundKey || !data.state) return { added: 0, updated: 0, currentWasUpdated: false };
    const remote = clean(data.state);
    if (options.force) {
        const existed = !!local[data.roundKey];
        local[data.roundKey] = remote;
        return {
            added: existed ? 0 : 1,
            updated: existed ? 1 : 0,
            currentWasUpdated: data.roundKey === currentKey
        };
    }
    const localUpdated = local[data.roundKey]?._updatedAt || 0;
    const remoteUpdated = remote._updatedAt || data.updatedAtMs || 0;
    if (!local[data.roundKey]) {
        local[data.roundKey] = remote;
        return { added: 1, updated: 0, currentWasUpdated: false };
    }
    if (remoteUpdated > localUpdated) {
        local[data.roundKey] = remote;
        return { added: 0, updated: 1, currentWasUpdated: data.roundKey === currentKey };
    }
    return { added: 0, updated: 0, currentWasUpdated: false };
}

async function downloadRounds(scope) {
    if (!user || !db || !ui._firestoreSdk) return;
    const discipline = bridge.getDiscipline();
    const currentKey = bridge.getCurrentState()._roundKey;
    if (scope === 'current' && !currentKey) {
        setStatus('No current round', 'amber');
        return;
    }

    setBusy(true);
    setStatus(scope === 'current' ? 'Downloading current' : 'Downloading', 'slate');
    try {
        const { collection, doc, getDoc, getDocs } = ui._firestoreSdk;
        const local = bridge.getHistory();
        let added = 0;
        let updated = 0;
        let currentWasUpdated = false;
        let currentFound = scope !== 'current';

        if (scope === 'current') {
            const docSnap = await getDoc(doc(db, COLLECTION_ROOT, user.uid, 'rounds', roundDocId(discipline.id, currentKey)));
            if (docSnap.exists()) {
                currentFound = true;
                const result = mergeRemoteRound(local, docSnap.data(), currentKey, { force: true });
                added += result.added;
                updated += result.updated;
                currentWasUpdated = currentWasUpdated || result.currentWasUpdated;
            }
        } else {
            const snapshot = await getDocs(collection(db, COLLECTION_ROOT, user.uid, 'rounds'));
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                if (data.disciplineId !== discipline.id || !data.roundKey || !data.state) return;
                const result = mergeRemoteRound(local, data, currentKey);
                added += result.added;
                updated += result.updated;
                currentWasUpdated = currentWasUpdated || result.currentWasUpdated;
            });
        }

        if (added || updated) {
            bridge.replaceHistory(local);
            if (currentWasUpdated) bridge.refreshCurrentRoundFromHistory();
        }
        const changed = added + updated;
        setStatus(scope === 'current' ? (currentFound ? 'Downloaded current' : 'Current not found') : `Downloaded ${changed}`, currentFound && changed ? 'green' : currentFound ? 'slate' : 'amber');
    } catch (err) {
        console.warn('[ClayScorer] Firebase download failed', err);
        setStatus('Download failed', 'red');
    } finally {
        setBusy(false);
    }
}

async function deleteRemoteRound(roundKey) {
    if (!roundKey || !user || !db || !ui._firestoreSdk) return false;
    const discipline = bridge.getDiscipline();
    setBusy(true);
    setStatus('Deleting round', 'slate');
    try {
        const { doc, deleteDoc } = ui._firestoreSdk;
        await deleteDoc(doc(db, COLLECTION_ROOT, user.uid, 'rounds', roundDocId(discipline.id, roundKey)));
        setStatus('Deleted round', 'green');
        return true;
    } catch (err) {
        console.warn('[ClayScorer] Firebase delete failed', err);
        setStatus('Delete failed', 'red');
        throw err;
    } finally {
        setBusy(false);
    }
}

async function deleteRemoteHistory() {
    if (!user || !db || !ui._firestoreSdk) return false;
    const discipline = bridge.getDiscipline();
    setBusy(true);
    setStatus('Deleting history', 'slate');
    try {
        const { collection, deleteDoc, getDocs } = ui._firestoreSdk;
        const snapshot = await getDocs(collection(db, COLLECTION_ROOT, user.uid, 'rounds'));
        const deletes = [];
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            if (data.disciplineId === discipline.id) deletes.push(deleteDoc(docSnap.ref));
        });
        await Promise.all(deletes);
        setStatus('Deleted history', 'green');
        return true;
    } catch (err) {
        console.warn('[ClayScorer] Firebase history delete failed', err);
        setStatus('Delete failed', 'red');
        throw err;
    } finally {
        setBusy(false);
    }
}

if (bridge) {
    bridge.deleteRemoteRound = deleteRemoteRound;
    bridge.deleteRemoteHistory = deleteRemoteHistory;
}

function start() {
    if (!document.getElementById('history-section')) {
        window.setTimeout(start, 50);
        return;
    }
    mountUi();
    initFirebase();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
