/* ClayScorer — import scorecard photos (import.html).
 *
 * 1. Pick the discipline, add photos (phone photo library / camera / files / drag and drop),
 *    name the round.
 * 2. "Read scorecards" downscales the photos and sends them to the server (/api/scorecards/read),
 *    which reads them with Claude and returns a clay-by-clay transcription of every card.
 * 3. Review: each card's grid is editable (tap a clay to cycle hit / miss / not shot), doubtful
 *    marks are flagged, counted totals are checked against the written ones, and each card is
 *    matched to a regular shooter where the names match.
 * 4. "Create round" leaves the reviewed data in localStorage ('clayscorer:pending-import') and
 *    opens the discipline page, which builds the round (scorer.js applyPendingImport). English
 *    Sporting stands get the highest clay count seen on any card for that stand.
 */
(function () {
    'use strict';

    const DISCIPLINES = [
        { id: 'sporting', code: 'ESP', name: 'English Sporting', stand: 'Stand', fixed: null },
        { id: 'sportrap', code: 'STR', name: 'Sportrap', stand: 'Round', fixed: [5, 5, 5, 5, 5] },
        { id: 'compak', code: 'CSP', name: 'Compak Sporting', stand: 'Round', fixed: [5, 5, 5, 5, 5] },
        { id: 'skeet', code: 'ESK', name: 'English Skeet', stand: 'Station', fixed: [4, 4, 2, 4, 2, 4, 4], option: true }
    ];
    const MAX_SHOOTERS = 10;
    const MAX_PHOTOS = 12;
    const ESP_MIN = 4, ESP_MAX = 12;           // targets per stand the scorer supports (2–6 pairs) + an optional +1
    const CLASSES = ['AAA', 'AA', 'A', 'B', 'C', 'U'];
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const root = () => document.getElementById('import-root');
    const disc = () => DISCIPLINES.find(d => d.id === S.discipline) || null;

    const S = {
        discipline: new URLSearchParams(location.search).get('discipline') || '',
        photos: [],                 // { id, file, url }
        ground: '', event: '', date: todayIso(),
        status: null,               // { available, signedIn }
        reading: false,
        error: '',
        notes: '',
        cards: null,                // review data
        regulars: []
    };
    if (!DISCIPLINES.some(d => d.id === S.discipline)) S.discipline = '';

    // ---------------------------------------------------------------- server + regulars

    async function api(method, path, body) {
        const res = await fetch(path, {
            method, credentials: 'same-origin',
            headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-ClayScorer': '1' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let data = null;
        try { data = await res.json(); } catch (e) {}
        if (!res.ok || !data) { const err = new Error(data?.error || `Server error (${res.status})`); err.status = res.status; throw err; }
        return data;
    }

    async function loadRegulars() {
        let local = { items: [], updatedAt: 0 };
        try { const v = JSON.parse(localStorage.getItem('clayscorer:regulars') || 'null'); if (v && Array.isArray(v.items)) local = v; } catch (e) {}
        let best = local;
        if (S.status?.signedIn) {
            try {
                const remote = await api('GET', '/api/regulars');
                if (remote.regulars && remote.updatedAt > (local.updatedAt || 0)) best = { items: remote.regulars, updatedAt: remote.updatedAt };
            } catch (e) {}
        }
        S.regulars = (best.items || []).filter(r => String(r.name || '').trim()).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    }

    // Match a name read from a card to a regular: exact (ignoring case and punctuation), then
    // "initial + surname" / "first name + surname initial", then a unique surname or first name.
    const normName = (s) => String(s || '').toLowerCase().replace(/[.,']/g, ' ').replace(/\s+/g, ' ').trim();
    function matchRegular(name) {
        const n = normName(name);
        if (!n) return null;
        const regs = S.regulars.map(r => ({ r, n: normName(r.name), t: normName(r.name).split(' ') }));
        const exact = regs.filter(x => x.n === n);
        if (exact.length === 1) return exact[0].r;
        const t = n.split(' ');
        const unique = (list) => (list.length === 1 ? list[0].r : null);
        if (t.length >= 2) {
            const first = t[0], last = t[t.length - 1];
            const byInitial = regs.filter(x => x.t.length >= 2 && x.t[x.t.length - 1] === last && x.t[0][0] === first[0]);
            if (unique(byInitial)) return unique(byInitial);
            const bySurnameInitial = regs.filter(x => x.t.length >= 2 && x.t[0] === first && x.t[x.t.length - 1][0] === last[0]);
            if (unique(bySurnameInitial)) return unique(bySurnameInitial);
        }
        if (t.length === 1) {
            const bySurname = regs.filter(x => x.t[x.t.length - 1] === t[0]);
            if (unique(bySurname)) return unique(bySurname);
            const byFirst = regs.filter(x => x.t[0] === t[0]);
            if (unique(byFirst)) return unique(byFirst);
        }
        return null;
    }

    // ---------------------------------------------------------------- photos

    function addFiles(files) {
        const list = Array.from(files || []).filter(f => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
        for (const f of list) {
            if (S.photos.length >= MAX_PHOTOS) { toast(`At most ${MAX_PHOTOS} photos at a time.`, 'error'); break; }
            S.photos.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, file: f, url: URL.createObjectURL(f) });
        }
        render();
    }

    // Downscale to at most 2000 px on the long edge as JPEG: plenty for reading pen marks, and
    // keeps uploads small. The browser applies the photo's EXIF rotation when decoding.
    async function preparePhoto(p) {
        const img = new Image();
        img.src = p.url;
        try { await img.decode(); } catch (e) { throw new Error(`“${p.file.name}” couldn’t be opened here. If it’s an HEIC photo, export it as JPEG first.`); }
        const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
        const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
        return { media_type: 'image/jpeg', data };
    }

    async function readCards() {
        if (!S.discipline || !S.photos.length || S.reading) return;
        S.reading = true; S.error = ''; render();
        try {
            const images = [];
            for (const p of S.photos) images.push(await preparePhoto(p));
            const result = await api('POST', '/api/scorecards/read', { discipline: S.discipline, images });
            await loadRegulars();
            S.notes = result.notes || '';
            S.cards = (result.cards || []).map(c => {
                const reg = matchRegular(c.shooter_name);
                const amb = {};
                (c.ambiguous || []).forEach(a => { amb[`${a.stand}-${a.clay}`] = a.reason || 'Unclear mark'; });
                const stands = (c.stands || []).slice().sort((a, b) => a.stand - b.stand).map(s => ({ marks: (s.marks || []).map(m => (m === 'H' || m === 'M' ? m : '-')), written: String(s.written_score || '').trim() }));
                return {
                    include: true, image: c.image, readName: c.shooter_name || '', cardNumber: c.card_number || '',
                    writtenTotal: String(c.written_total || '').trim(), writtenSub: String(c.written_subtotals || '').trim(),
                    stands, amb, regularId: reg ? reg.id : '', newName: c.shooter_name || '', autoMatched: !!reg
                };
            });
            if (!S.ground && result.cards?.[0]?.ground) S.ground = result.cards[0].ground;
            if (!S.cards.length) S.error = 'No scorecards were found in these photos.';
        } catch (err) {
            S.error = err.message || 'Something went wrong reading the scorecards.';
        } finally {
            S.reading = false;
            render();
            if (S.cards?.length) document.getElementById('review')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // ---------------------------------------------------------------- layout + checks

    const included = () => (S.cards || []).filter(c => c.include);
    // Highest number of clays seen on each stand, across the included cards.
    function standClays() {
        const out = [];
        included().forEach(c => c.stands.forEach((s, i) => { out[i] = Math.max(out[i] || 0, s.marks.length); }));
        return out.map(n => n || 0);
    }
    const hits = (marks) => marks.filter(m => m === 'H').length;
    const toInt = (s) => { const m = String(s || '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };

    function layoutHtml() {
        const d = disc();
        const counts = standClays();
        const warnings = [];
        let summary;
        if (!d.fixed) {
            const parts = counts.map((n, i) => {
                const extra = n % 2 === 1, t = extra ? n - 1 : n;
                if (n && t < ESP_MIN) warnings.push(`${d.stand} ${i + 1}: only ${n} clay${n === 1 ? '' : 's'} on the cards — the round will have ${ESP_MIN} (the rest left unshot).`);
                if (t > ESP_MAX) warnings.push(`${d.stand} ${i + 1}: ${n} clays is more than the app supports (${ESP_MAX}+1); the extra clays won't be imported.`);
                return `<span class="inline-block rounded-md bg-slate-100 border border-slate-300 px-2 py-1 m-0.5 text-sm"><strong>${i + 1}</strong>: ${n}${extra ? ` <span class="text-slate-500">(${t / 2} pairs +1)</span>` : ` <span class="text-slate-500">(${t / 2} pairs)</span>`}</span>`;
            });
            if (counts.length > 20) warnings.push('More than 20 stands — only the first 20 will be imported.');
            summary = `<div class="text-sm text-slate-700 mb-1">${counts.length} ${d.stand.toLowerCase()}${counts.length === 1 ? '' : 's'} — clays per ${d.stand.toLowerCase()} (the highest on any card):</div><div>${parts.join('')}</div>`;
        } else {
            summary = `<div class="text-sm text-slate-700">${d.name} uses a fixed layout: ${d.fixed.length} ${d.stand.toLowerCase()}s of ${[...new Set(d.fixed)].join('/')} targets${d.option ? ' plus the option target' : ''}.</div>`;
            included().forEach(c => {
                const who = c.newName || c.readName || 'A card';
                if (c.stands.length > d.fixed.length) warnings.push(`${who}: ${c.stands.length} ${d.stand.toLowerCase()}s on the card — only the first ${d.fixed.length} will be imported.`);
                c.stands.forEach((s, i) => {
                    const allowed = (d.fixed[i] || 0) + (d.option ? 1 : 0);
                    if (i < d.fixed.length && s.marks.length > allowed) warnings.push(`${who}, ${d.stand.toLowerCase()} ${i + 1}: ${s.marks.length} clays, but this ${d.stand.toLowerCase()} has ${d.fixed[i]}${d.option ? ' (+ option)' : ''}.`);
                });
            });
        }
        if (included().length > MAX_SHOOTERS) warnings.push(`A round holds up to ${MAX_SHOOTERS} shooters — only the first ${MAX_SHOOTERS} included cards will be imported.`);
        return `${summary}${warnings.length ? `<ul class="mt-2 space-y-1 text-sm text-amber-800">${warnings.map(w => `<li>⚠ ${esc(w)}</li>`).join('')}</ul>` : ''}`;
    }

    function cardHtml(c, ci) {
        const d = disc();
        const counted = c.stands.reduce((a, s) => a + hits(s.marks), 0);
        const wTotal = toInt(c.writtenTotal);
        const totalOk = wTotal === null ? null : wTotal === counted;
        const used = new Set((S.cards || []).filter((x, j) => j !== ci && x.include && x.regularId).map(x => x.regularId));
        const options = S.regulars.map(r => `<option value="${esc(r.id)}" ${c.regularId === r.id ? 'selected' : ''} ${used.has(r.id) ? 'disabled' : ''}>${esc(r.name)}${used.has(r.id) ? ' — on another card' : ''}</option>`).join('');
        const ambCount = Object.keys(c.amb).length;
        return `<section class="bg-white rounded-xl shadow border ${c.include ? 'border-slate-300' : 'border-slate-200 opacity-60'} p-3 space-y-2" data-card="${ci}">
            <div class="flex items-center justify-between gap-2">
                <div class="text-xs font-bold uppercase tracking-wider text-slate-700">Card ${ci + 1}${c.cardNumber ? ` · no. ${esc(c.cardNumber)}` : ''} <span class="normal-case font-semibold text-slate-500">· photo ${esc(c.image)}</span></div>
                <label class="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><input type="checkbox" data-act="include" ${c.include ? 'checked' : ''}> Include</label>
            </div>
            <div class="text-sm text-slate-700">Name on card: <strong>${esc(c.readName || '—')}</strong></div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">Shooter</span>
                    <select data-act="regular" class="block w-full h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold">
                        <option value="">New shooter (not a regular)</option>${options}
                    </select></label>
                ${c.regularId ? `<div class="text-sm self-end pb-2 ${c.autoMatched ? 'text-emerald-700' : 'text-slate-700'}">${c.autoMatched ? '✓ Matched to a regular shooter' : 'Regular shooter chosen'} — CPSA no., class and gear come from the regular.</div>`
                    : `<label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">Name for the round</span><input type="text" data-act="newName" value="${esc(c.newName)}" maxlength="40" class="block w-full h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold"></label>`}
            </div>
            <div class="space-y-1.5">${c.stands.map((s, si) => {
                const w = toInt(s.written);
                const ok = w === null ? null : w === hits(s.marks);
                return `<div class="flex gap-2 items-start">
                    <div class="w-12 flex-shrink-0 pt-1.5 text-xs font-semibold text-slate-600 whitespace-nowrap">${d.stand.slice(0, 3)} ${si + 1}</div>
                    <div class="min-w-0">
                        <div class="flex flex-wrap gap-1">${s.marks.map((m, k) => {
                            const reason = c.amb[`${si + 1}-${k + 1}`];
                            const cls = m === 'H' ? 'bg-green-500 text-white border-green-600' : m === 'M' ? 'bg-red-500 text-white border-red-600' : 'bg-white text-slate-400 border-slate-300';
                            return `<button type="button" data-act="cell" data-s="${si}" data-k="${k}" title="${reason ? esc(`Doubtful: ${reason}`) : 'Tap to change'}" aria-label="${d.stand} ${si + 1} clay ${k + 1}: ${m === 'H' ? 'hit' : m === 'M' ? 'miss' : 'not shot'}${reason ? ' (doubtful)' : ''}" class="w-8 h-8 rounded-md border-2 text-xs font-black ${cls} ${reason ? 'ring-2 ring-amber-400 ring-offset-1' : ''}">${m === 'H' ? 'H' : m === 'M' ? 'M' : '·'}</button>`;
                        }).join('')}</div>
                        <div class="text-[11px] mt-0.5 ${ok === false ? 'text-red-700 font-bold' : 'text-slate-500'}">${hits(s.marks)}/${s.marks.length}${s.written ? ` · card says ${esc(s.written)} ${ok ? '✓' : '✗ — check'}` : ''}${Object.keys(c.amb).filter(key => key.startsWith(`${si + 1}-`)).map(key => ` · clay ${key.split('-')[1]}: ${esc(c.amb[key])}`).join('')}</div>
                    </div>
                </div>`;
            }).join('')}</div>
            <div class="text-sm ${totalOk === false ? 'text-red-700 font-bold' : 'text-slate-700'}">Total: ${counted} hits${c.writtenTotal ? ` · card says ${esc(c.writtenTotal)} ${totalOk ? '✓' : '✗'}` : ''}${c.writtenSub ? ` · sub-totals on card: ${esc(c.writtenSub)}` : ''}</div>
            ${ambCount ? `<div class="text-xs text-amber-800">⚠ ${ambCount} doubtful mark${ambCount === 1 ? '' : 's'} (amber outline) — check against the photo. Tap a clay to change it.</div>` : '<div class="text-xs text-slate-500">Tap a clay to change it: hit → miss → not shot.</div>'}
        </section>`;
    }

    // ---------------------------------------------------------------- render

    function render() {
        const d = disc();
        const st = S.status;
        const ready = d && S.photos.length && st?.available && st?.signedIn && !S.reading;
        const card = 'bg-white rounded-xl shadow border border-slate-300 p-3';
        const head = 'text-xs font-bold uppercase tracking-wider text-slate-700 mb-2';
        const field = 'block w-full h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold';
        root().innerHTML = `
            ${st && !st.available ? `<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Reading scorecard photos isn’t set up on this server yet. The administrator needs to add an Anthropic API key (<code>ANTHROPIC_API_KEY</code>) — see SELF_HOSTING.md.</div>` : ''}
            ${st && st.available && !st.signedIn ? `<div class="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Sign in to read scorecards: <a class="font-bold underline" href="users.html">Account &amp; users</a>, then come back here.</div>` : ''}
            <section class="${card}">
                <div class="${head}">1. Discipline</div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    ${DISCIPLINES.map(x => `<button type="button" data-act="discipline" data-id="${x.id}" aria-pressed="${S.discipline === x.id}" class="flex items-center gap-2 rounded-xl border-2 p-2 text-left ${S.discipline === x.id ? 'border-orange-500 bg-orange-50' : 'border-slate-300 bg-white'}">
                        <span class="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-orange-500 text-white rounded-lg">${window.ClayIcons ? ClayIcons.svg(x.id, 'w-6 h-6') : ''}</span>
                        <span class="min-w-0"><span class="block text-xs font-black text-orange-600 tracking-widest">${x.code}</span><span class="block text-sm font-bold leading-tight">${x.name}</span></span>
                    </button>`).join('')}
                </div>
            </section>
            <section class="${card}">
                <div class="${head}">2. Scorecard photos</div>
                <label data-drop class="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-400 bg-slate-50 p-4 text-center cursor-pointer hover:bg-orange-50">
                    <span class="text-2xl" aria-hidden="true">📷</span>
                    <span class="text-sm font-bold text-slate-800">Add photos</span>
                    <span class="text-xs text-slate-600">From your photo library or camera, or choose image files. On a computer you can drop them here.</span>
                    <input type="file" accept="image/*" multiple data-act="files" class="sr-only">
                </label>
                ${S.photos.length ? `<div class="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2">${S.photos.map((p, i) => `<div class="relative rounded-lg overflow-hidden border border-slate-300 bg-slate-100">
                        <img src="${p.url}" alt="Photo ${i + 1}" class="w-full h-28 object-cover">
                        <span class="absolute left-1 top-1 rounded bg-slate-900/80 text-white text-[11px] font-bold px-1.5">${i + 1}</span>
                        <button type="button" data-act="remove" data-id="${p.id}" aria-label="Remove photo ${i + 1}" class="absolute right-1 top-1 w-7 h-7 rounded-full bg-white/90 text-red-600 font-black">×</button>
                    </div>`).join('')}</div>` : ''}
                <p class="mt-2 text-xs text-slate-500">Up to ${MAX_PHOTOS} photos, any number of cards in each. Photos are sent to the Anthropic API to be read and aren’t kept.</p>
            </section>
            <section class="${card}">
                <div class="${head}">3. Round</div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">Shooting ground</span><input type="text" data-act="ground" value="${esc(S.ground)}" placeholder="e.g. West Wycombe" class="${field}"></label>
                    <label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">Date</span><input type="date" data-act="date" value="${esc(S.date)}" class="${field}"></label>
                    <label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">Event name</span><input type="text" data-act="event" value="${esc(S.event)}" placeholder="e.g. Club Championship" class="${field}"></label>
                </div>
                <button type="button" data-act="read" ${ready ? '' : 'disabled'} class="mt-3 w-full h-12 rounded-xl bg-orange-500 text-white text-sm font-bold disabled:opacity-40">${S.reading ? 'Reading scorecards… (this can take a minute)' : (S.cards ? 'Read the photos again' : 'Read scorecards')}</button>
                ${S.error ? `<p class="mt-2 text-sm font-semibold text-red-700">${esc(S.error)}</p>` : ''}
            </section>
            ${S.cards && S.cards.length ? `
            <div id="review" class="space-y-3">
                <section class="${card}">
                    <div class="${head}">4. Check the cards</div>
                    ${S.notes ? `<p class="text-sm text-slate-700 mb-2">${esc(S.notes)}</p>` : ''}
                    ${layoutHtml()}
                </section>
                ${S.cards.map(cardHtml).join('')}
                <section class="${card}">
                    <button type="button" data-act="create" class="w-full h-12 rounded-xl bg-slate-900 text-white text-sm font-bold">Create ${d ? d.name : ''} round from ${Math.min(included().length, MAX_SHOOTERS)} card${included().length === 1 ? '' : 's'}</button>
                    <p class="mt-2 text-xs text-slate-500">You can still change anything in the round afterwards.</p>
                </section>
            </div>` : ''}`;
    }

    // ---------------------------------------------------------------- create

    function createRound() {
        const d = disc();
        const cards = included().slice(0, MAX_SHOOTERS);
        if (!cards.length) return toast('Include at least one card.', 'error');
        if (!S.ground.trim() && !S.event.trim()) { toast('Enter a ground or event name for the round.', 'error'); document.querySelector('[data-act="ground"]')?.focus(); return; }
        const regById = Object.fromEntries(S.regulars.map(r => [r.id, r]));
        const conv = (m) => (m === 'H' ? true : m === 'M' ? false : null);
        const shooters = cards.map((c, i) => {
            const reg = c.regularId ? regById[c.regularId] : null;
            return {
                name: reg ? reg.name : (c.newName.trim() || c.readName.trim() || `Shooter ${i + 1}`),
                cpsa: reg?.cpsa || '', class: reg?.class && CLASSES.includes(reg.class) ? reg.class : 'U',
                gun: reg?.gun || '', cartridges: reg?.cartridges || '',
                stands: c.stands.map(s => s.marks.map(conv))
            };
        });
        const payload = {
            discipline: d.id, ground: S.ground.trim(), event: S.event.trim(), date: S.date,
            standClays: d.fixed ? d.fixed.slice() : standClays(),
            shooters, createdAt: Date.now()
        };
        try { localStorage.setItem('clayscorer:pending-import', JSON.stringify(payload)); }
        catch (e) { return toast('Couldn’t save the import on this device.', 'error'); }
        location.href = `${d.id}.html`;
    }

    // ---------------------------------------------------------------- events

    function onClick(e) {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        if (act === 'discipline') { S.discipline = el.dataset.id; S.cards = null; S.error = ''; render(); }
        else if (act === 'remove') {
            const p = S.photos.find(x => x.id === el.dataset.id);
            if (p) URL.revokeObjectURL(p.url);
            S.photos = S.photos.filter(x => x.id !== el.dataset.id);
            render();
        }
        else if (act === 'read') readCards();
        else if (act === 'create') createRound();
        else if (act === 'cell') {
            const ci = Number(el.closest('[data-card]').dataset.card);
            const s = S.cards[ci].stands[Number(el.dataset.s)];
            const k = Number(el.dataset.k);
            s.marks[k] = s.marks[k] === 'H' ? 'M' : s.marks[k] === 'M' ? '-' : 'H';
            delete S.cards[ci].amb[`${Number(el.dataset.s) + 1}-${k + 1}`];
            render();
        }
    }
    function onChange(e) {
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        const ci = el.closest('[data-card]') ? Number(el.closest('[data-card]').dataset.card) : -1;
        if (act === 'files') { addFiles(el.files); el.value = ''; }
        else if (act === 'include') { S.cards[ci].include = el.checked; render(); }
        else if (act === 'regular') { S.cards[ci].regularId = el.value; S.cards[ci].autoMatched = false; render(); }
        else if (act === 'newName') S.cards[ci].newName = el.value;
        else if (act === 'ground' || act === 'event' || act === 'date') S[act] = el.value;
    }
    function onInput(e) {
        const el = e.target.closest('[data-act]');
        if (el && (el.dataset.act === 'ground' || el.dataset.act === 'event')) S[el.dataset.act] = el.value;
        if (el && el.dataset.act === 'newName') S.cards[Number(el.closest('[data-card]').dataset.card)].newName = el.value;
    }

    let toastTimer = null;
    function toast(message, tone = 'info') {
        const el = document.getElementById('toast');
        if (!el) return alert(message);
        el.textContent = message;
        el.className = `toast toast-${tone}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 5000);
    }

    document.addEventListener('DOMContentLoaded', async () => {
        const r = root();
        r.addEventListener('click', onClick);
        r.addEventListener('change', onChange);
        r.addEventListener('input', onInput);
        r.addEventListener('dragover', (e) => { if (e.target.closest('[data-drop]')) e.preventDefault(); });
        r.addEventListener('drop', (e) => { if (e.target.closest('[data-drop]')) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
        render();
        try { S.status = await api('GET', '/api/scorecards/status'); }
        catch (e) { S.status = { available: false, signedIn: false }; }
        await loadRegulars();
        render();
    });

    // Test hook (docs generator): show a reading result without photos.
    window.ClayImport = { _state: S, _render: render };
})();
