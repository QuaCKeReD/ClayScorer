/* Multi-discipline clay scoring engine.
 *
 * Each discipline page sets `window.DISCIPLINE` before loading this file:
 *   {
 *     id, name, code, storageKey, standLabel,
 *     maxShooters, showFirstUpRotation,
 *     editable: { standCount, targetsPerStand, extraClay },
 *     defaults: { standCount, targetsPerStand },  // only when standCount editable
 *     targetOptions: [4, 6, 8, 10],               // only when targetsPerStand editable
 *     fixedStands: [{ id, targets, labels? }]     // null for variable ESP
 *   }
 *
 * Storage keys are per-discipline so each round is independent.
 */
(function () {
    'use strict';

    const D = window.DISCIPLINE;
    if (!D) { console.error('DISCIPLINE config missing'); return; }

    const KEY = D.storageKey;
    const MAX_SHOOTERS = D.maxShooters || 6;
    const CLASSES = ['AAA', 'AA', 'A', 'B', 'C', 'U'];
    const ROTATE = D.showFirstUpRotation !== false;

    const standTargets = (s) => s.targets + (s.extraClay ? 1 : 0);

    const KEY_CURRENT = KEY;
    const KEY_HISTORY = KEY + ':history';

    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const roundKey = (s) => `${(s.ground || '').trim().toLowerCase()}|${s.date || ''}|${(s.event || '').trim().toLowerCase()}`;
    const isNamedRound = (s) => !!((s.ground || '').trim() || (s.event || '').trim());
    const readHistory = () => { try { return JSON.parse(localStorage.getItem(KEY_HISTORY) || '{}'); } catch (e) { return {}; } };
    const writeHistory = (h) => { try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch (e) {} };

    // Note: the outer `history` variable is the undo snapshot — the persisted round history
    // dict is read/written via readHistory()/writeHistory() to avoid the name collision.
    let history = null;
    let state;

    function makeDefaultState() {
        const stands = D.fixedStands
            ? D.fixedStands.map(s => ({ ...s, extraClay: !!s.extraClay }))
            : Array.from({ length: D.defaults.standCount }, (_, i) => ({
                id: i + 1, targets: D.defaults.targetsPerStand, extraClay: false
            }));
        return {
            ground: '', date: new Date().toISOString().split('T')[0], event: '', notes: '',
            shooters: [{ id: Date.now(), name: 'Shooter 1', cpsa: '', class: 'U' }],
            stands, hits: {}, activeIdx: 0, isLocked: false
        };
    }

    function saveStateOnly() {
        try { localStorage.setItem(KEY_CURRENT, JSON.stringify(state)); } catch (e) {}
    }

    function save() {
        // Sync history first so state._roundKey is up-to-date before the live snapshot is persisted.
        syncHistory();
        saveStateOnly();
    }

    // Writes the current state into the per-discipline history dict keyed by
    // (ground|date|event). Renames (moves) the previous entry when both old and
    // new keys are named. Unnamed rounds are not written — but if a previously
    // named round becomes unnamed the old entry is retained as an archive.
    function syncHistory() {
        const newKey = roundKey(state);
        const prev = state._roundKey;
        const named = isNamedRound(state);
        const store = readHistory();
        let dirty = false;
        if (prev && prev !== newKey && named && store[prev]) {
            delete store[prev];
            dirty = true;
        }
        if (named) {
            store[newKey] = { ...state, _roundKey: newKey, _updatedAt: Date.now() };
            dirty = true;
        }
        if (dirty) writeHistory(store);
        state._roundKey = named ? newKey : null;
    }

    function load() {
        const s = localStorage.getItem(KEY_CURRENT);
        if (!s) return false;
        try {
            const parsed = JSON.parse(s);
            state = Object.assign({}, state, parsed);
            state.stands = state.stands.map(st => ({ ...st, extraClay: !!st.extraClay }));
            return true;
        } catch (e) { return false; }
    }

    window.toggleLock = () => { state.isLocked = !state.isLocked; render(); save(); };
    // Live-typing handler: updates state and persists KEY_CURRENT immediately, but for
    // ground/event we deliberately skip the history write so we don't churn a rename
    // per keystroke. History is committed by commitField on onchange/blur instead.
    window.updateField = (k, v) => {
        state[k] = v;
        if (k === 'ground' || k === 'event') {
            saveStateOnly();
        } else {
            save();
        }
    };

    // Commit handler: called from onchange (blur / date-picker commit) on ground/date/event.
    // Does a full save so the round history is written / renamed at commit time only.
    window.commitField = (k, v) => {
        state[k] = v;
        save();
        renderHistory();
    };

    window.updateStandCount = (c) => {
        if (!D.editable.standCount) return;
        const count = parseInt(c);
        const current = state.stands.length;
        if (count > current) {
            for (let i = current + 1; i <= count; i++) {
                state.stands.push({ id: i, targets: D.defaults.targetsPerStand, extraClay: false });
            }
        } else if (count < current) {
            state.stands = state.stands.slice(0, count);
            if (state.activeIdx >= count) state.activeIdx = count - 1;
        }
        render(); save();
    };

    window.addShooter = () => {
        if (state.shooters.length >= MAX_SHOOTERS) return;
        state.shooters.push({ id: Date.now(), name: `Shooter ${state.shooters.length + 1}`, cpsa: '', class: 'U' });
        render(); save();
    };

    window.removeShooter = (id) => {
        if (state.shooters.length <= 1) return;
        state.shooters = state.shooters.filter(s => s.id !== id);
        render(); save();
    };

    window.updateShooter = (idx, field, value) => {
        state.shooters[idx][field] = value;
        save();
        if (field === 'name') render();
    };

    function ensureHitsArray(shId, stand) {
        const total = standTargets(stand);
        if (!state.hits[shId]) state.hits[shId] = {};
        const existing = state.hits[shId][stand.id];
        if (!existing || existing.length !== total) {
            state.hits[shId][stand.id] = Array.from({ length: total }, (_, i) => existing?.[i] ?? null);
        }
        return state.hits[shId][stand.id];
    }

    window.toggleHit = (shId, stId, idx, val) => {
        if (state.isLocked) return;
        const stand = state.stands.find(s => s.id === stId);
        if (!stand) return;
        history = JSON.parse(JSON.stringify(state.hits));
        const arr = ensureHitsArray(shId, stand);
        const curr = arr[idx];
        arr[idx] = (curr === val) ? null : val;
        if (arr[idx] !== null && navigator.vibrate) {
            val ? navigator.vibrate(50) : navigator.vibrate([40, 40, 40]);
        }
        render(); save();
    };

    window.undo = () => {
        if (!history) return;
        state.hits = history; history = null; render(); save();
    };

    window.setBirds = (c) => {
        if (state.isLocked || !D.editable.targetsPerStand) return;
        const st = state.stands[state.activeIdx];
        st.targets = c;
        state.shooters.forEach(sh => { if (state.hits[sh.id]?.[st.id]) ensureHitsArray(sh.id, st); });
        render(); save();
    };

    window.setExtraClay = () => {
        if (state.isLocked || !D.editable.extraClay) return;
        const st = state.stands[state.activeIdx];
        st.extraClay = !st.extraClay;
        state.shooters.forEach(sh => { if (state.hits[sh.id]?.[st.id]) ensureHitsArray(sh.id, st); });
        render(); save();
    };

    window.nav = (d) => {
        if (state.isLocked) return;
        state.activeIdx = Math.max(0, Math.min(state.stands.length - 1, state.activeIdx + d));
        render(); save();
    };

    const getUKDate = (d) => d ? new Date(d).toLocaleDateString('en-GB') : 'N/A';

    function getShooterTotal(shId) {
        let t = 0;
        state.stands.forEach(st => {
            if (state.hits[shId]?.[st.id]) t += state.hits[shId][st.id].filter(h => h === true).length;
        });
        return t;
    }

    window.resetAll = () => {
        if (confirm(`Clear ALL ${D.name} data on this device (current round AND history)?`)) {
            localStorage.removeItem(KEY_CURRENT);
            localStorage.removeItem(KEY_HISTORY);
            location.reload();
        }
    };

    window.newRound = () => {
        const hasActiveNamed = isNamedRound(state);
        const hasUnsavedScores = !hasActiveNamed && Object.keys(state.hits || {}).length > 0;
        if (hasActiveNamed && !confirm('Start a new round? The current round stays in history.')) return;
        if (hasUnsavedScores && !confirm('Discard the current unsaved round?')) return;
        save();
        state = makeDefaultState();
        history = null;
        render(); save();
    };

    window.loadRound = (key) => {
        const store = readHistory();
        const round = store[key];
        if (!round) return;
        save();
        state = Object.assign({}, makeDefaultState(), round);
        state.stands = (state.stands || []).map(st => ({ ...st, extraClay: !!st.extraClay }));
        if (!state.stands.length) state.stands = makeDefaultState().stands;
        state.activeIdx = Math.min(state.activeIdx || 0, state.stands.length - 1);
        history = null;
        render(); save();
    };

    window.deleteRound = (key) => {
        const store = readHistory();
        if (!store[key]) return;
        const round = store[key];
        const label = (round.ground || '').trim() || (round.event || '').trim() || getUKDate(round.date);
        if (!confirm(`Delete round "${label}" from history?`)) return;
        delete store[key];
        writeHistory(store);
        if (state._roundKey === key) {
            state = makeDefaultState();
            history = null;
            save();
        }
        render();
    };

    window.downloadCSV = () => {
        let csv = `Discipline,${D.name}\nGround,${state.ground}\nDate,${state.date}\nEvent,${state.event}\n\nShooter,CPSA,Class,`;
        csv += state.stands.map(s => `${D.standLabel.slice(0, 2).toUpperCase()}${s.id}${s.extraClay ? '+1' : ''}`).join(',') + ',Total\n';
        state.shooters.forEach(s => {
            const perStand = state.stands.map(st => state.hits[s.id]?.[st.id]?.filter(h => h === true).length || 0);
            csv += `${s.name},${s.cpsa},${s.class},${perStand.join(',')},${getShooterTotal(s.id)}\n`;
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${D.id}-scores.csv`;
        a.click();
    };

    function generateExportGrid(tid) {
        const grid = document.getElementById(tid);
        grid.innerHTML = '';
        const isShare = tid === 'cap-grid';
        const rowH = isShare ? '45px' : '30px';
        const headH = isShare ? '40px' : '25px';
        const pairH = isShare ? '25px' : '18px';
        const abbr = D.standLabel.slice(0, 3).toUpperCase();

        let h = `<tr style="background:#f0f0f0"><th style="width:200px; vertical-align:middle;" rowspan="2"><div class="cell-center">NAME</div></th>`;
        state.stands.forEach(st => {
            const total = standTargets(st);
            h += `<th colspan="${Math.ceil(total / 2)}" style="vertical-align:middle; height:${headH};"><div class="cell-center">${abbr} ${st.id}${st.extraClay ? '+1' : ''}</div></th>`;
        });
        h += `<th style="width:60px; vertical-align:middle;" rowspan="2"><div class="cell-center">TOTAL</div></th></tr><tr>`;
        state.stands.forEach(st => {
            const total = standTargets(st);
            for (let p = 1; p <= Math.ceil(total / 2); p++) {
                h += `<th style="font-size:6pt; height:${pairH}; background:#fafafa; vertical-align:middle;"><div class="cell-center">P${p}</div></th>`;
            }
        });
        grid.innerHTML = h + '</tr>';

        const sorted = state.shooters.map(s => ({ ...s, t: getShooterTotal(s.id) })).sort((a, b) => b.t - a.t);
        sorted.forEach(s => {
            let r1 = `<tr><td style="text-align:left; padding-left:10px; vertical-align:middle; white-space:normal;" rowspan="2"><strong>${s.name}</strong></td>`;
            let r2 = `<tr>`;
            state.stands.forEach(st => {
                const total = standTargets(st);
                const hits = state.hits[s.id]?.[st.id] || Array(total).fill(null);
                for (let i = 0; i < Math.ceil(total / 2) * 2; i += 2) {
                    const d = (idx) => {
                        if (idx >= total) return { m: '', bg: 'transparent' };
                        if (hits[idx] === true) return { m: '/', bg: '#4ade80' };
                        if (hits[idx] === false) return { m: 'O', bg: '#f87171' };
                        return { m: '', bg: 'transparent' };
                    };
                    const b1 = d(i), b2 = d(i + 1);
                    r1 += `<td style="background:${b1.bg}; height:${rowH}; vertical-align:middle;"><div class="cell-center" style="font-weight:900;">${b1.m}</div></td>`;
                    r2 += `<td style="background:${b2.bg}; height:${rowH}; vertical-align:middle;"><div class="cell-center" style="font-weight:900;">${b2.m}</div></td>`;
                }
            });
            r1 += `<td style="font-weight:bold; font-size:16pt; vertical-align:middle; background:#fafafa;" rowspan="2"><div class="cell-center">${s.t}</div></td></tr>`;
            grid.innerHTML += r1 + r2 + '</tr>';
        });
    }

    window.exportToPDF = () => {
        document.getElementById('p-ground').innerText = state.ground || 'N/A';
        document.getElementById('p-date').innerText = getUKDate(state.date);
        document.getElementById('p-notes').innerText = state.notes || '';
        document.getElementById('p-discipline').innerText = D.name;
        generateExportGrid('p-grid');
        window.print();
    };

    window.shareAsImage = async () => {
        const container = document.getElementById('capture-container');
        document.getElementById('cap-ground').innerText = state.ground || 'N/A';
        document.getElementById('cap-date').innerText = getUKDate(state.date);
        document.getElementById('cap-discipline').innerText = D.name;
        generateExportGrid('cap-grid');
        try {
            container.style.position = 'fixed'; container.style.left = '0'; container.style.top = '0'; container.style.zIndex = '-1';
            const canvas = await html2canvas(container, { scale: 3, backgroundColor: '#ffffff', useCORS: true });
            container.style.position = 'absolute'; container.style.left = '-9999px';
            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const file = new File([blob], `${D.id}-leaderboard.png`, { type: 'image/png' });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: `${D.name} Squad Leaderboard` });
                } else {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${D.id}-scores.png`;
                    a.click();
                }
            });
        } catch (e) { console.error(e); }
    };

    function mountSkeleton() {
        const setupStand = D.editable.standCount
            ? `<div class="space-y-1">
                 <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">${D.standLabel} Count</label>
                 <select id="field-stand-count" onchange="updateStandCount(this.value)" class="w-full bg-slate-50 border-none rounded-lg p-2 text-xs font-black">
                   ${Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}">${i + 1} ${D.standLabel}${i > 0 ? 's' : ''}</option>`).join('')}
                 </select>
               </div>`
            : `<div class="space-y-1">
                 <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Format</label>
                 <div id="field-format" class="bg-slate-50 rounded-lg p-2 text-xs font-black text-slate-700"></div>
               </div>`;

        document.getElementById('app-root').innerHTML = `
        <header class="bg-slate-900 text-white sticky top-0 z-50 shadow-md no-print w-full">
            <div class="max-w-5xl mx-auto p-3 flex justify-between items-center">
                <div class="flex items-center gap-2">
                    <a href="index.html" aria-label="Home" class="w-8 h-8 flex items-center justify-center bg-orange-500 rounded-lg shadow-sm">
                        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6">
                            <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>
                        </svg>
                    </a>
                    <div>
                        <div class="text-[8px] text-orange-400 font-black uppercase tracking-widest leading-none">${D.code}</div>
                        <h1 class="text-base font-bold tracking-tight uppercase italic leading-none mt-0.5">${D.name}</h1>
                        <span id="offline-status" class="text-[7px] text-green-400 font-bold uppercase flex items-center gap-1 mt-0.5"><i data-lucide="wifi-off" size="7"></i> Offline Ready</span>
                    </div>
                </div>
                <div class="flex items-center gap-1.5">
                    <button id="lock-btn" onclick="toggleLock()" class="bg-slate-800 p-2 rounded-lg border border-slate-700">
                        <i data-lucide="unlock" id="lock-icon" class="w-4 h-4 text-slate-400"></i>
                    </button>
                    <button onclick="shareAsImage()" id="share-btn" class="bg-slate-700 p-2 rounded-lg border border-slate-600">
                        <i data-lucide="share-2" class="w-4 h-4 text-white"></i>
                    </button>
                    <button onclick="exportToPDF()" class="bg-orange-500 px-3 py-2 rounded-lg text-[10px] font-black uppercase">PDF</button>
                </div>
            </div>
            <div class="w-full bg-slate-800 h-1"><div id="progress-bar" class="bg-orange-500 h-full transition-all duration-500 w-0"></div></div>
        </header>

        <main id="app-container" class="max-w-5xl mx-auto p-2 space-y-3 transition-opacity duration-300">

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 p-3 no-print grid grid-cols-2 gap-2">
                <div class="col-span-2 sm:col-span-1 space-y-1">
                    <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Shoot Ground</label>
                    <input type="text" id="field-ground" placeholder="Ground name..." class="w-full bg-slate-50 border-none rounded-lg p-2 text-xs font-bold" oninput="updateField('ground', this.value)" onchange="commitField('ground', this.value)">
                </div>
                <div class="space-y-1">
                    <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Shoot Date</label>
                    <input type="date" id="field-date" class="w-full bg-slate-50 border-none rounded-lg p-2 text-xs font-bold" onchange="commitField('date', this.value)">
                </div>
                ${setupStand}
                <div class="col-span-2 space-y-1">
                    <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Event Name</label>
                    <input type="text" id="field-event" placeholder="e.g. Club Championship" class="w-full bg-slate-50 border-none rounded-lg p-2 text-xs font-bold" oninput="updateField('event', this.value)" onchange="commitField('event', this.value)">
                </div>
            </section>

            <section id="history-section" class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden no-print"></section>

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 p-3 no-print">
                <div class="flex justify-between items-center mb-2">
                    <h3 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Squad Members</h3>
                    <button onclick="addShooter()" class="text-[9px] bg-slate-900 text-white px-3 py-1 rounded-lg font-black uppercase">Add Shooter</button>
                </div>
                <div id="squad-list" class="space-y-2"></div>
            </section>

            <div id="stand-nav" class="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide no-scrollbar px-1 no-print"></div>

            <section class="bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden no-print">
                <div class="bg-slate-900 px-3 py-2.5 text-white flex justify-between items-center">
                    <div class="flex items-baseline gap-2">
                        <h2 id="active-stand-title" class="text-lg font-black italic uppercase">${D.standLabel} 1</h2>
                        <span id="active-stand-targets" class="text-[9px] text-orange-400 font-bold uppercase"></span>
                    </div>
                    <button id="undo-btn" onclick="undo()" class="hidden text-[9px] font-black text-white uppercase flex items-center gap-1 bg-slate-800 px-2 py-1 rounded-lg border border-slate-700">
                        <i data-lucide="rotate-ccw" size="10"></i> Undo
                    </button>
                </div>

                <div id="scoring-controls"></div>
                <div id="scoring-area" class="divide-y divide-slate-100"></div>

                <div class="bg-slate-50 p-3 flex gap-3 no-print border-t border-slate-200">
                    <button onclick="nav(-1)" id="nav-prev" class="flex-1 bg-white border border-slate-300 py-3 rounded-xl text-xs font-black disabled:opacity-30 tracking-widest uppercase">Prev</button>
                    <button onclick="nav(1)" id="nav-next" class="flex-1 bg-slate-900 text-white py-3 rounded-xl text-xs font-black disabled:opacity-30 tracking-widest uppercase">Next ${D.standLabel}</button>
                </div>
            </section>

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden no-print">
                <div class="p-2 bg-slate-100 border-b border-slate-200 flex justify-between items-center text-[9px] font-black uppercase text-slate-500">
                    <span>Leaderboard Summary</span>
                    <div class="flex gap-4">
                        <button onclick="downloadCSV()">CSV</button>
                        <button onclick="resetAll()" class="text-red-600">Reset</button>
                    </div>
                </div>
                <div class="overflow-x-auto">
                    <table class="w-full text-[10px]" id="leaderboard">
                        <thead><tr id="lb-header" class="bg-slate-50 font-black uppercase border-b border-slate-200"></tr></thead>
                        <tbody id="lb-body"></tbody>
                        <tfoot id="lb-footer"></tfoot>
                    </table>
                </div>
            </section>

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 p-3 no-print">
                <label class="text-[9px] font-black uppercase text-slate-400 mb-1 flex items-center gap-1"><i data-lucide="sticky-note" size="10"></i> Round Notes</label>
                <textarea id="field-notes" placeholder="Notes..." class="w-full h-20 bg-slate-50 border-none rounded-xl p-3 text-xs font-bold outline-none focus:ring-1 focus:ring-orange-500 resize-none" oninput="updateField('notes', this.value)"></textarea>
            </section>

            <div id="capture-container">
                <div style="border-bottom: 2pt solid black; padding: 10px 0; margin-bottom: 15px; display: flex; justify-content: space-between; font-size: 14pt;">
                    <div><strong>GROUND:</strong> <span id="cap-ground"></span></div>
                    <div style="text-align:center; text-transform: uppercase;"><strong><span id="cap-discipline"></span> Leaderboard</strong></div>
                    <div><strong>DATE:</strong> <span id="cap-date"></span></div>
                </div>
                <table id="cap-grid"></table>
                <div style="margin-top: 30px; display: flex; justify-content: space-between; align-items: center; font-size: 11pt; font-weight: bold;">
                    <span>Generated by QuaCKeReD - original idea by Sarge</span>
                    <div style="border-top: 1.5pt solid black; width: 300px; text-align: center; padding-top: 8px;">SCORER / SHOOTER SIGNATURE</div>
                </div>
            </div>

            <div class="hidden print-only" id="print-view">
                <div class="print-header">
                    <div><strong>GROUND:</strong> <span id="p-ground"></span></div>
                    <div style="text-align:center; text-transform: uppercase;"><strong><span id="p-discipline"></span> Scorecard</strong></div>
                    <div style="text-align:right"><strong>DATE:</strong> <span id="p-date"></span></div>
                </div>
                <table id="p-grid"></table>
                <div class="print-notes"><strong>NOTES:</strong> <span id="p-notes"></span></div>
                <div class="signature-section"><div class="sig-line">SIGNATURE</div></div>
                <div style="text-align: center; margin-top: 20px; font-size: 8pt; font-weight: bold; color: #666;">Generated by QuaCKeReD</div>
            </div>
        </main>
        `;
    }

    function renderHistory() {
        const el = document.getElementById('history-section');
        if (!el) return;
        const store = readHistory();
        const entries = Object.entries(store).sort((a, b) => {
            const dateCmp = (b[1].date || '').localeCompare(a[1].date || '');
            if (dateCmp !== 0) return dateCmp;
            return (b[1]._updatedAt || 0) - (a[1]._updatedAt || 0);
        });
        const currentKey = state._roundKey;

        const rows = entries.map(([k, r]) => {
            const isCurrent = k === currentKey;
            const shooterCount = (r.shooters || []).length;
            let totalHits = 0, totalShot = 0;
            (r.shooters || []).forEach(sh => {
                const shHits = (r.hits || {})[sh.id] || {};
                Object.values(shHits).forEach(arr => (arr || []).forEach(h => {
                    if (h !== null && h !== undefined) totalShot++;
                    if (h === true) totalHits++;
                }));
            });
            const g = (r.ground || '').trim();
            const ev = (r.event || '').trim();
            const title = g || ev || 'Untitled';
            const subtitle = g && ev ? ev : '';
            const parts = [getUKDate(r.date), `${shooterCount} shooter${shooterCount !== 1 ? 's' : ''}`];
            if (totalShot) parts.push(`${totalHits}/${totalShot} hits`);
            const meta = parts.join(' &middot; ');
            const encKey = escapeHtml(k);
            return `<div class="flex items-center gap-2 px-3 py-2 border-t border-slate-100 ${isCurrent ? 'bg-orange-50' : ''}">
                <div class="flex-1 min-w-0">
                    <div class="text-[11px] font-black uppercase truncate">${escapeHtml(title)}${subtitle ? ` <span class="text-slate-400">&middot; ${escapeHtml(subtitle)}</span>` : ''}</div>
                    <div class="text-[9px] text-slate-500 font-bold mt-0.5">${meta}${isCurrent ? ' &middot; <span class="text-orange-600 uppercase">Editing</span>' : ''}</div>
                </div>
                ${isCurrent ? '' : `<button data-history-action="load" data-history-key="${encKey}" class="text-[9px] bg-slate-900 text-white px-2.5 py-1.5 rounded-lg font-black uppercase">Load</button>`}
                <button data-history-action="delete" data-history-key="${encKey}" class="text-red-400 p-1" aria-label="Delete round"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`;
        }).join('');

        const countLabel = entries.length ? ` (${entries.length})` : '';
        const emptyHint = entries.length ? '' : '<p class="text-[10px] text-slate-400 mt-0.5 font-medium normal-case tracking-normal">Rounds are saved automatically once you enter a Ground or Event.</p>';
        el.innerHTML = `
            <div class="p-3 flex justify-between items-center gap-2">
                <div class="min-w-0">
                    <h3 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Round History${countLabel}</h3>
                    ${emptyHint}
                </div>
                <button onclick="newRound()" class="flex-shrink-0 text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200">+ New Round</button>
            </div>
            ${entries.length ? `<div class="max-h-64 overflow-y-auto">${rows}</div>` : ''}`;
        if (window.lucide) lucide.createIcons();
    }

    function renderScoringControls() {
        const el = document.getElementById('scoring-controls');
        if (!D.editable.targetsPerStand && !D.editable.extraClay) { el.innerHTML = ''; return; }
        const st = state.stands[state.activeIdx];
        let html = '';
        if (D.editable.targetsPerStand) {
            const opts = D.targetOptions || [4, 6, 8, 10];
            html += `<div class="bg-slate-800 p-1 flex gap-1 no-print">${opts.map(o => `
                <button onclick="setBirds(${o})" class="flex-1 py-2 rounded-lg text-[9px] font-black ${st.targets === o ? 'bg-orange-500 text-white' : 'bg-slate-700 text-slate-400'}">${o / 2} PR</button>
            `).join('')}</div>`;
        }
        if (D.editable.extraClay) {
            html += `<div class="bg-slate-800 px-1 pb-1 no-print">
                <button onclick="setExtraClay()" class="w-full py-1.5 rounded-lg text-[9px] font-black flex items-center justify-center gap-1 ${st.extraClay ? 'bg-orange-500 text-white' : 'bg-slate-700 text-slate-400'}">
                    ${st.extraClay ? '&#10003; EXTRA CLAY ON' : '+ ADD EXTRA CLAY (single)'}
                </button>
            </div>`;
        }
        el.innerHTML = html;
    }

    function render() {
        if (!state.stands.length) return;
        if (state.activeIdx >= state.stands.length) state.activeIdx = state.stands.length - 1;
        const st = state.stands[state.activeIdx];

        document.getElementById('lock-icon').setAttribute('data-lucide', state.isLocked ? 'lock' : 'unlock');
        document.getElementById('app-container').style.opacity = state.isLocked ? '0.6' : '1';
        document.getElementById('undo-btn').style.display = history ? 'flex' : 'none';

        let sTotalShot = 0, sTotalPossible = 0;
        state.stands.forEach(s => {
            const total = standTargets(s);
            sTotalPossible += total * state.shooters.length;
            state.shooters.forEach(sh => {
                if (state.hits[sh.id]?.[s.id]) sTotalShot += state.hits[sh.id][s.id].filter(h => h !== null).length;
            });
        });
        document.getElementById('progress-bar').style.width = sTotalPossible > 0 ? `${(sTotalShot / sTotalPossible) * 100}%` : '0%';

        renderHistory();

        // Setup values
        document.getElementById('field-ground').value = state.ground || '';
        document.getElementById('field-date').value = state.date || '';
        document.getElementById('field-event').value = state.event || '';
        document.getElementById('field-notes').value = state.notes || '';
        if (D.editable.standCount) {
            document.getElementById('field-stand-count').value = state.stands.length;
        } else {
            const totalTargets = state.stands.reduce((sum, s) => sum + standTargets(s), 0);
            document.getElementById('field-format').innerText = `${state.stands.length} ${D.standLabel}s / ${totalTargets} Targets`;
        }

        // Squad
        const list = document.getElementById('squad-list'); list.innerHTML = '';
        state.shooters.forEach((s, i) => {
            const div = document.createElement('div');
            div.className = 'bg-white p-2.5 rounded-xl border border-slate-200 shadow-sm squad-grid-item';
            div.innerHTML = `<span class="text-[9px] font-black text-slate-300">${i + 1}</span>
                <input type="text" value="${s.name}" maxlength="20" placeholder="Name" onchange="updateShooter(${i}, 'name', this.value)" class="bg-transparent border-none p-0 text-[11px] font-black outline-none w-full">
                <input type="text" value="${s.cpsa}" maxlength="8" placeholder="CPSA #" onchange="updateShooter(${i}, 'cpsa', this.value)" class="bg-slate-50 p-1 text-[9px] rounded font-bold w-full border border-slate-100">
                <select onchange="updateShooter(${i}, 'class', this.value)" class="text-[9px] font-black bg-slate-50 rounded p-1 border border-slate-100">${CLASSES.map(c => `<option ${s.class === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
                <button onclick="removeShooter(${s.id})" class="text-red-400 flex justify-center"><i data-lucide="x" size="16"></i></button>`;
            list.appendChild(div);
        });

        // Stand nav
        const navDiv = document.getElementById('stand-nav'); navDiv.innerHTML = '';
        state.stands.forEach((s, i) => {
            const btn = document.createElement('button');
            btn.className = `flex-shrink-0 w-11 h-11 rounded-xl font-black text-xs border-2 transition-all ${state.activeIdx === i ? 'bg-orange-500 border-orange-500 text-white shadow-lg' : 'bg-white border-slate-200 text-slate-500'}`;
            btn.innerText = s.id;
            btn.onclick = () => { if (!state.isLocked) { state.activeIdx = i; render(); save(); } };
            navDiv.appendChild(btn);
        });

        // Active header
        document.getElementById('active-stand-title').innerText = `${D.standLabel} ${st.id}`;
        const total = standTargets(st);
        document.getElementById('active-stand-targets').innerText = `${total} Target${total !== 1 ? 's' : ''}${st.extraClay ? ' (+1)' : ''}`;
        renderScoringControls();

        // Scoring rows (rotated first-up if enabled)
        const n = state.shooters.length;
        const leadIdx = ROTATE ? (state.activeIdx % n) : 0;
        const sArea = document.getElementById('scoring-area'); sArea.innerHTML = '';

        for (let i = 0; i < n; i++) {
            const s = state.shooters[(i + leadIdx) % n];
            const hits = state.hits[s.id]?.[st.id] || Array(total).fill(null);
            const count = hits.filter(h => h === true).length;
            const row = document.createElement('div');
            row.className = `p-2.5 space-y-1.5 ${i === 0 && ROTATE ? 'bg-orange-50/40 first-up-highlight' : ''} ${state.isLocked ? 'pointer-events-none' : ''}`;

            let gridHtml = '';
            for (let p = 0; p < total; p += 2) {
                const hasSecond = (p + 1) < total;
                const b1 = hits[p], b2 = hits[p + 1];
                const isExtra1 = st.extraClay && p === total - 1;
                const isExtra2 = st.extraClay && (p + 1) === total - 1;
                const label1 = st.labels?.[p] ?? (isExtra1 ? '+1' : '');
                const label2 = hasSecond ? (st.labels?.[p + 1] ?? (isExtra2 ? '+1' : '')) : '';
                const pairClass = (isExtra1 || isExtra2) ? 'pair-stack pair-extra' : 'pair-stack';
                gridHtml += `<div class="${pairClass}">
                    <div class="flex gap-1">
                        <button onclick="toggleHit(${s.id},${st.id},${p},true)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${b1 === true ? 'hit-bg' : 'bg-white border-slate-300 text-slate-400'}">H</button>
                        ${hasSecond ? `<button onclick="toggleHit(${s.id},${st.id},${p + 1},true)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${b2 === true ? 'hit-bg' : 'bg-white border-slate-300 text-slate-400'}">H</button>` : `<div class="flex-1"></div>`}
                    </div>
                    <div class="flex gap-1">
                        <button onclick="toggleHit(${s.id},${st.id},${p},false)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${b1 === false ? 'miss-bg' : 'bg-white border-slate-300 text-slate-400'}">M</button>
                        ${hasSecond ? `<button onclick="toggleHit(${s.id},${st.id},${p + 1},false)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${b2 === false ? 'miss-bg' : 'bg-white border-slate-300 text-slate-400'}">M</button>` : `<div class="flex-1"></div>`}
                    </div>
                    ${(label1 || label2) ? `<div class="flex gap-1 text-[7px] font-black text-slate-500 text-center uppercase pt-0.5">
                        <div class="flex-1">${label1}</div>
                        ${hasSecond ? `<div class="flex-1">${label2}</div>` : `<div class="flex-1"></div>`}
                    </div>` : ''}
                </div>`;
            }

            row.innerHTML = `<div class="flex justify-between items-center px-1">
                <div class="flex items-center gap-1.5">
                    <span class="text-[11px] font-black uppercase truncate max-w-[140px] tracking-tight">${s.name}</span>
                    ${i === 0 && ROTATE ? '<span class="bg-orange-500 text-white text-[6px] px-1 rounded-full font-black uppercase">First Up</span>' : ''}
                </div>
                <div class="text-base font-black italic text-slate-900">${count}<span class="text-slate-300 text-[8px] not-italic ml-0.5">/${total}</span></div>
            </div>
            <div class="flex gap-1 w-full overflow-x-hidden">${gridHtml}</div>`;
            sArea.appendChild(row);
        }

        // Leaderboard
        const lbHeader = document.getElementById('lb-header');
        lbHeader.innerHTML = `<th class="p-2 border-b text-left w-12 tracking-tighter">${D.standLabel.slice(0, 3).toUpperCase()}</th>`;
        const perf = state.shooters.map(sh => {
            let totalH = 0, totalAtt = 0;
            state.stands.forEach(stnd => {
                if (state.hits[sh.id]?.[stnd.id]) {
                    totalH += state.hits[sh.id][stnd.id].filter(h => h === true).length;
                    totalAtt += state.hits[sh.id][stnd.id].filter(h => h !== null).length;
                }
            });
            return { ...sh, t: totalH, att: totalAtt, isStraight: totalH === totalAtt && totalH > 0 };
        }).sort((a, b) => b.t - a.t);
        perf.forEach(sh => {
            lbHeader.innerHTML += `<th class="p-1 border-b border-l border-slate-200 text-center align-bottom"><div class="break-words leading-tight min-w-[50px]">${sh.isStraight ? '&#128293;<br>' : ''}${sh.name}</div></th>`;
        });

        const lbBody = document.getElementById('lb-body'); lbBody.innerHTML = '';
        const stAvgs = state.stands.map(stand => {
            let hitC = 0, attC = 0;
            state.shooters.forEach(sh => {
                if (state.hits[sh.id]?.[stand.id]) {
                    hitC += state.hits[sh.id][stand.id].filter(h => h === true).length;
                    attC += standTargets(stand);
                }
            });
            return { id: stand.id, avg: attC > 0 ? hitC / attC : 1 };
        });
        const hardId = stAvgs.slice().sort((a, b) => a.avg - b.avg)[0]?.id;

        state.stands.forEach((stand, idx) => {
            let row = `<td class="p-2 font-bold border-b text-slate-400 text-[8px]">${D.standLabel.slice(0, 2).toUpperCase()} ${stand.id}${stand.extraClay ? '+1' : ''} ${stand.id === hardId && sTotalShot > 0 ? '&#10071;' : ''}</td>`;
            perf.forEach(sh => { row += `<td class="p-2 text-center border-b border-l border-slate-100 font-black">${state.hits[sh.id]?.[stand.id]?.filter(h => h === true).length || 0}</td>`; });
            const tr = document.createElement('tr');
            tr.className = state.activeIdx === idx ? 'bg-orange-50' : '';
            tr.innerHTML = row;
            lbBody.appendChild(tr);
        });

        const f = document.getElementById('lb-footer');
        let fRow = `<tr class="bg-slate-900 text-white font-black"><td class="p-2 uppercase text-[7px]">Total</td>`;
        perf.forEach(sh => fRow += `<td class="p-2 text-center text-sm border-l border-slate-700">${sh.t}</td>`);
        f.innerHTML = fRow + '</tr>';

        document.getElementById('nav-prev').disabled = state.activeIdx === 0;
        document.getElementById('nav-next').disabled = state.activeIdx === state.stands.length - 1;

        if (window.lucide) lucide.createIcons();
    }

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed', err));
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        state = makeDefaultState();
        mountSkeleton();
        // History rows are re-rendered as innerHTML, so we delegate clicks from the stable parent.
        document.getElementById('history-section').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-history-action]');
            if (!btn) return;
            const key = btn.dataset.historyKey;
            const action = btn.dataset.historyAction;
            if (action === 'load') window.loadRound(key);
            else if (action === 'delete') window.deleteRound(key);
        });
        load();
        // Make sure a loaded named round is present in the history dict — otherwise a
        // previous session's typing (which no longer writes history on every keystroke)
        // could leave state named but history empty until the user next mutates something.
        if (isNamedRound(state)) save();
        render();
    });
})();
