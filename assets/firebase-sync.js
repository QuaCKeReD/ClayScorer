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
    ui.status.className = 'text-[9px] font-bold uppercase';
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
        'Uploading': 'Sync',
        'Uploading current': 'Sync',
        'Downloading': 'Sync',
        'Downloading current': 'Sync',
        'Signed out': 'Off',
        'No named rounds': 'Empty',
        'No current round': 'Empty',
        'Current not found': 'Missing',
        'Uploaded current': 'Done',
        'Downloaded current': 'Done',
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
    badge.className = `h-5 px-1.5 rounded text-[9px] font-black leading-5 text-center uppercase ${classes[tone] || classes.slate}`;
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
                <h3 class="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1">
                    <i data-lucide="cloud" class="w-3 h-3"></i> Cloud Sync
                </h3>
                <div id="cloud-sync-identity" class="text-[9px] text-slate-500 font-bold mt-0.5">Not signed in</div>
                <div id="cloud-sync-status" class="text-[9px] font-bold uppercase text-slate-500 mt-0.5">${STATUS_IDLE}</div>
            </div>
            <div class="grid grid-cols-2 gap-1.5">
                <button id="cloud-sign-in" class="text-[9px] bg-slate-900 text-white px-3 py-1.5 rounded-lg font-black uppercase border border-slate-900 inline-flex items-center gap-1">
                    <i data-lucide="log-in" class="w-3 h-3"></i> Sign In
                </button>
                <button id="cloud-sign-out" class="hidden text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1">
                    <i data-lucide="log-out" class="w-3 h-3"></i> Sign Out
                </button>
                <button id="cloud-upload-current" class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="upload-cloud" class="w-3 h-3"></i> Upload Current
                </button>
                <button id="cloud-upload-all" class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="upload-cloud" class="w-3 h-3"></i> Upload All
                </button>
                <button id="cloud-download-current" class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
                    <i data-lucide="download-cloud" class="w-3 h-3"></i> Download Current
                </button>
                <button id="cloud-download-all" class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 inline-flex items-center gap-1 disabled:opacity-40">
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
            if (currentUser) setStatus(STATUS_IDLE, 'green');
        });
    } catch (err) {
        console.warn('[ClayScorer] Firebase init failed', err);
        setStatus('Cloud unavailable', 'red');
    }
}

async function signIn() {
    if (!auth || !ui._authSdk) return;
    setBusy(true);
    setStatus('Signing in', 'slate');
    try {
        const provider = new ui._authSdk.GoogleAuthProvider();
        await ui._authSdk.signInWithPopup(auth, provider);
        setStatus(STATUS_IDLE, 'green');
    } catch (err) {
        if (err.code === 'auth/popup-blocked') {
            setStatus('Opening redirect', 'slate');
            await ui._authSdk.signInWithRedirect(auth, new ui._authSdk.GoogleAuthProvider());
            return;
        }
        console.warn('[ClayScorer] Firebase sign-in failed', err);
        setStatus('Sign-in failed', 'red');
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
