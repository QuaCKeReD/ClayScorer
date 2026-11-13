/* ClayScorer — Presentation deck (Export › Presentation).
 *
 * Builds a 16:9 slide deck from the current round: cover, squad, podium, milestones,
 * stand-by-stand grid, hit-rate and running-total charts, barrels, streaks, stand stories,
 * awards, a score check and a closing slide. Every number is computed here from the round
 * data (window.ClayScorerDeck.getData() in scorer.js); humour lines are templates driven by
 * those numbers — nothing is invented. Viewed in an in-app slideshow or printed to PDF
 * (one slide per page).
 */
(function () {
    'use strict';

    const W = 1920, H = 1080;
    const COLOURS = ['#fb923c', '#4ade80', '#60a5fa', '#facc15', '#f472b6', '#2dd4bf', '#a78bfa', '#f87171', '#a3e635', '#38bdf8'];
    const MARKERS = ['circle', 'square', 'triangle', 'diamond', 'down'];
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const pct = (h, n) => (n > 0 ? h / n : null);
    const fmtPct = (p) => (p === null || p === undefined ? '–' : `${Math.round(p * 100)}%`);
    const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const yyyymmdd = (iso) => (iso && iso.length >= 10 ? iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) : '');
    const ukDate = (iso) => (iso && iso.length >= 10 ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
    // Gap in percentage points between two rates, from the rounded figures shown on the slides.
    const ptsGap = (a, b) => Math.round((a ?? 0) * 100) - Math.round((b ?? 0) * 100);
    const joinNames = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} & ${list[list.length - 1]}`);

    // ---------------------------------------------------------------- analysis

    function analyse(data) {
        const SL = data.standLabel;
        const stands = data.stands;
        const nStands = stands.length;
        const standName = (si) => `${SL} ${stands[si].id}`;

        const shooters = data.shooters.map((sh, k) => {
            const seq = [];          // card order, shot targets only
            const perStand = stands.map(() => ({ hits: 0, shot: 0, targets: 0 }));
            const barrel = { b1h: 0, b1n: 0, b2h: 0, b2n: 0, doubles: 0, blanks: 0, pairs: 0 };
            sh.stands.forEach((st, si) => {
                perStand[si].targets = st.hits.length;
                const kindAt = {};
                const barrelAt = {};
                st.groups.forEach(g => g.idx.forEach((idx, j) => {
                    kindAt[idx] = g.kind;
                    barrelAt[idx] = g.idx.length === 2 ? j + 1 : 0;
                }));
                st.hits.forEach((h, i) => {
                    if (h === null) return;
                    perStand[si].shot++;
                    if (h) perStand[si].hits++;
                    seq.push({ si, clay: i + 1, hit: h, kind: kindAt[i] || 'single', barrel: barrelAt[i] || 0 });
                });
                st.groups.filter(g => g.idx.length === 2).forEach(g => {
                    const [a, b] = g.idx.map(i => st.hits[i]);
                    if (a !== null) { barrel.b1n++; if (a) barrel.b1h++; }
                    if (b !== null) { barrel.b2n++; if (b) barrel.b2h++; }
                    if (a !== null && b !== null) {
                        barrel.pairs++;
                        if (a && b) barrel.doubles++;
                        if (!a && !b) barrel.blanks++;
                    }
                });
                // Skeet option target: counted on the station it was taken, after that station's targets.
                if (sh.option && sh.option.standId === stands[si].id) {
                    perStand[si].shot++;
                    perStand[si].targets++;
                    if (sh.option.hit) perStand[si].hits++;
                    seq.push({ si, clay: 'OPT', hit: sh.option.hit, kind: 'option', barrel: 0 });
                }
            });
            const hits = sum(perStand.map(p => p.hits));
            const shot = sum(perStand.map(p => p.shot));
            const scheduled = sum(stands.map(s => s.targets)) + (data.optionLabel ? 1 : 0);
            let cum = 0;
            const cumulative = perStand.map(p => (cum += p.hits));
            const standPcts = perStand.map(p => pct(p.hits, p.shot));
            return {
                k, id: sh.id, name: sh.name, cpsa: sh.cpsa, gun: sh.gun, cartridges: sh.cartridges,
                colour: COLOURS[k % COLOURS.length], marker: MARKERS[k % MARKERS.length],
                seq, perStand, standPcts, hits, shot, misses: shot - hits, rate: pct(hits, shot),
                unshot: Math.max(0, scheduled - shot - (data.optionLabel && !sh.option ? 1 : 0)),
                scheduled, cumulative, barrel,
                hitStreak: longestRun(seq, true), missStreak: longestRun(seq, false),
                rawStands: sh.stands
            };
        });

        const ranked = shooters.slice().sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.hits - a.hits);
        const squad = {
            hits: sum(shooters.map(s => s.hits)),
            shot: sum(shooters.map(s => s.shot)),
            perStand: stands.map((_, si) => {
                const h = sum(shooters.map(s => s.perStand[si].hits)), n = sum(shooters.map(s => s.perStand[si].shot));
                return { hits: h, shot: n, rate: pct(h, n) };
            })
        };
        squad.rate = pct(squad.hits, squad.shot);
        squad.misses = squad.shot - squad.hits;
        squad.barrel = ['b1h', 'b1n', 'b2h', 'b2n', 'doubles', 'blanks', 'pairs']
            .reduce((o, key) => ({ ...o, [key]: sum(shooters.map(s => s.barrel[key])) }), {});

        // Milestones: "first k" = the first k clays of EVERY stand (not clay k in card order).
        const maxTargets = Math.max(...stands.map(s => s.targets));
        const ks = [6, 8, 10, 12].filter(k => k < maxTargets);
        const milestones = ks.map(k => {
            const scope = sum(stands.map(s => Math.min(k, s.targets)));
            const rows = shooters.map(s => {
                let h = 0, n = 0;
                s.rawStands.forEach(st => st.hits.slice(0, k).forEach(v => { if (v !== null) { n++; if (v) h++; } }));
                return { hits: h, shot: n, rate: pct(h, n) };
            });
            return { k, scope, rows, leaders: leadersBy(shooters, s => rows[s.k].rate) };
        });

        // Stand stories
        const standIdx = stands.map((_, i) => i).filter(si => squad.perStand[si].shot > 0);
        const best = standIdx.slice().sort((a, b) => squad.perStand[b].rate - squad.perStand[a].rate || a - b)[0];
        const worst = standIdx.slice().sort((a, b) => squad.perStand[a].rate - squad.perStand[b].rate || a - b)[0];
        let contrast = null;
        if (shooters.length > 1) {
            standIdx.forEach(si => {
                const present = shooters.filter(s => s.perStand[si].shot > 0);
                if (present.length < 2) return;
                const hi = present.slice().sort((a, b) => b.standPcts[si] - a.standPcts[si])[0];
                const lo = present.slice().sort((a, b) => a.standPcts[si] - b.standPcts[si])[0];
                const gap = hi.standPcts[si] - lo.standPcts[si];
                if (!contrast || gap > contrast.gap) contrast = { si, hi, lo, gap };
            });
            if (contrast && contrast.gap === 0) contrast = null;
        }

        const pairsExist = shooters.some(s => s.barrel.pairs > 0);
        return { data, SL, stands, nStands, standName, shooters, ranked, squad, milestones, best, worst, contrast, pairsExist, maxTargets };
    }

    function longestRun(seq, value) {
        let best = null, start = -1;
        for (let i = 0; i <= seq.length; i++) {
            const match = i < seq.length && seq[i].hit === value;
            if (match && start < 0) start = i;
            if (!match && start >= 0) {
                const len = i - start;
                if (!best || len > best.len) best = { len, from: seq[start], to: seq[i - 1] };
                start = -1;
            }
        }
        return best || { len: 0, from: null, to: null };
    }

    function leadersBy(list, valueOf) {
        const vals = list.map(valueOf).filter(v => v !== null && v !== undefined);
        if (!vals.length) return [];
        const top = Math.max(...vals);
        return list.filter(s => valueOf(s) === top);
    }

    const posText = (m, e) => (e ? (e.clay === 'OPT' ? `${m.standName(e.si)} option` : `${m.standName(e.si)} clay ${e.clay}`) : '');

    // ---------------------------------------------------------------- titles

    const VENUE_STOP = new Set(['the', 'shooting', 'ground', 'grounds', 'club', 'school', 'estate', 'clay', 'clays', 'sporting', 'centre', 'center', 'range', 'ranges', 'ltd', 'limited', 'and', '&', 'of', 'gun', 'guns', 'target', 'targets']);

    function venueWord(data) {
        const pick = (text) => String(text || '').split(/[\s,.\-–/]+/).find(w => w && !VENUE_STOP.has(w.toLowerCase()));
        const w = pick(data.ground) || pick(data.event) || data.discipline.name.split(' ').pop();
        return w.charAt(0).toUpperCase() + w.slice(1);
    }

    function titleSuggestions(m) {
        const v = venueWord(m.data);
        const r = m.squad.rate ?? 0;
        const date = yyyymmdd(m.data.date);
        let pool;
        if (r >= 0.8) pool = [`${v} Massacre`, `The ${v} Clean Sweep`, `Smoke on the ${v}`, `${v}: No Clay Left Behind`];
        else if (r >= 0.65) pool = [`${v} of Fury`, `The ${v} Strikes Back`, `Mostly Harmless at ${v}`, `${v} Rising`];
        else if (r >= 0.5) pool = [`The ${v} Wobble`, `${v}: A Game of Two Barrels`, `Half Measures at ${v}`, `${v} Coin Toss`];
        else pool = [`The ${v} Clay Sanctuary`, `${v} Survivors' Club`, `Carnage at ${v}`, `${v}: The Clays Strike Back`];
        if (m.ranked.length > 1) {
            const gap = ptsGap(m.ranked[0].rate, m.ranked[1].rate);
            if (gap <= 2) pool = [`Photo Finish at ${v}`, ...pool];
            else if (gap >= 15) pool = [`The ${v} Walkover`, ...pool];
        }
        return [...new Set(pool)].slice(0, 3).map(t => (date ? `${date} ${t}` : t));
    }

    // ---------------------------------------------------------------- humour (data-driven only)

    function coverGag(m) {
        const r = m.squad.rate ?? 0;
        const escaped = plural(m.squad.misses, 'clay');
        if (!m.squad.shot) return 'No clays were harmed. Yet.';
        if (r >= 0.8) return `The clays never stood a chance. Only ${escaped} escaped.`;
        if (r >= 0.65) return `Most clays were harmed in the making of this shoot. ${escaped} got away.`;
        if (r >= 0.5) return `A fair fight. The clays won ${m.squad.misses} rounds of it.`;
        return `${escaped} escaped unharmed and are still celebrating.`;
    }

    function squadRoast(m, s) {
        const n = m.ranked.length;
        const rank = m.ranked.indexOf(s);
        const p = fmtPct(s.rate);
        const valid = m.stands.map((_, si) => si).filter(si => s.perStand[si].shot > 0);
        const bestSi = valid.slice().sort((a, b) => s.standPcts[b] - s.standPcts[a])[0];
        const worstSi = valid.slice().sort((a, b) => s.standPcts[a] - s.standPcts[b])[0];
        if (!s.shot) return 'Turned up. Has not fired yet.';
        if (n > 1 && rank === 0) return s.gun ? `Top of the pile at ${p}. The ${s.gun} earned its keep.` : `Top of the pile at ${p}. Will mention it. Repeatedly.`;
        if (n > 1 && rank === n - 1) return s.gun ? `${p}. Not the ${s.gun}'s fault. Probably.` : `${p} — the clays' favourite shooter.`;
        if (bestSi !== undefined && worstSi !== undefined && s.standPcts[bestSi] - s.standPcts[worstSi] >= 0.4) {
            return `${fmtPct(s.standPcts[bestSi])} on ${m.standName(bestSi)}, ${fmtPct(s.standPcts[worstSi])} on ${m.standName(worstSi)}. Consistency is overrated.`;
        }
        return `A tidy ${p}. Solid, unspectacular, reliable.`;
    }

    function streakRoast(s) {
        const h = s.hitStreak.len, x = s.missStreak.len;
        const hot = h >= 15 ? 'Unplayable.' : h >= 8 ? 'Briefly unbeatable.' : h >= 4 ? 'A modest purple patch.' : 'Hot streak? Lukewarm at best.';
        const cold = x >= 5 ? 'The clays formed a support group.' : x >= 3 ? 'A proper wobble.' : x >= 1 ? 'Barely a blip.' : 'Never missed. Suspicious.';
        return `${hot} ${cold}`;
    }

    function closingGag(m) {
        if (m.ranked.length < 2) return m.ranked[0] ? `${m.ranked[0].name} wins. Unopposed, but a win is a win.` : '';
        const gap = ptsGap(m.ranked[0].rate, m.ranked[1].rate);
        const last = m.ranked[m.ranked.length - 1];
        if (gap <= 2) return `Photo finish: ${gap} point${gap === 1 ? '' : 's'} in it. Appeals to the scorer will be ignored.`;
        if (gap >= 15) return `${m.ranked[0].name} by ${gap} points — less a win, more a public service announcement.`;
        return `${m.ranked[0].name} by ${gap} points. ${last.name}: the clays have sent a thank-you card.`;
    }

    // ---------------------------------------------------------------- SVG helpers

    function marker(shape, x, y, r, fill) {
        const a = `fill="${fill}" stroke="#1c1410" stroke-width="3"`;
        if (shape === 'square') return `<rect x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" ${a}/>`;
        if (shape === 'triangle') return `<polygon points="${x},${y - r * 1.2} ${x + r * 1.1},${y + r * 0.9} ${x - r * 1.1},${y + r * 0.9}" ${a}/>`;
        if (shape === 'down') return `<polygon points="${x},${y + r * 1.2} ${x + r * 1.1},${y - r * 0.9} ${x - r * 1.1},${y - r * 0.9}" ${a}/>`;
        if (shape === 'diamond') return `<polygon points="${x},${y - r * 1.3} ${x + r * 1.3},${y} ${x},${y + r * 1.3} ${x - r * 1.3},${y}" ${a}/>`;
        return `<circle cx="${x}" cy="${y}" r="${r}" ${a}/>`;
    }

    function lineChart({ series, xLabels, yMax, yTicks, yFmt, yTitle, highlights = [], notes = [], height = 620 }) {
        const w = 1728, h = height;
        const L = 130, R = 90, T = 70, B = xLabels.length > 10 ? 120 : 90;
        const pw = w - L - R, ph = h - T - B;
        const n = xLabels.length;
        const xAt = (i) => L + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
        const yAt = (v) => T + ph - (ph * v) / yMax;
        const rotate = n > 10;
        let g = '';
        highlights.forEach(hl => {
            const half = n === 1 ? pw / 2 : pw / (n - 1) / 2;
            g += `<rect x="${xAt(hl.i) - half}" y="${T}" width="${2 * half}" height="${ph}" fill="${hl.fill}" opacity="0.18"/>`;
        });
        yTicks.forEach(v => {
            g += `<line x1="${L}" x2="${w - R}" y1="${yAt(v)}" y2="${yAt(v)}" stroke="#4a3a2e" stroke-width="2"/>`;
            g += `<text x="${L - 16}" y="${yAt(v) + 9}" text-anchor="end" font-size="24" fill="#d6c7b8">${esc(yFmt(v))}</text>`;
        });
        xLabels.forEach((lab, i) => {
            g += rotate
                ? `<text transform="translate(${xAt(i)},${T + ph + 30}) rotate(-35)" text-anchor="end" font-size="24" fill="#d6c7b8">${esc(lab)}</text>`
                : `<text x="${xAt(i)}" y="${T + ph + 40}" text-anchor="middle" font-size="24" fill="#d6c7b8">${esc(lab)}</text>`;
        });
        g += `<text transform="translate(34,${T + ph / 2}) rotate(-90)" text-anchor="middle" font-size="24" fill="#d6c7b8">${esc(yTitle)}</text>`;
        series.forEach(s => {
            const pts = s.values.map((v, i) => (v === null ? null : [xAt(i), yAt(v)]));
            let d = '', pen = false;
            pts.forEach(p => { if (!p) { pen = false; return; } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `; pen = true; });
            g += `<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
            pts.forEach(p => { if (p) g += marker(s.marker, p[0], p[1], 9, s.colour); });
        });
        notes.forEach(nt => {
            const x = xAt(nt.i), y = nt.top ? T - 18 : Math.max(T + 30, Math.min(T + ph - 10, yAt(nt.v) + (nt.dy || -34)));
            const anchor = nt.i === 0 ? 'start' : (nt.i === n - 1 ? 'end' : 'middle');
            g += `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="24" font-weight="700" fill="#fff7ed" stroke="#1c1410" stroke-width="6" paint-order="stroke">${esc(nt.text)}</text>`;
        });
        return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" font-family="DM Sans, system-ui, sans-serif">${g}</svg>`;
    }

    // ---------------------------------------------------------------- slides

    const band = (p) => (p === null ? 'bnone' : p >= 0.8 ? 'b80' : p >= 0.6 ? 'b60' : p >= 0.4 ? 'b40' : 'b0');
    const chip = (s) => `<span class="dk-chip" style="background:${s.colour}"></span>`;
    const who = (s) => `${chip(s)}${esc(s.name)}`;

    function buildSlides(m, title) {
        const slides = [];
        const SL = m.SL;
        const add = (cls, body, notes) => slides.push({ cls, body, notes });
        const D = m.data;
        const meta = [D.discipline.name, D.ground, D.event, ukDate(D.date)].filter(Boolean).map(esc).join(' · ');
        const incomplete = m.shooters.filter(s => s.unshot > 0);
        const fewer = m.shooters.filter(s => s.shot < Math.max(...m.shooters.map(x => x.shot)));
        const compareNote = fewer.length ? `<div class="dk-note">${esc(joinNames(fewer.map(s => s.name)))} shot fewer clays than the rest, so everyone is compared by hit rate (%).</div>` : '';

        // 1. Cover
        add('dk-cover', `
            <div class="dk-kicker">${esc(D.discipline.code)} · ${meta}</div>
            <h1 class="dk-title">${esc(title)}</h1>
            <div class="dk-gag">${esc(coverGag(m))}</div>`,
            `Squad: ${m.shooters.length} shooters, ${m.squad.shot} clays shot, ${m.squad.hits} hits (${fmtPct(m.squad.rate)}), ${m.squad.misses} misses.`);

        // 2. Squad
        const showCpsa = m.shooters.some(s => s.cpsa), showGun = m.shooters.some(s => s.gun), showCart = m.shooters.some(s => s.cartridges);
        const cols = ['Shooter', showCpsa && 'CPSA no.', 'Clays', showGun && 'Gun', showCart && 'Cartridges', 'Roast'].filter(Boolean);
        const tmpl = ['1.3fr', showCpsa && '0.8fr', '0.6fr', showGun && '1fr', showCart && '1fr', '2.6fr'].filter(Boolean).join(' ');
        add('', `
            <h2 class="dk-h">The squad</h2>
            <div class="dk-sub">${plural(m.shooters.length, 'shooter')} · ${m.squad.shot} clays · ${m.squad.hits} hits · ${fmtPct(m.squad.rate)} squad hit rate</div>
            <div class="dk-grid" style="grid-template-columns:${tmpl}">
                ${cols.map(c => `<div class="dk-hd">${c}</div>`).join('')}
                ${m.shooters.map(s => [
                    `<div class="dk-strong">${who(s)}</div>`,
                    showCpsa && `<div>${esc(s.cpsa || '–')}</div>`,
                    `<div>${s.shot}${s.unshot ? ` <span class="dk-dim">(${s.unshot} not shot)</span>` : ''}</div>`,
                    showGun && `<div>${esc(s.gun || '–')}</div>`,
                    showCart && `<div>${esc(s.cartridges || '–')}</div>`,
                    `<div class="dk-roast">${esc(squadRoast(m, s))}</div>`
                ].filter(Boolean).join('')).join('')}
            </div>
            ${compareNote}`,
            m.shooters.map(s => `${s.name}: ${s.hits}/${s.shot} (${fmtPct(s.rate)})${s.unshot ? `, ${s.unshot} not shot` : ''}${s.gun ? `, gun ${s.gun}` : ''}${s.cartridges ? `, cartridges ${s.cartridges}` : ''}`).join('\n')
            + `\nSquad: ${m.squad.hits}/${m.squad.shot} (${fmtPct(m.squad.rate)}).`);

        // 3. Podium
        const podiumOrder = [m.ranked[1], m.ranked[0], m.ranked[2]].filter(Boolean);
        const heights = { 0: 520, 1: 400, 2: 300 };
        add('', `
            <h2 class="dk-h">Podium</h2>
            <div class="dk-sub">Ranked by hit rate</div>
            <div class="dk-podium">
                ${podiumOrder.map(s => {
                    const r = m.ranked.indexOf(s);
                    return `<div class="dk-step">
                        <div class="dk-step-name">${who(s)}</div>
                        <div class="dk-step-stat">${s.hits}/${s.shot} · <strong>${fmtPct(s.rate)}</strong></div>
                        <div class="dk-step-block" style="height:${heights[r]}px;border-color:${s.colour}"><span>${r + 1}</span></div>
                    </div>`;
                }).join('')}
            </div>
            ${m.ranked.length > 3 ? `<div class="dk-rest">${m.ranked.slice(3).map((s, i) => `${i + 4}. ${who(s)} ${s.hits}/${s.shot} · ${fmtPct(s.rate)}`).join('<span class="dk-dim"> | </span>')}</div>` : ''}`,
            m.ranked.map((s, i) => `${i + 1}. ${s.name} ${s.hits}/${s.shot} = ${fmtPct(s.rate)}`).join('\n'));

        // 4. Milestones (only the firsts that are shorter than the longest stand)
        if (m.milestones.length) {
            const mcols = `1.3fr ${m.milestones.map(() => '1fr').join(' ')} 1fr`;
            const callouts = m.milestones.map(ms => `After the first ${ms.k} of each ${SL.toLowerCase()} (${ms.scope} clays): ${esc(joinNames(ms.leaders.map(s => s.name)))} led on ${fmtPct(ms.rows[ms.leaders[0].k].rate)}.`);
            const finalGap = m.ranked.length > 1 ? `Final margin: ${esc(m.ranked[0].name)} ${fmtPct(m.ranked[0].rate)} vs ${esc(m.ranked[1].name)} ${fmtPct(m.ranked[1].rate)} (${ptsGap(m.ranked[0].rate, m.ranked[1].rate)} points).` : '';
            add('dk-alt', `
                <h2 class="dk-h">Milestones</h2>
                <div class="dk-sub">"First 6" = the first 6 clays of every ${SL.toLowerCase()}, not clay 6 in card order</div>
                <div class="dk-grid" style="grid-template-columns:${mcols}">
                    <div class="dk-hd">Shooter</div>
                    ${m.milestones.map(ms => `<div class="dk-hd dk-c dk-stack"><span>First ${ms.scope}</span><span class="dk-dim">first ${ms.k} / ${SL.toLowerCase()}</span></div>`).join('')}
                    <div class="dk-hd dk-c dk-stack"><span>Full card</span><span class="dk-dim">${m.shooters[0] ? m.shooters[0].scheduled : ''} clays</span></div>
                    ${m.shooters.map(s => `<div class="dk-strong">${who(s)}</div>${m.milestones.map(ms => {
                        const row = ms.rows[s.k]; const lead = ms.leaders.includes(s);
                        return `<div class="dk-c ${lead ? 'dk-lead' : ''}">${row.hits}/${row.shot} · ${fmtPct(row.rate)}${lead ? ' ★' : ''}</div>`;
                    }).join('')}<div class="dk-c">${s.hits}/${s.shot} · ${fmtPct(s.rate)}</div>`).join('')}
                </div>
                <div class="dk-callouts">${callouts.map(c => `<div>${c}</div>`).join('')}${finalGap ? `<div>${finalGap}</div>` : ''}</div>
                <div class="dk-note">★ = leader at that point (by hit rate).</div>`,
                m.milestones.map(ms => `First ${ms.k}/${SL.toLowerCase()} (${ms.scope} clays): ` + m.shooters.map(s => `${s.name} ${ms.rows[s.k].hits}/${ms.rows[s.k].shot}`).join(', ')).join('\n'));
        }

        // 5. Stand by stand (paged at 10 stands per slide)
        for (let start = 0; start < m.nStands; start += 10) {
            const idx = m.stands.map((_, i) => i).slice(start, start + 10);
            const last = start + 10 >= m.nStands;
            const scols = `0.9fr ${m.shooters.map(() => '1fr').join(' ')} 1fr`;
            const cell = (h, n, extra = '') => `<div class="dk-c dk-cell ${band(pct(h, n))} ${extra}">${n ? `${h}/${n} · ${fmtPct(pct(h, n))}` : '–'}</div>`;
            add('', `
                <h2 class="dk-h">${SL} by ${SL.toLowerCase()}${m.nStands > 10 ? ` <span class="dk-dim">(${start + 1}–${Math.min(start + 10, m.nStands)})</span>` : ''}</h2>
                <div class="dk-sub">Hits / clays and hit rate for every ${SL.toLowerCase()}</div>
                <div class="dk-grid dk-tight" style="grid-template-columns:${scols}">
                    <div class="dk-hd">${SL}</div>${m.shooters.map(s => `<div class="dk-hd dk-c">${who(s)}</div>`).join('')}<div class="dk-hd dk-c">Squad</div>
                    ${idx.map(si => `<div class="dk-strong">${esc(m.standName(si))}</div>${m.shooters.map(s => cell(s.perStand[si].hits, s.perStand[si].shot)).join('')}${cell(m.squad.perStand[si].hits, m.squad.perStand[si].shot)}`).join('')}
                    ${last ? `<div class="dk-strong dk-total">Total</div>${m.shooters.map(s => cell(s.hits, s.shot, 'dk-total')).join('')}${cell(m.squad.hits, m.squad.shot, 'dk-total')}` : ''}
                </div>
                <div class="dk-legend"><span class="dk-cell b80">80%+</span><span class="dk-cell b60">60–79%</span><span class="dk-cell b40">40–59%</span><span class="dk-cell b0">under 40%</span></div>`,
                idx.map(si => `${m.standName(si)}: ` + m.shooters.map(s => `${s.name} ${s.perStand[si].hits}/${s.perStand[si].shot}`).join(', ') + ` | squad ${m.squad.perStand[si].hits}/${m.squad.perStand[si].shot}`).join('\n'));
        }

        // 6. Hit rate per stand
        const xLabels = m.stands.map((_, si) => m.standName(si));
        const disasters = m.stands.map((_, si) => si).filter(si => m.squad.perStand[si].rate !== null && (si === m.worst || m.squad.perStand[si].rate < 0.4));
        add('dk-alt', `
            <h2 class="dk-h">Hit rate per ${SL.toLowerCase()}</h2>
            <div class="dk-chart">${lineChart({
                series: m.shooters.map(s => ({ colour: s.colour, marker: s.marker, values: s.standPcts })),
                xLabels, yMax: 1, yTicks: [0, 0.25, 0.5, 0.75, 1], yFmt: v => `${v * 100}%`, yTitle: 'Hit rate',
                highlights: disasters.map(i => ({ i, fill: '#ef4444' })),
                notes: disasters.slice(0, 3).map(i => ({ i, top: true, text: `${m.squad.perStand[i].rate < 0.4 ? 'Disaster' : 'Toughest'}: squad ${fmtPct(m.squad.perStand[i].rate)}` })),
                height: 600
            })}</div>
            <div class="dk-keys">${m.shooters.map(s => {
                const valid = m.stands.map((_, si) => si).filter(si => s.perStand[si].shot);
                const b = valid.slice().sort((a, c) => s.standPcts[c] - s.standPcts[a])[0];
                const w = valid.slice().sort((a, c) => s.standPcts[a] - s.standPcts[c])[0];
                return `<div><svg width="36" height="36" viewBox="0 0 36 36">${marker(s.marker, 18, 18, 10, s.colour)}</svg><strong>${esc(s.name)}</strong> avg ${fmtPct(s.rate)} · best ${b !== undefined ? `${esc(m.standName(b))} ${fmtPct(s.standPcts[b])}` : '–'} · worst ${w !== undefined ? `${esc(m.standName(w))} ${fmtPct(s.standPcts[w])}` : '–'}</div>`;
            }).join('')}</div>`,
            m.shooters.map(s => `${s.name}: ` + s.standPcts.map((p, si) => `${m.standName(si)} ${fmtPct(p)}`).join(', ')).join('\n')
            + (disasters.length ? `\nShaded red: ${disasters.map(i => `${m.standName(i)} (squad ${fmtPct(m.squad.perStand[i].rate)})`).join(', ')}.` : ''));

        // 7. Running total
        const leadNotes = [];
        let soleLeader = null;
        m.stands.forEach((_, si) => {
            const leaders = leadersBy(m.shooters, s => s.cumulative[si]);
            if (leaders.length !== 1) return;          // a tie doesn't change who last led
            if (soleLeader && soleLeader !== leaders[0]) leadNotes.push({ si, text: `${leaders[0].name} takes the lead`, v: leaders[0].cumulative[si] });
            soleLeader = leaders[0];
        });
        const maxCum = Math.max(1, ...m.shooters.map(s => s.cumulative[s.cumulative.length - 1] || 0));
        const step = maxCum > 80 ? 20 : maxCum > 40 ? 10 : 5;
        const yMaxCum = Math.ceil(maxCum / step) * step;
        const finalGap = m.ranked.length > 1 ? m.ranked[0].hits - Math.max(...m.ranked.slice(1).map(s => s.hits)) : 0;
        const cumNotes = leadNotes.slice(-3).map(n => ({ i: n.si, v: n.v, text: n.text }));
        if (m.ranked.length > 1) {
            const topHits = leadersBy(m.shooters, s => s.hits);
            cumNotes.push({ i: m.nStands - 1, v: topHits[0].hits, dy: 44, text: topHits.length > 1 ? 'Level at the finish' : `${topHits[0].name} +${finalGap}` });
        }
        add('', `
            <h2 class="dk-h">Running total</h2>
            <div class="dk-sub">Cumulative hits after each ${SL.toLowerCase()}${fewer.length ? ' · fewer clays shot by some — see the podium for hit rates' : ''}</div>
            <div class="dk-chart">${lineChart({
                series: m.shooters.map(s => ({ colour: s.colour, marker: s.marker, values: s.cumulative })),
                xLabels, yMax: yMaxCum, yTicks: Array.from({ length: yMaxCum / step + 1 }, (_, i) => i * step), yFmt: v => `${v}`, yTitle: 'Hits',
                notes: cumNotes, height: 600
            })}</div>
            <div class="dk-keys">${m.shooters.map(s => `<div><svg width="36" height="36" viewBox="0 0 36 36">${marker(s.marker, 18, 18, 10, s.colour)}</svg><strong>${esc(s.name)}</strong> ${s.hits}</div>`).join('')}</div>`,
            m.shooters.map(s => `${s.name}: ${s.cumulative.join(' → ')}`).join('\n')
            + (leadNotes.length ? `\nLead changes: ${leadNotes.map(n => `${m.standName(n.si)} ${n.text}`).join('; ')}.` : '\nNo lead changes.'));

        // 8. Barrel by barrel
        if (m.pairsExist) {
            const rows = [...m.shooters.map(s => ({ label: who(s), b: s.barrel })), { label: '<strong>Squad</strong>', b: m.squad.barrel }];
            const pairing = {
                sporting: 'Clays on each stand are paired in order (1–2, 3–4 …): odd = 1st barrel, even = 2nd barrel. A +1 extra clay is a single and isn\'t counted here.',
                sportrap: 'Pairs follow each stand\'s setup: on-report and sim pairs count, singles don\'t. 1st barrel = the first clay of the pair.',
                compak: 'Pairs follow each stand\'s setup: on-report and sim pairs count, singles don\'t. 1st barrel = the first clay of the pair.',
                skeet: 'Only doubles (H+L / L+H) count; singles and the option target don\'t. 1st barrel = the first bird of the double.'
            }[D.discipline.id] || 'Pairs only; singles are not counted.';
            add('dk-alt', `
                <h2 class="dk-h">Barrel by barrel</h2>
                <div class="dk-grid" style="grid-template-columns:1.4fr repeat(3,0.8fr) repeat(3,0.8fr) 0.9fr 0.9fr">
                    <div class="dk-hd">Shooter</div><div class="dk-hd dk-c">1st hit</div><div class="dk-hd dk-c">1st miss</div><div class="dk-hd dk-c">1st %</div>
                    <div class="dk-hd dk-c">2nd hit</div><div class="dk-hd dk-c">2nd miss</div><div class="dk-hd dk-c">2nd %</div><div class="dk-hd dk-c">Doubles</div><div class="dk-hd dk-c">Blanks</div>
                    ${rows.map(r => `<div class="dk-strong">${r.label}</div><div class="dk-c">${r.b.b1h}</div><div class="dk-c">${r.b.b1n - r.b.b1h}</div><div class="dk-c">${fmtPct(pct(r.b.b1h, r.b.b1n))}</div><div class="dk-c">${r.b.b2h}</div><div class="dk-c">${r.b.b2n - r.b.b2h}</div><div class="dk-c">${fmtPct(pct(r.b.b2h, r.b.b2n))}</div><div class="dk-c">${r.b.doubles}</div><div class="dk-c">${r.b.blanks}</div>`).join('')}
                </div>
                <div class="dk-note">Doubles = both barrels hit · Blanks = both missed.</div>
                <div class="dk-footnote">${esc(pairing)}</div>`,
                rows.map((r, i) => `${i < m.shooters.length ? m.shooters[i].name : 'Squad'}: 1st ${r.b.b1h}/${r.b.b1n}, 2nd ${r.b.b2h}/${r.b.b2n}, doubles ${r.b.doubles}, blanks ${r.b.blanks} of ${r.b.pairs} complete pairs`).join('\n') + `\n${pairing}`);
        }

        // 9. Streaks and slumps
        add('', `
            <h2 class="dk-h">Streaks and slumps</h2>
            <div class="dk-sub">In card order, running across ${SL.toLowerCase()}s</div>
            <div class="dk-grid" style="grid-template-columns:1.2fr 1.9fr 1.9fr 2fr">
                <div class="dk-hd">Shooter</div><div class="dk-hd">Longest hit streak</div><div class="dk-hd">Longest miss streak</div><div class="dk-hd">Verdict</div>
                ${m.shooters.map(s => `<div class="dk-strong">${who(s)}</div>
                    <div><strong class="dk-good">${s.hitStreak.len}</strong> ${s.hitStreak.len ? `<span class="dk-dim">${esc(posText(m, s.hitStreak.from))} → ${esc(posText(m, s.hitStreak.to))}</span>` : ''}</div>
                    <div><strong class="dk-bad">${s.missStreak.len}</strong> ${s.missStreak.len ? `<span class="dk-dim">${esc(posText(m, s.missStreak.from))} → ${esc(posText(m, s.missStreak.to))}</span>` : ''}</div>
                    <div class="dk-roast">${esc(streakRoast(s))}</div>`).join('')}
            </div>`,
            m.shooters.map(s => `${s.name}: hits ${s.hitStreak.len} (${posText(m, s.hitStreak.from)} to ${posText(m, s.hitStreak.to)}), misses ${s.missStreak.len} (${posText(m, s.missStreak.from)} to ${posText(m, s.missStreak.to)})`).join('\n')
            + (D.optionLabel ? '\nThe option target is placed at the end of the station it was taken on.' : ''));

        // 10. Stand stories
        if (m.best !== undefined) {
            const card = (label, si, gag, cls) => `<div class="dk-story ${cls}">
                <div class="dk-story-label">${label}</div>
                <div class="dk-story-title">${esc(m.standName(si))} · squad ${fmtPct(m.squad.perStand[si].rate)}</div>
                <div>${m.shooters.filter(s => s.perStand[si].shot).map(s => `<div class="dk-line">${who(s)} ${s.perStand[si].hits}/${s.perStand[si].shot} · ${fmtPct(s.standPcts[si])}</div>`).join('')}</div>
                <div class="dk-roast">${esc(gag)}</div></div>`;
            const c = m.contrast;
            add('dk-alt', `
                <h2 class="dk-h">${SL} stories</h2>
                <div class="dk-stories">
                    ${card('Best', m.best, 'Even the clays looked embarrassed.', 'good')}
                    ${card('Worst', m.worst, 'Nobody wants to talk about it.', 'bad')}
                    ${c ? `<div class="dk-story blue"><div class="dk-story-label">Same ${SL.toLowerCase()}, different planet</div>
                        <div class="dk-story-title">${esc(m.standName(c.si))}</div>
                        <div><div class="dk-line">${who(c.hi)} ${c.hi.perStand[c.si].hits}/${c.hi.perStand[c.si].shot} · ${fmtPct(c.hi.standPcts[c.si])}</div><div class="dk-line">${who(c.lo)} ${c.lo.perStand[c.si].hits}/${c.lo.perStand[c.si].shot} · ${fmtPct(c.lo.standPcts[c.si])}</div></div>
                        <div class="dk-roast">${ptsGap(c.hi.standPcts[c.si], c.lo.standPcts[c.si])} points apart. Same traps, different planet.</div></div>` : ''}
                </div>`,
                `Best: ${m.standName(m.best)} ${m.squad.perStand[m.best].hits}/${m.squad.perStand[m.best].shot}. Worst: ${m.standName(m.worst)} ${m.squad.perStand[m.worst].hits}/${m.squad.perStand[m.worst].shot}.`
                + (c ? ` Contrast: ${m.standName(c.si)} ${c.hi.name} ${fmtPct(c.hi.standPcts[c.si])} vs ${c.lo.name} ${fmtPct(c.lo.standPcts[c.si])}.` : ''));
        }

        // 11. Awards
        const { bests, worsts } = awards(m);
        if (bests.length || worsts.length) {
            const list = (items, cls) => items.map(a => `<div class="dk-award ${cls}"><div class="dk-award-name">${esc(a.name)}</div><div class="dk-award-who">${esc(joinNames(a.who.map(s => s.name)))}</div><div class="dk-dim">${esc(a.stat)}</div></div>`).join('');
            add('', `
                <h2 class="dk-h">Awards</h2>
                <div class="dk-awards"><div><div class="dk-hd dk-good">The bests</div>${list(bests, 'good')}</div><div><div class="dk-hd dk-bad">The worsts</div>${list(worsts, 'bad')}</div></div>`,
                [...bests, ...worsts].map(a => `${a.name}: ${a.who.map(s => s.name).join(' & ')} — ${a.stat}`).join('\n'));
        }

        // 12. Score check (replaces the paper-card audit: there are no handwritten totals here)
        add('dk-alt', `
            <h2 class="dk-h">Score check</h2>
            <div class="dk-sub">Every number in this deck is recomputed from the scored clays</div>
            <div class="dk-grid" style="grid-template-columns:1.3fr 1fr 1fr 1fr 1fr">
                <div class="dk-hd">Shooter</div><div class="dk-hd dk-c">Sum of ${SL.toLowerCase()}s</div><div class="dk-hd dk-c">Clay-by-clay</div><div class="dk-hd dk-c">Running total</div><div class="dk-hd dk-c">Not shot</div>
                ${m.shooters.map(s => {
                    const bySeq = s.seq.filter(e => e.hit).length;
                    const byCum = s.cumulative[s.cumulative.length - 1] || 0;
                    const ok = bySeq === s.hits && byCum === s.hits;
                    return `<div class="dk-strong">${who(s)}</div><div class="dk-c">${s.hits}</div><div class="dk-c">${bySeq} ${ok ? '✓' : '✗'}</div><div class="dk-c">${byCum} ${ok ? '✓' : '✗'}</div><div class="dk-c">${s.unshot || '–'}</div>`;
                }).join('')}
            </div>
            <div class="dk-callouts">
                <div>Squad: ${m.squad.hits} hits = ${m.shooters.map(s => s.hits).join(' + ')} ${sum(m.shooters.map(s => s.hits)) === m.squad.hits ? '✓' : '✗'}</div>
                ${incomplete.length ? `<div>Not shot: ${esc(joinNames(incomplete.map(s => `${s.name} (${s.unshot})`)))} — left out of every rate, not counted as misses.</div>` : '<div>Every scheduled clay was scored.</div>'}
            </div>`,
            'Totals cross-checked three ways: per-stand sums, clay-by-clay count and the running total at the last stand.');

        // 13. Closing
        add('dk-orange', `
            <h2 class="dk-h dk-close-h">Final scores</h2>
            <div class="dk-final">${m.ranked.map((s, i) => `<div><span class="dk-final-rank">${i + 1}</span> <span class="dk-final-name">${esc(s.name)}</span> <span class="dk-final-score">${s.hits}/${s.shot} · ${fmtPct(s.rate)}</span></div>`).join('')}</div>
            <div class="dk-gag dk-close-gag">${esc(closingGag(m))}</div>`,
            m.ranked.map((s, i) => `${i + 1}. ${s.name} ${s.hits}/${s.shot} (${fmtPct(s.rate)})`).join('\n'));

        return slides;
    }

    function awards(m) {
        const S = m.shooters.filter(s => s.shot > 0);
        if (!S.length) return { bests: [], worsts: [] };
        const bests = [], worsts = [];
        const top = (f) => leadersBy(S, f);
        const bottom = (f) => { const vals = S.map(f).filter(v => v !== null); if (!vals.length) return []; const lo = Math.min(...vals); return S.filter(s => f(s) === lo); };
        const standBest = S.map(s => s.standPcts.map((p, si) => ({ s, si, p, n: s.perStand[si].shot })).filter(x => x.n >= 2)).flat();
        const thirds = Math.max(1, Math.floor(m.nStands / 3));
        const rangeRate = (s, a, b) => { const h = sum(s.perStand.slice(a, b).map(p => p.hits)), n = sum(s.perStand.slice(a, b).map(p => p.shot)); return pct(h, n); };

        let w = top(s => s.rate); bests.push({ name: 'Top Gun', who: w, stat: `${fmtPct(w[0].rate)} hit rate` });
        w = top(s => s.hitStreak.len); if (w[0].hitStreak.len) bests.push({ name: 'The Unstoppable', who: w, stat: `${w[0].hitStreak.len} hits in a row` });
        if (standBest.length) {
            const hi = Math.max(...standBest.map(x => x.p)); const xs = standBest.filter(x => x.p === hi);
            bests.push({ name: `${m.SL} Slayer`, who: [...new Set(xs.map(x => x.s))], stat: `${fmtPct(hi)} on ${[...new Set(xs.map(x => x.si))].sort((a, b) => a - b).slice(0, 3).map(m.standName).join(', ')}` });
        }
        if (m.pairsExist) {
            w = top(s => pct(s.barrel.b2h, s.barrel.b2n)); if (w.length && w[0].barrel.b2n) bests.push({ name: 'Second Barrel Hero', who: w, stat: `${fmtPct(pct(w[0].barrel.b2h, w[0].barrel.b2n))} with the 2nd barrel` });
            w = top(s => s.barrel.doubles); if (w[0].barrel.doubles) bests.push({ name: 'Double Act', who: w, stat: plural(w[0].barrel.doubles, 'double') });
        }
        if (m.nStands >= 3) {
            w = top(s => rangeRate(s, m.nStands - thirds, m.nStands)); if (w.length) bests.push({ name: 'Strong Finisher', who: w, stat: `${fmtPct(rangeRate(w[0], m.nStands - thirds, m.nStands))} ${thirds === 1 ? `on the last ${m.SL.toLowerCase()}` : `over the last ${thirds} ${m.SL.toLowerCase()}s`}` });
        }

        if (S.length > 1) { w = bottom(s => s.rate); worsts.push({ name: 'Clay Conservation Society', who: w, stat: `${fmtPct(w[0].rate)} — the most clays spared` }); }
        w = top(s => s.missStreak.len); if (w[0].missStreak.len >= 2) worsts.push({ name: 'The Long Drought', who: w, stat: `${w[0].missStreak.len} misses in a row` });
        if (standBest.length) {
            const lo = Math.min(...standBest.map(x => x.p)); const xs = standBest.filter(x => x.p === lo);
            if (lo < 1) worsts.push({ name: 'Black Hole', who: [...new Set(xs.map(x => x.s))], stat: `${fmtPct(lo)} on ${[...new Set(xs.map(x => x.si))].sort((a, b) => a - b).slice(0, 3).map(m.standName).join(', ')}` });
        }
        if (m.pairsExist) {
            w = top(s => s.barrel.blanks); if (w[0].barrel.blanks) worsts.push({ name: 'Blank Cheque', who: w, stat: `${plural(w[0].barrel.blanks, 'pair')} missed with both barrels` });
            w = bottom(s => pct(s.barrel.b2h, s.barrel.b2n)); if (w.length && w[0].barrel.b2n && pct(w[0].barrel.b2h, w[0].barrel.b2n) < 1) worsts.push({ name: 'Second Barrel Snooze', who: w, stat: `${fmtPct(pct(w[0].barrel.b2h, w[0].barrel.b2n))} with the 2nd barrel` });
        }
        if (m.nStands >= 4) {
            const half = Math.floor(m.nStands / 2);
            const drop = (s) => { const a = rangeRate(s, 0, half), b = rangeRate(s, half, m.nStands); return a === null || b === null ? null : a - b; };
            w = top(drop); if (w.length && drop(w[0]) > 0) worsts.push({ name: 'Fade Away', who: w, stat: `${fmtPct(rangeRate(w[0], 0, half))} first half → ${fmtPct(rangeRate(w[0], half, m.nStands))} second half` });
        }
        return { bests: bests.slice(0, 6), worsts: worsts.slice(0, 6) };
    }

    // ---------------------------------------------------------------- styles

    const FONT_FACES = `
        @font-face { font-family: 'Oswald'; font-weight: 600; font-display: swap; src: url('assets/vendor/fonts/oswald-latin-600-normal.woff2') format('woff2'); }
        @font-face { font-family: 'Oswald'; font-weight: 700; font-display: swap; src: url('assets/vendor/fonts/oswald-latin-700-normal.woff2') format('woff2'); }
        @font-face { font-family: 'DM Sans'; font-weight: 400; font-display: swap; src: url('assets/vendor/fonts/dm-sans-latin-400-normal.woff2') format('woff2'); }
        @font-face { font-family: 'DM Sans'; font-weight: 700; font-display: swap; src: url('assets/vendor/fonts/dm-sans-latin-700-normal.woff2') format('woff2'); }`;

    const CSS = `${FONT_FACES}
        .dk-slide { width: ${W}px; height: ${H}px; box-sizing: border-box; padding: 64px 96px 96px; position: relative; overflow: hidden;
            display: flex; flex-direction: column; background: #1f1611; color: #f5ede6; font-family: 'DM Sans', system-ui, sans-serif; font-size: 28px; line-height: 1.35;
            -webkit-print-color-adjust: exact; print-color-adjust: exact; text-align: left; }
        .dk-slide.dk-alt { background: #140e0a; }
        .dk-slide.dk-cover { background: radial-gradient(circle at 80% 20%, #3b2416 0%, #1f1611 55%, #120c08 100%); justify-content: center; }
        .dk-slide.dk-orange { background: #ea580c; color: #1a0f08; justify-content: center; }
        .dk-slide * { box-sizing: border-box; }
        .dk-h { font-family: 'Oswald', 'Arial Narrow', sans-serif; font-weight: 700; font-size: 76px; line-height: 1.05; text-transform: uppercase; color: #fdba74; margin: 0 0 6px; letter-spacing: 1px; }
        .dk-sub { font-size: 28px; color: #d6c7b8; margin-bottom: 26px; }
        .dk-kicker { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 32px; letter-spacing: 3px; text-transform: uppercase; color: #fb923c; }
        .dk-title { font-family: 'Oswald', 'Arial Narrow', sans-serif; font-weight: 700; font-size: 132px; line-height: 1.02; margin: 18px 0 28px; color: #fff7ed; text-transform: uppercase; }
        .dk-gag { font-size: 40px; color: #86efac; max-width: 1500px; }
        .dk-grid { display: grid; align-items: stretch; font-size: 26px; }
        .dk-grid > div { padding: 12px 14px; border-bottom: 2px solid #3a2a20; display: flex; align-items: center; flex-wrap: wrap; column-gap: 12px; }
        .dk-grid > div.dk-stack { flex-direction: column; justify-content: center; }
        .dk-line { display: flex; align-items: center; }
        .dk-grid.dk-tight > div { padding: 6px 10px; }
        .dk-hd { font-family: 'Oswald', sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #fdba74; font-size: 26px; border-bottom: 3px solid #7c5a43 !important; }
        .dk-c { justify-content: center; text-align: center; }
        .dk-strong { font-weight: 700; }
        .dk-dim { color: #b8a596; font-weight: 400; }
        .dk-roast { color: #fde68a; font-style: italic; }
        .dk-good { color: #4ade80; } .dk-bad { color: #fb7185; }
        .dk-lead { color: #fdba74; font-weight: 700; }
        .dk-chip { display: inline-block; width: 24px; height: 24px; border-radius: 50%; margin-right: 12px; flex: 0 0 auto; border: 2px solid #1f1611; }
        .dk-note { margin-top: 18px; font-size: 24px; color: #d6c7b8; }
        .dk-footnote { position: absolute; left: 96px; right: 96px; bottom: 80px; font-size: 24px; color: #b8a596; }
        .dk-callouts { margin-top: 22px; display: grid; gap: 6px; font-size: 26px; color: #fde68a; }
        .dk-cell { border-radius: 8px; font-weight: 700; }
        .dk-grid .dk-cell { margin: 3px; }
        .b80 { background: #166534; color: #dcfce7; } .b60 { background: #1d4ed8; color: #dbeafe; } .b40 { background: #b45309; color: #fffbeb; } .b0 { background: #c2410c; color: #fff7ed; } .bnone { background: transparent; color: #b8a596; }
        .dk-total { border-top: 3px solid #7c5a43; }
        .dk-legend { display: flex; gap: 14px; margin-top: 16px; font-size: 24px; } .dk-legend span { padding: 6px 14px; }
        .dk-chart svg { display: block; width: 100%; height: auto; }
        .dk-keys { display: flex; flex-wrap: wrap; gap: 8px 36px; font-size: 24px; margin-top: 6px; } .dk-keys > div { display: flex; align-items: center; gap: 10px; }
        .dk-podium { display: flex; align-items: flex-end; justify-content: center; gap: 48px; flex: 1; }
        .dk-step { width: 420px; text-align: center; }
        .dk-step-name { font-size: 36px; font-weight: 700; display: flex; justify-content: center; align-items: center; }
        .dk-step-stat { font-size: 30px; margin: 8px 0 14px; color: #fde68a; }
        .dk-step-block { background: #2b1e16; border-top: 10px solid; border-radius: 14px 14px 0 0; display: flex; justify-content: center; padding-top: 24px; }
        .dk-step-block span { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 120px; color: #fdba74; line-height: 1; }
        .dk-rest { margin-top: 18px; font-size: 26px; text-align: center; display: flex; justify-content: center; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
        .dk-stories { display: grid; grid-template-columns: repeat(3, 1fr); gap: 36px; margin-top: 24px; }
        .dk-story { background: #2b1e16; border-radius: 18px; padding: 30px; border-top: 10px solid #a8a29e; display: grid; gap: 14px; align-content: start; font-size: 28px; }
        .dk-story.good { border-color: #4ade80; } .dk-story.bad { border-color: #fb7185; } .dk-story.blue { border-color: #60a5fa; }
        .dk-story > div:nth-child(3) { display: grid; gap: 6px; } .dk-story > div:nth-child(3) span { vertical-align: middle; }
        .dk-story-label { font-family: 'Oswald', sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; color: #fdba74; font-size: 28px; }
        .dk-story-title { font-size: 40px; font-weight: 700; }
        .dk-awards { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
        .dk-awards .dk-hd { padding-bottom: 8px; margin-bottom: 10px; }
        .dk-award { display: grid; grid-template-columns: 1.15fr 1fr; column-gap: 18px; padding: 8px 0; border-bottom: 2px solid #3a2a20; font-size: 26px; }
        .dk-award .dk-dim { grid-column: 1 / -1; font-size: 24px; }
        .dk-award-name { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 30px; } .dk-award.good .dk-award-name { color: #4ade80; } .dk-award.bad .dk-award-name { color: #fb7185; }
        .dk-award-who { font-weight: 700; text-align: right; }
        .dk-close-h { color: #1a0f08; font-size: 96px; }
        .dk-final { display: grid; gap: 10px; margin: 20px 0 34px; font-size: 44px; }
        .dk-final-rank { font-family: 'Oswald', sans-serif; font-weight: 700; display: inline-block; width: 64px; }
        .dk-final-name { font-weight: 700; } .dk-final-score { margin-left: 18px; }
        .dk-close-gag { color: #1a0f08; font-weight: 700; font-size: 44px; }
        .dk-pageno { position: absolute; right: 96px; bottom: 28px; font-size: 24px; color: #8f7e71; }
        .dk-orange .dk-pageno { color: #431407; }
        .dk-slide strong { font-weight: 700; }

        /* Viewer */
        #deck-viewer { position: fixed; inset: 0; z-index: 80; background: #0c0806; display: flex; flex-direction: column; color: #f5ede6; }
        #deck-viewer .dkv-bar { display: flex; align-items: center; gap: 8px; padding: max(8px, env(safe-area-inset-top)) 10px 8px; background: #1a120d; border-bottom: 1px solid #3a2a20; }
        #deck-viewer .dkv-title { flex: 1; min-width: 0; font: 700 15px/1.2 'DM Sans', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #deck-viewer button { font: 700 13px 'DM Sans', system-ui, sans-serif; border-radius: 10px; padding: 9px 12px; border: 1px solid #5b4333; background: #2b1e16; color: #f5ede6; }
        #deck-viewer button.dkv-primary { background: #ea580c; border-color: #ea580c; color: #fff; }
        #deck-viewer .dkv-stage { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; touch-action: pan-y pinch-zoom; }
        #deck-viewer .dkv-frame { position: relative; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
        #deck-viewer .dkv-frame > .dk-slide { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
        #deck-viewer .dkv-nav { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 8px 10px max(10px, env(safe-area-inset-bottom)); background: #1a120d; border-top: 1px solid #3a2a20; font: 700 14px 'DM Sans', system-ui, sans-serif; }
        #deck-viewer .dkv-notes { max-height: 28vh; overflow-y: auto; padding: 10px 14px; background: #120c08; border-top: 1px solid #3a2a20; font: 14px/1.45 'DM Sans', system-ui, sans-serif; white-space: pre-wrap; color: #e7d9cc; }
        #deck-picker { position: fixed; inset: 0; z-index: 80; background: rgba(12,8,6,.75); display: flex; align-items: center; justify-content: center; padding: 16px; }
        #deck-picker .dkp-box { width: min(32rem, 100%); max-height: 90vh; overflow-y: auto; background: #fff; color: #0f172a; border-radius: 16px; border: 4px solid #f97316; padding: 16px; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
        #deck-picker h3 { margin: 0 0 4px; font-size: 18px; font-weight: 800; }
        #deck-picker p { margin: 0 0 12px; font-size: 13px; color: #475569; }
        #deck-picker label.dkp-opt { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; margin-bottom: 8px; font-size: 15px; font-weight: 600; }
        #deck-picker label.dkp-opt:has(input:checked) { border-color: #f97316; background: #fff7ed; }
        #deck-picker input[type=text] { width: 100%; height: 42px; border: 1px solid #94a3b8; border-radius: 8px; padding: 0 10px; font-size: 15px; font-weight: 600; }
        #deck-picker .dkp-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
        #deck-picker button { font-size: 14px; font-weight: 700; padding: 10px 14px; border-radius: 10px; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; }
        #deck-picker button.dkp-primary { background: #0f172a; color: #fff; border-color: #0f172a; }
        #deck-picker button.dkp-orange { background: #f97316; color: #fff; border-color: #f97316; }

        /* Printing: one slide per 16:9 landscape page */
        #deck-print { display: none; }
        @page deck { size: 297mm 167.0625mm; margin: 0; }
        @media print {
            body.print-deck { margin: 0 !important; padding: 0 !important; background: #1f1611 !important; }
            body.print-deck > *:not(#deck-print) { display: none !important; }
            body.print-deck #deck-print { display: block !important; }
            #deck-print .dk-page { page: deck; width: 297mm; height: 167.0625mm; overflow: hidden; break-after: page; page-break-after: always; }
            #deck-print .dk-page:last-child { break-after: auto; page-break-after: auto; }
            #deck-print .dk-slide { zoom: 0.58464; }
        }`;

    function ensureStyles() {
        if (document.getElementById('deck-styles')) return;
        const st = document.createElement('style');
        st.id = 'deck-styles';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function slideHtml(sl, i, n, title) {
        return `<section class="dk-slide ${sl.cls}" data-notes="${esc(sl.notes || '')}">${sl.body}<div class="dk-pageno">${esc(title)} · ${i + 1}/${n}</div></section>`;
    }

    // ---------------------------------------------------------------- UI

    let current = null;   // { model, title, slides, index }

    function model() {
        const data = window.ClayScorerDeck.getData();
        return analyse(data);
    }

    function open() {
        ensureStyles();
        const m = model();
        if (!m.squad.shot) {
            window.ClayScorerDeck.notify('Score some targets first — the presentation is built from the round\'s scores.', 'error');
            return;
        }
        const suggestions = titleSuggestions(m);
        const saved = m.data.deckTitle;
        const options = saved && !suggestions.includes(saved) ? [saved, ...suggestions] : suggestions;
        const picker = document.createElement('div');
        picker.id = 'deck-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-modal', 'true');
        picker.innerHTML = `<div class="dkp-box">
            <h3>Presentation title</h3>
            <p>Pick a title for the deck, or write your own.</p>
            ${options.map((t, i) => `<label class="dkp-opt"><input type="radio" name="dkp-title" value="${esc(t)}" ${(saved ? t === saved : i === 0) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}
            <label class="dkp-opt"><input type="radio" name="dkp-title" value="__custom"> <input type="text" id="dkp-custom" placeholder="Your own title" value=""></label>
            <div class="dkp-actions">
                <button type="button" data-act="cancel">Cancel</button>
                <button type="button" data-act="pdf" class="dkp-orange">Save as PDF</button>
                <button type="button" data-act="view" class="dkp-primary">View slides</button>
            </div></div>`;
        document.body.appendChild(picker);
        const custom = picker.querySelector('#dkp-custom');
        custom.addEventListener('focus', () => { picker.querySelector('input[value="__custom"]').checked = true; });
        const chosen = () => {
            const sel = picker.querySelector('input[name="dkp-title"]:checked');
            return sel && sel.value === '__custom' ? (custom.value.trim() || options[0]) : (sel ? sel.value : options[0]);
        };
        picker.addEventListener('click', (e) => {
            if (e.target === picker) return picker.remove();
            const act = e.target.closest('button')?.dataset.act;
            if (!act) return;
            if (act === 'cancel') return picker.remove();
            const title = chosen();
            window.ClayScorerDeck.setDeckTitle(title);
            picker.remove();
            if (act === 'view') view(m, title);
            else printDeck(m, title);
        });
    }

    function view(m, title) {
        const slides = buildSlides(m, title);
        current = { m, title, slides, index: 0, notes: false };
        const v = document.createElement('div');
        v.id = 'deck-viewer';
        v.setAttribute('role', 'dialog');
        v.setAttribute('aria-modal', 'true');
        v.setAttribute('aria-label', title);
        v.innerHTML = `
            <div class="dkv-bar">
                <div class="dkv-title">${esc(title)}</div>
                <button type="button" data-act="notes" aria-pressed="false">Notes</button>
                <button type="button" data-act="pdf" class="dkv-primary">PDF</button>
                <button type="button" data-act="close">Close</button>
            </div>
            <div class="dkv-stage"><div class="dkv-frame"></div></div>
            <div class="dkv-notes" hidden></div>
            <div class="dkv-nav">
                <button type="button" data-act="prev" aria-label="Previous slide">‹ Prev</button>
                <span class="dkv-count"></span>
                <button type="button" data-act="next" aria-label="Next slide">Next ›</button>
            </div>`;
        document.body.appendChild(v);
        document.body.style.overflow = 'hidden';
        v.addEventListener('click', (e) => {
            const act = e.target.closest('button')?.dataset.act;
            if (act === 'close') close();
            else if (act === 'prev') go(-1);
            else if (act === 'next') go(1);
            else if (act === 'pdf') printDeck(m, title);
            else if (act === 'notes') { current.notes = !current.notes; e.target.setAttribute('aria-pressed', String(current.notes)); show(); }
        });
        let x0 = null;
        const stage = v.querySelector('.dkv-stage');
        stage.addEventListener('touchstart', (e) => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
        stage.addEventListener('touchend', (e) => {
            if (x0 === null) return;
            const dx = e.changedTouches[0].clientX - x0; x0 = null;
            if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        });
        window.addEventListener('resize', fit);
        document.addEventListener('keydown', onKey);
        show();
    }

    function onKey(e) {
        if (!current) return;
        if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
        else if (e.key === 'Escape') close();
    }

    function go(d) {
        if (!current) return;
        current.index = Math.max(0, Math.min(current.slides.length - 1, current.index + d));
        show();
    }

    function show() {
        const v = document.getElementById('deck-viewer');
        if (!v || !current) return;
        const { slides, index, title } = current;
        v.querySelector('.dkv-frame').innerHTML = slideHtml(slides[index], index, slides.length, title);
        v.querySelector('.dkv-count').textContent = `${index + 1} / ${slides.length}`;
        const notes = v.querySelector('.dkv-notes');
        notes.hidden = !current.notes;
        notes.textContent = slides[index].notes || '';
        v.querySelector('[data-act="prev"]').disabled = index === 0;
        v.querySelector('[data-act="next"]').disabled = index === slides.length - 1;
        fit();
    }

    function fit() {
        const v = document.getElementById('deck-viewer');
        if (!v) return;
        const stage = v.querySelector('.dkv-stage');
        const frame = v.querySelector('.dkv-frame');
        const slide = frame.firstElementChild;
        const scale = Math.min((stage.clientWidth - 16) / W, (stage.clientHeight - 16) / H);
        frame.style.width = `${W * scale}px`;
        frame.style.height = `${H * scale}px`;
        if (slide) slide.style.transform = `scale(${scale})`;
    }

    function close() {
        document.getElementById('deck-viewer')?.remove();
        document.body.style.overflow = '';
        window.removeEventListener('resize', fit);
        document.removeEventListener('keydown', onKey);
        current = null;
    }

    async function printDeck(m, title) {
        ensureStyles();
        const slides = buildSlides(m, title);
        let host = document.getElementById('deck-print');
        if (!host) { host = document.createElement('div'); host.id = 'deck-print'; document.body.appendChild(host); }
        host.innerHTML = slides.map((sl, i) => `<div class="dk-page">${slideHtml(sl, i, slides.length, title)}</div>`).join('');
        try {
            if (document.fonts?.load) await Promise.all(["700 40px 'Oswald'", "600 40px 'Oswald'", "400 24px 'DM Sans'", "700 24px 'DM Sans'"].map(f => document.fonts.load(f)));
        } catch (e) {}
        const prevTitle = document.title;
        const fileTitle = `${m.data.filenameStem}_presentation`;
        document.title = fileTitle;
        document.body.classList.add('print-deck');
        const restore = () => {
            document.body.classList.remove('print-deck');
            document.title = prevTitle;
            window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
    }

    window.ClayScorerPresentation = { open, analyse, titleSuggestions, buildSlides, _view: view, _print: printDeck, _model: model };
})();
