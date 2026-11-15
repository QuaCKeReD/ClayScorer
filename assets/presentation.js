/* ClayScorer — Presentation deck (Export › Presentation).
 *
 * Builds a 16:9 slide deck from the current round: cover, squad, podium, milestones,
 * stand-by-stand grid, hit-rate and running-total charts, barrels, clay types (from the clay
 * presentation descriptions), streaks, stand stories,
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

    const RANGES = ['Close', 'Medium', 'Far'];
    const RANGE_OF = { '0-5': 'Close', '5-10': 'Close', '10-15': 'Medium', '15-20': 'Medium', '20-30': 'Far', '30+': 'Far' };
    const TYPE_PLURAL = { Crosser: 'crossers', Teal: 'teal', Crow: 'crows', Driven: 'driven birds', Overhead: 'overheads', Looper: 'loopers', Battue: 'battues', Rabbit: 'rabbits', Rabbue: 'rabbues', Quartering: 'quartering birds' };
    const typePlural = (t) => TYPE_PLURAL[t] || `${String(t).toLowerCase()}s`;
    const MIN_TYPE_SHOTS = 3;     // a type needs this many shots before it counts as a favourite / nemesis
    // A shooter's best and worst clay type (by hit rate, at least MIN_TYPE_SHOTS shot), or null.
    function typeExtremes(s) {
        const list = Object.entries(s.byType || {}).filter(([, v]) => v.shot >= MIN_TYPE_SHOTS).map(([type, v]) => ({ type, ...v, rate: pct(v.hits, v.shot) }));
        if (list.length < 1) return null;
        const fav = list.slice().sort((a, b) => b.rate - a.rate || b.shot - a.shot)[0];
        const nem = list.slice().sort((a, b) => a.rate - b.rate || b.shot - a.shot)[0];
        return { fav, nem, count: list.length };
    }

    function analyse(data) {
        const SL = data.standLabel;
        const stands = data.stands;
        const nStands = stands.length;
        const standName = (si) => `${SL} ${stands[si].id}`;

        const shooters = data.shooters.map((sh, k) => {
            const seq = [];          // card order, shot targets only
            const perStand = stands.map(() => ({ hits: 0, shot: 0, targets: 0 }));
            const barrel = { b1h: 0, b1n: 0, b2h: 0, b2n: 0, doubles: 0, blanks: 0, pairs: 0 };
            const byType = {}, byRange = {};
            const tally = (o, key, h) => { if (!key) return; o[key] = o[key] || { hits: 0, shot: 0 }; o[key].shot++; if (h) o[key].hits++; };
            sh.stands.forEach((st, si) => {
                (st.clays || []).forEach((c, i) => {
                    const h = st.hits[i];
                    if (!c || h === null) return;
                    tally(byType, c.presentation, h);
                    tally(byRange, RANGE_OF[c.distance], h);
                });
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
                rawStands: sh.stands, byType, byRange
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

        // Clay presentations (from the clay presentation dialog): squad totals per type / range.
        const squadBy = (field) => {
            const out = {};
            shooters.forEach(s => Object.entries(s[field]).forEach(([k, v]) => { out[k] = out[k] || { hits: 0, shot: 0 }; out[k].hits += v.hits; out[k].shot += v.shot; }));
            return out;
        };
        squad.byType = squadBy('byType');
        squad.byRange = squadBy('byRange');
        const types = Object.keys(squad.byType).sort((a, b) => squad.byType[b].shot - squad.byType[a].shot || a.localeCompare(b));
        const ranges = RANGES.filter(r => squad.byRange[r]);

        const pairsExist = shooters.some(s => s.barrel.pairs > 0);
        return { types, ranges, data, SL, stands, nStands, standName, shooters, ranked, squad, milestones, best, worst, contrast, pairsExist, maxTargets };
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

    // ---------------------------------------------------------------- picking lines

    // Lines are chosen from pools with a hash of the round (and the chosen title), so the same
    // deck always reads the same in the viewer, the PDF and print, while a new title or another
    // round gives a different mix. Every template only uses numbers and facts from the round.
    const hashStr = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
    const roundSeed = (m, extra) => [m.data.discipline.id, m.data.ground, m.data.date, m.data.event, `${m.squad.hits}/${m.squad.shot}`, extra].join('|');
    // pick(m, key, pool[, usedKey]): one entry; with usedKey, avoids repeating an entry already
    // picked under that key in this deck (so the squad slide doesn't say the same thing twice).
    function pick(m, key, pool, usedKey) {
        const list = pool.filter(Boolean);
        if (!list.length) return '';
        let i = hashStr(`${m.seed || ''}|${key}`) % list.length;
        if (usedKey) {
            m.used = m.used || {};
            const used = (m.used[usedKey] = m.used[usedKey] || new Set());
            for (let k = 0; k < list.length && used.has(list[i]); k++) i = (i + 1) % list.length;
            used.add(list[i]);
        }
        return list[i];
    }
    const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
    // Short name for titles: the surname (last word), or the only word.
    const shortName = (name) => String(name || '').trim().split(/\s+/).pop().replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '') || String(name || '');

    // ---------------------------------------------------------------- titles

    const VENUE_STOP = new Set(['the', 'shooting', 'ground', 'grounds', 'club', 'school', 'estate', 'clay', 'clays', 'sporting', 'centre', 'center', 'range', 'ranges', 'ltd', 'limited', 'and', '&', 'of', 'gun', 'guns', 'target', 'targets']);

    function venueWord(data) {
        const pick = (text) => String(text || '').split(/[\s,.\-–/]+/).find(w => w && !VENUE_STOP.has(w.toLowerCase()));
        const w = pick(data.ground) || pick(data.event) || data.discipline.name.split(' ').pop();
        return w.charAt(0).toUpperCase() + w.slice(1);
    }

    // Weather as title words: adjective ("Windy") and noun ("Wind").
    function weatherWords(wx) {
        if (!wx) return null;
        if (wx.wet) return /snow/i.test(wx.wet) ? { adj: 'Snowy', noun: 'Snow' } : /sleet/i.test(wx.wet) ? { adj: 'Sleety', noun: 'Sleet' } : /thunder/i.test(wx.wet) ? { adj: 'Stormy', noun: 'Storm' } : { adj: 'Wet', noun: 'Rain' };
        if ((wx.maxGust ?? 0) >= 20 || (wx.maxWind ?? 0) >= 12) return { adj: (wx.maxGust ?? 0) >= 25 ? 'Blustery' : 'Windy', noun: 'Wind' };
        if (wx.minTemp !== null && wx.minTemp <= 5) return { adj: 'Frosty', noun: 'Cold' };
        if (wx.maxTemp !== null && wx.maxTemp >= 25) return { adj: 'Sweltering', noun: 'Heat' };
        if (wx.fog) return { adj: 'Foggy', noun: 'Fog' };
        if (wx.sunny) return { adj: 'Sunny', noun: 'Sun' };
        if (isCalm(wx)) return { adj: 'Still', noun: 'Calm' };
        return null;
    }

    // Three title ideas, each naming the ground or event and mixing in the squad hit rate, the
    // podium result and the weather. `roll` gives a fresh set ("More ideas").
    function titleSuggestions(m, roll = 0) {
        const D = m.data;
        const V = venueWord(D);
        const ev = String(D.event || '').trim();
        const E = ev && ev.length <= 26 ? ev.replace(/\b\w/g, c => c.toUpperCase()) : '';
        const P = E || V;                                  // the place-or-event to name
        const R = Math.round((m.squad.rate ?? 0) * 100);
        const r = m.squad.rate ?? 0;
        const wxw = weatherWords(weatherFacts(D));
        const n = m.ranked.length;
        const W = n ? shortName(m.ranked[0].name) : '';
        const W2 = n > 1 ? shortName(m.ranked[1].name) : '';
        const gap = n > 1 ? ptsGap(m.ranked[0].rate, m.ranked[1].rate) : null;
        const date = yyyymmdd(D.date);
        const sm = { ...m, seed: roundSeed(m, `titles:${roll}`) };

        const rateBand = r >= 0.8 ? [`${V} Massacre`, `The ${V} Clean Sweep`, `Smoke on the ${V}`, `${P}: No Clay Left Behind`, `${R}% at ${V}: Clay Carnage`, `${P}: A ${R}% Demolition`]
            : r >= 0.65 ? [`${V} of Fury`, `The ${V} Strikes Back`, `${V} Rising`, `${P} at ${R}%: Mostly Harmless`, `${R}% and Counting at ${V}`, `${P}: The ${R}% Job`]
            : r >= 0.5 ? [`The ${V} Wobble`, `${P}: A Game of Two Barrels`, `Half Measures at ${V}`, `${V} Coin Toss`, `${P}: ${R}% and a Prayer`, `${R}% at ${V}: Honours Even`]
            : [`The ${V} Clay Sanctuary`, `${V} Survivors' Club`, `${P}: The Clays Strike Back`, `${R}% at ${V}: Clays 1, Squad 0`, `${P}: A ${R}% Rescue Mission`, `The ${V} Great Escape`];
        let podium;
        if (n < 2) podium = W ? [`${W} Goes Solo at ${V}`, `${W} vs the Clays at ${P}`, `${W}'s ${R}% at ${V}`] : [];
        else if (gap === 0) podium = [`Dead Heat at ${V}`, `${W} and ${W2} Share ${P}`, `${P}: Nothing to Split ${W} and ${W2}`];
        else if (gap <= 2) podium = [`Photo Finish at ${V}`, `${W} Edges ${W2} at ${V}`, `${W} by a Whisker at ${P}`, `${P}: ${W} Pips ${W2}`];
        else if (gap >= 15) podium = [`The ${V} Walkover`, `${W} Runs Away With ${P}`, `${W}'s ${V} Masterclass`, `${P}: ${W} by a Country Mile`];
        else podium = [`${W} Takes ${P}`, `${W} Rules the ${V} Roost`, `${W} Tops ${P} at ${R}%`, `${P}: ${W} Comes Out on Top`];
        const weather = wxw ? [
            `A ${wxw.adj} Day at ${V}`, `${wxw.adj} ${P}`, `${V} in the ${wxw.noun}`, `${R}% in the ${wxw.noun} at ${V}`,
            W ? `${W} Beats the ${wxw.noun} at ${P}` : null, W ? `${W} Wins a ${wxw.adj} ${P}` : null,
            W && n > 1 ? `${P}: ${W} on Top, ${R}% in the ${wxw.noun}` : null
        ] : [];
        const fit = (t) => t && t.length <= 52;
        const chosen = [];
        const take = (key, pool) => {
            const list = pool.filter(fit).filter(t => !chosen.includes(t));
            if (list.length) chosen.push(pick(sm, key, list));
        };
        take('podium', podium);
        take('weather', weather.length ? weather : rateBand);
        take('rate', rateBand);
        take('extra', [...podium, ...weather, ...rateBand]);
        return chosen.slice(0, 3).map(t => (date ? `${date} ${t}` : t));
    }

    // ---------------------------------------------------------------- humour (data-driven only)

    // Weather recorded in Round notes, boiled down to the facts the jokes may use.
    function weatherFacts(D) {
        const es = D.weatherEntries || [];
        if (!es.length) return null;
        const nums = (k) => es.map(e => e[k]).filter(Number.isFinite);
        const wind = nums('windMph'), gust = nums('gustMph'), temp = nums('tempC');
        const conds = es.map(e => e.conditions).filter(Boolean);
        return {
            wet: conds.find(c => /rain|drizzle|showers|sleet|snow|thunder/i.test(c)) || null,
            fog: conds.some(c => /fog/i.test(c)),
            sunny: conds.some(c => /sunny/i.test(c)),
            maxWind: wind.length ? Math.max(...wind) : null,
            maxGust: gust.length ? Math.max(...gust) : null,
            minTemp: temp.length ? Math.min(...temp) : null,
            maxTemp: temp.length ? Math.max(...temp) : null
        };
    }
    const isCalm = (wx) => !!wx && !wx.wet && wx.maxWind !== null && wx.maxWind <= 5 && (wx.maxGust === null || wx.maxGust <= 10);
    // The most notable weather, as { kind, ...values }, or null.
    function weatherKind(wx) {
        if (!wx) return null;
        if (wx.wet) return { kind: 'wet', w: wx.wet.toLowerCase(), W: wx.wet };
        if (wx.maxGust !== null && wx.maxGust >= 20) return { kind: 'gust', g: wx.maxGust };
        if (wx.maxWind !== null && wx.maxWind >= 12) return { kind: 'wind', v: wx.maxWind };
        if (wx.minTemp !== null && wx.minTemp <= 5) return { kind: 'cold', t: wx.minTemp };
        if (wx.maxTemp !== null && wx.maxTemp >= 25) return { kind: 'hot', t: wx.maxTemp };
        if (wx.fog) return { kind: 'fog' };
        if (wx.sunny) return { kind: 'sunny' };
        if (isCalm(wx)) return { kind: 'calm' };
        return null;
    }
    // Something to blame, as a noun phrase ("18 mph gusts"), or null. Calm days have no excuse.
    function weatherExcuse(m, key) {
        const k = weatherKind(m.wx);
        if (!k) return null;
        const pools = {
            wet: [`the ${k.w}`, `a soggy day of ${k.w}`, `the ${k.w}, obviously`],
            gust: [`${k.g} mph gusts`, `the ${k.g} mph gusts`, `gusts of ${k.g} mph`],
            wind: [`a ${k.v} mph wind`, `the ${k.v} mph breeze`, `${k.v} mph of wind`],
            cold: [`${k.t} °C cold fingers`, `numb fingers at ${k.t} °C`, `a ${k.t} °C chill`],
            hot: [`${k.t} °C heat`, `the ${k.t} °C heat`, `sweaty palms at ${k.t} °C`],
            fog: ['the fog', 'the murk', 'the fog rolling in'],
            sunny: ['the sun in their eyes', 'the glare', 'the low sun']
        };
        return pools[k.kind] ? pick(m, `excuse:${key}`, pools[k.kind]) : null;
    }
    function weatherGag(m) {
        const k = weatherKind(m.wx);
        if (!k) return '';
        const pools = {
            wet: [`Shot in ${k.w}: dedication, or poor judgement.`, `${k.W}. Waterproofs on, standards slipping.`, `A ${k.w} kind of day. The clays didn't mind; the shooters did.`, `${k.W} all round. Nobody stayed dry, few stayed sharp.`],
            gust: [`Gusts of ${k.g} mph. Some clays took the scenic route.`, `${k.g} mph gusts: the clays had a tailwind and an attitude.`, `With gusts to ${k.g} mph, every clay was a surprise.`],
            wind: [`A ${k.v} mph wind gave everyone a ready-made excuse.`, `${k.v} mph of wind. The clays went wherever they liked.`, `Breezy at ${k.v} mph. Excuses were plentiful.`],
            cold: [`${k.t} °C. Gloves on, excuses ready.`, `${k.t} °C: fingers numb, trigger optional.`, `A brisk ${k.t} °C. Hot drinks earned, hits less so.`],
            hot: [`${k.t} °C. Sun cream and sweaty palms.`, `${k.t} °C: the clays weren't the only thing getting baked.`, `A sweltering ${k.t} °C. Shade was in demand.`],
            fog: ['Fog on the ground. Some clays were heard, not seen.', 'Foggy. The clays had cover; the shooters had excuses.', 'Fog: perfect for clays that like to make an entrance.'],
            sunny: ['Sunshine all round. Glare: the excuse of the day.', 'Sunny skies, so nobody can blame the weather. Except the glare.', 'Blue skies and bright light. Sunglasses advised.'],
            calm: ['Barely a breath of wind. No excuses today.', 'Dead calm. Every miss was all their own work.', 'No wind, no rain, no excuses.']
        };
        return pick(m, 'weatherGag', pools[k.kind] || []);
    }

    function coverGag(m) {
        const r = m.squad.rate ?? 0;
        const hits = m.squad.hits, misses = m.squad.misses;
        const esc_ = plural(misses, 'clay');
        const p = fmtPct(r);
        if (!m.squad.shot) return 'No clays were harmed. Yet.';
        if (r >= 0.8) return pick(m, 'cover', [`The clays never stood a chance. Only ${esc_} escaped.`, `Clay carnage: ${hits} broken, ${misses} survivors.`, `${p} of everything thrown came down in pieces.`, `A bad day to be a clay. Only ${esc_} made it out.`, `${hits} clays down. The survivors are in counselling.`]);
        if (r >= 0.65) return pick(m, 'cover', [`Most clays were harmed in the making of this shoot. ${cap(esc_)} got away.`, `${p} broken. The other ${esc_} are telling their friends.`, `Solid work: ${hits} down, ${misses} still out there somewhere.`, `The clays lost ${hits}–${misses}. A respectable beating.`, `More hits than misses, by a comfortable ${hits - misses}.`]);
        if (r >= 0.5) return pick(m, 'cover', [`A fair fight. The clays won ${misses} rounds of it.`, `${hits} hits, ${misses} misses. Honours almost even.`, `Squad ${p}: a coin toss with extra noise.`, `The clays took ${misses} off the squad. It was close.`, `Plenty broke. Plenty didn't. ${p} all told.`]);
        return pick(m, 'cover', [`${cap(esc_)} escaped unharmed and are still celebrating.`, `The clays won ${misses}–${hits}. Rematch requested.`, `${p} squad hit rate. The clays called it an easy day.`, `A great day for clay conservation: ${misses} spared.`, `More misses than hits. The clays are calling it a home win.`]);
    }

    function squadRoast(m, s) {
        const n = m.ranked.length;
        const rank = m.ranked.indexOf(s);
        const p = fmtPct(s.rate);
        const key = `squad:${s.name}`;
        const one = (pool) => pick(m, key, pool, `squad`);
        const valid = m.stands.map((_, si) => si).filter(si => s.perStand[si].shot > 0);
        const bestSi = valid.slice().sort((a, b) => s.standPcts[b] - s.standPcts[a])[0];
        const worstSi = valid.slice().sort((a, b) => s.standPcts[a] - s.standPcts[b])[0];
        if (!s.shot) return one(['Turned up. Has not fired yet.', 'Present, correct, and yet to pull a trigger.', 'Warming up. Some would say for a while.']);
        if (n > 1 && m.ranked.every(x => x.rate === s.rate)) return one([`${p}, dead level with everyone. Nobody gets bragging rights.`, `${p}, same as everyone else. A squad of clones.`, `Identical ${p} across the board. Suspiciously fair.`]);
        const excuse = weatherExcuse(m, s.name);
        const gun = s.gun;
        const gap = n > 1 ? ptsGap(m.ranked[0].rate, m.ranked[1].rate) : 0;
        if (n > 1 && rank === 0) {
            const gunTail = gun ? pick(m, `${key}:gun`, [` The ${gun} earned its keep.`, ` The ${gun} did the talking.`, ` Credit to the ${gun}.`]) : '';
            if (excuse) return one([`Top of the pile at ${p}, despite ${excuse}.`, `${p} and top, ${excuse} and all.`, `Shrugged off ${excuse} to top the squad at ${p}.`]) + gunTail;
            const walk = gap >= 15 ? [`${p}, ${gap} points clear. Everyone else was shooting for second.`, `Top by ${gap} points at ${p}. Not close.`] : [];
            if (gun) return one([...walk, `Top of the pile at ${p}. The ${gun} earned its keep.`, `${p} and top of the squad. The ${gun} gets a polish tonight.`, `Leads at ${p}. The ${gun} isn't for sale.`]);
            return one([...walk, `Top of the pile at ${p}. Will mention it. Repeatedly.`, `Squad leader at ${p}. Expect a speech.`, `${p}: best in show. Modesty not included.`, `Top dog at ${p}. Insufferable until next week.`, `${p} and top. The bar tab is theirs. (Not confirmed.)`]);
        }
        const ext = typeExtremes(s);
        if (n > 1 && rank === n - 1) {
            if (excuse) return one([`${p}. Blames ${excuse}${gun ? `, not the ${gun}` : ''}.`, `${p}. It was definitely ${excuse}.`, `${p}, and ${excuse} will be mentioned at length.`]);
            if (ext && ext.nem.rate <= 0.5) {
                const t = typePlural(ext.nem.type), h = ext.nem.hits, k = ext.nem.shot;
                return one([`${p}. Undone by the ${t}: ${h}/${k}.`, `${p}. The ${t} won ${k - h}–${h}.`, `${p}. ${cap(t)}: ${h} from ${k}. Say no more.`]);
            }
            if (isCalm(m.wx)) return one([`${p}, on a still day, too. No wind to blame.`, `${p} with no wind to blame. Brave.`]);
            if (gun) return one([`${p}. Not the ${gun}'s fault. Probably.`, `${p}. The ${gun} is considering its options.`, `${p}. The ${gun} wants a word.`]);
            return one([`${p}, the clays' favourite shooter.`, `${p}. The clays send their thanks.`, `${p}. Somebody had to keep the clays company.`, `${p}. Plenty of room for improvement.`, `${p}. The only way is up.`]);
        }
        if (ext && ext.count > 1 && ext.fav.rate - ext.nem.rate >= 0.3) {
            const f = typePlural(ext.fav.type), w = typePlural(ext.nem.type), fp = fmtPct(ext.fav.rate), wp = fmtPct(ext.nem.rate);
            return one([`${fp} on ${f}, ${wp} on ${w}. The ${w} have been told.`, `Loves ${f} (${fp}), loathes ${w} (${wp}).`, `${fp} on ${f}. ${wp} on ${w}. Picky eater.`]);
        }
        if (bestSi !== undefined && worstSi !== undefined && s.standPcts[bestSi] - s.standPcts[worstSi] >= 0.4) {
            const bp = fmtPct(s.standPcts[bestSi]), wp = fmtPct(s.standPcts[worstSi]), bs = m.standName(bestSi), ws = m.standName(worstSi);
            return one([`${bp} on ${bs}, ${wp} on ${ws}. Consistency is overrated.`, `${bs}: ${bp}. ${ws}: ${wp}. Two different shooters, same jacket.`, `Peaked on ${bs} (${bp}), vanished on ${ws} (${wp}).`]);
        }
        return one([`A tidy ${p}. Solid, unspectacular, reliable.`, `${p}. Nothing to see here, in a good way.`, `${p}: the dependable middle.`, `${p}. Quietly effective.`, `${p}. Never the headline, never the punchline.`, `${p}. Steady as you like.`]);
    }

    function streakRoast(m, s) {
        const h = s.hitStreak.len, x = s.missStreak.len;
        const key = `streak:${s.name}`;
        const hot = pick(m, `${key}:hot`, h >= 15 ? ['Unplayable.', 'Machine-like.', 'On another level.']
            : h >= 8 ? ['Briefly unbeatable.', 'Properly in the zone.', 'Hot hands.']
            : h >= 4 ? ['A modest purple patch.', 'Warmed up nicely.', 'Flashes of form.']
            : ['Hot streak? Lukewarm at best.', 'Streaks are for other people.', 'Never quite got going.'], 'streakHot');
        const cold = pick(m, `${key}:cold`, x >= 5 ? ['The clays formed a support group.', 'A drought of biblical proportions.', 'Lost the plot for a while.']
            : x >= 3 ? ['A proper wobble.', 'A brief crisis.', 'A wobble worth forgetting.']
            : x >= 1 ? ['Barely a blip.', 'Nothing a deep breath couldn\'t fix.', 'Minor turbulence.']
            : ['Never missed. Suspicious.', 'A clean sheet.', 'Not one miss. Show-off.'], 'streakCold');
        return `${hot} ${cold}`;
    }

    const storyLine = (m, kind, gap) => pick(m, `story:${kind}`, {
        best: ['Even the clays looked embarrassed.', 'Clays went down like dominoes.', 'Everyone looked good here.', 'The squad\'s happy place.'],
        worst: ['Nobody wants to talk about it.', 'The less said, the better.', 'Still haunting the squad.', 'The clays\' home fortress.'],
        contrast: [`${gap} points apart. Same traps, different planet.`, `${gap} points between them on the same targets.`, `Same clays, ${gap} points apart. Awkward.`]
    }[kind]);

    function typesGag(m, easy, tough, r) {
        const e = typePlural(easy), t = typePlural(tough);
        return pick(m, 'types', [
            `The squad ate ${e} for breakfast (${r(easy)}). The ${t} fought back (${r(tough)}).`,
            `${cap(e)}: ${r(easy)}. ${cap(t)}: ${r(tough)}. Guess which one gets talked about at the bar.`,
            `Easy pickings: ${e} at ${r(easy)}. Hard work: ${t} at ${r(tough)}.`,
            `The ${t} (${r(tough)}) had the squad's number; the ${e} (${r(easy)}) didn't.`
        ]);
    }

    function closingGag(m) {
        const n = m.ranked.length;
        if (n < 2) {
            const w = m.ranked[0]?.name;
            return w ? pick(m, 'close', [`${w} wins. Unopposed, but a win is a win.`, `${w} takes it. Nobody else turned up to argue.`, `A one-horse race, and ${w} won it.`]) : '';
        }
        const W = m.ranked[0].name, W2 = m.ranked[1].name, last = m.ranked[n - 1].name;
        const gap = ptsGap(m.ranked[0].rate, m.ranked[1].rate);
        const pts = `${gap} point${gap === 1 ? '' : 's'}`;
        if (gap === 0) return pick(m, 'close', ['Dead heat at the top. Share the bragging rights.', 'Level at the top. Somebody demand a shoot-off.', 'Nothing to split them at the top. Same again next week?']);
        if (gap <= 2) return pick(m, 'close', [`Photo finish: ${pts} in it. Appeals to the scorer will be ignored.`, `${W} by ${pts}. ${W2} will want a recount.`, `${pts} between ${W} and ${W2}. Shoot-off next time?`]);
        if (gap >= 15) return pick(m, 'close', [`${W} by ${pts}: less a win, more a public service announcement.`, `${W} by ${pts}. Nobody else got close.`, `${W} won by ${pts} and will not be humble about it.`]);
        return pick(m, 'close', [`${W} by ${pts}. ${last}: the clays have sent a thank-you card.`, `${W} wins by ${pts}. ${last} brought up the rear with dignity.`, `${W} by ${pts}. ${last}, there's always next week.`, `${W} takes it by ${pts}. ${last} kept the clay industry in business.`]);
    }

    // ---------------------------------------------------------------- round notes

    // Round notes are free text, so they're never interpreted beyond simple keyword topics:
    // a sentence naming a shooter is quoted in their roast, and a recognised topic (trap
    // trouble, new kit, a debut…) picks a closing line. Nothing is made up from them.
    const noteSentences = (D) => String(D.notes || '').split(/\n+/).flatMap(line => line.split(/(?<=[.!?])\s+|\s*;\s*/)).map(t => t.replace(/\s+/g, ' ').trim()).filter(t => t.length >= 3);
    const clip = (t, n = 110) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t);
    const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The first notes sentence that names this shooter (full name, first name or surname).
    function noteAbout(m, s) {
        const parts = String(s.name || '').split(/\s+/).map(w => w.replace(/[^A-Za-z'-]/g, '')).filter(w => w.length >= 2);
        if (!parts.length) return null;
        // A first name or surname shared with another shooter doesn't count on its own.
        const others = m.shooters.filter(x => x !== s).map(x => String(x.name || '').toLowerCase());
        const keys = [s.name, ...parts.filter(w => !others.some(o => new RegExp(`\\b${reEsc(w.toLowerCase())}\\b`).test(o)))];
        // Short names ("Jo", "Al") only count when capitalised, so ordinary words don't match.
        return noteSentences(m.data).find(t => keys.some(k => new RegExp(`\\b${reEsc(k)}\\b`, k.length <= 3 ? '' : 'i').test(t))) || null;
    }
    const NOTE_TOPICS = [
        { re: /\b(trap|traps|machine|trapper)\b.*\b(broke|broken|jam|jammed|fault|failed|down|stuck)\b|\b(broke|broken|jammed)\b.*\btrap/i,
          lines: ['Trap trouble made the round notes. Very convenient for some.', 'A misbehaving trap is on record. Excuses now officially available.', 'The notes blame the machinery. The machinery has no right of reply.'] },
        { re: /\bnew (gun|shotgun|cartridges?|carts|choke|chokes|stock|glasses|vest|jacket)\b/i,
          lines: ['New kit gets a mention in the notes. Teething problems, or a fresh excuse?', 'Something new in the bag, say the notes. The clays were not impressed.', 'New gear noted. Results to be blamed on it accordingly.'] },
        { re: /\b(first (time|round|shoot|go)|debut|beginner|novice|never shot)\b/i,
          lines: ['A debut is noted. Welcome to the habit.', 'Somebody\'s first time, say the notes. The clays didn\'t go easy.', 'A first outing on record. It only gets more expensive from here.'] },
        { re: /\bbirthday\b/i,
          lines: ['A birthday on the card. The clays didn\'t bring presents.', 'Birthday noted. The clays did not sing.'] },
        { re: /\b(forgot|forgotten|left (his|her|their|my) )\b/i,
          lines: ['Something got forgotten, say the notes. Classic.', 'The notes record a memory lapse. Not naming names. (The notes might.)'] },
        { re: /\b(late|traffic|delayed|delay)\b/i,
          lines: ['A late start is on record. Some were still warming up at the last stand.', 'Delays noted. Patience tested, clays waiting.'] },
        { re: /\b(lunch|bacon|breakfast|cake|coffee|tea|pub|beer|pint|bar)\b/i,
          lines: ['Refreshments made the notes. Priorities clearly in order.', 'Food and drink got a mention. Possibly the highlight for some.'] },
        { re: /\b(squad|group)\s+(behind|ahead|waiting|queue)|\bqueue|\bbusy\b/i,
          lines: ['A busy ground, say the notes. Plenty of time to overthink each stand.', 'Queues noted. Standing about is a skill too.'] },
        { re: /\b(sun|glare|wind|windy|rain|wet|cold|freezing|hot|fog|mud|muddy)\b/i,
          lines: ['The conditions got a mention in the notes. They always do.', 'The notes have opinions about the weather. So do the scores.'] },
        { re: /\b(competition|comp|registered|shoot[- ]off|league|championship)\b/i,
          lines: ['A competitive edge, per the notes. Nerves explain a lot.', 'Silverware on the line, say the notes. Pressure: applied.'] },
        { re: /\b(practice|lesson|coach|coaching|instructor)\b/i,
          lines: ['Coaching gets a mention. Whether it worked is in the scores.', 'Practice, say the notes. The clays treated it as the real thing.'] }
    ];
    function notesClosing(m) {
        const all = noteSentences(m.data);
        if (!all.length) return '';
        const text = all.join(' ');
        const topic = NOTE_TOPICS.find(t => t.re.test(text));
        if (topic) return pick(m, 'notes:topic', topic.lines);
        const first = clip(all[0]);
        return pick(m, 'notes:quote', [`From the round notes: "${first}"`, `For the record, the notes say: "${first}"`, `Scorer's footnote: "${first}"`]);
    }

    // ---------------------------------------------------------------- "Write with AI"

    // The facts sent to the server for Claude to write from: only numbers and text the deck
    // already shows (or the round already holds), so every AI line can be checked against them.
    function deckFacts(m) {
        const D = m.data;
        m.wx = weatherFacts(D);
        const P = (r) => (r === null || r === undefined ? null : Math.round(r * 100));
        const standOf = (s, si) => ({ stand: m.standName(si), pct: P(s.standPcts[si]), hits: s.perStand[si].hits, shot: s.perStand[si].shot });
        const shooters = m.shooters.map(s => {
            const valid = m.stands.map((_, si) => si).filter(si => s.perStand[si].shot > 0);
            const b = valid.slice().sort((a, c) => s.standPcts[c] - s.standPcts[a])[0];
            const w = valid.slice().sort((a, c) => s.standPcts[a] - s.standPcts[c])[0];
            const ext = typeExtremes(s);
            const out = {
                name: s.name, rank: m.ranked.indexOf(s) + 1, hits: s.hits, shot: s.shot, misses: s.misses, ratePct: P(s.rate),
                bestStand: b !== undefined ? standOf(s, b) : null, worstStand: w !== undefined ? standOf(s, w) : null,
                hitStreak: s.hitStreak.len, missStreak: s.missStreak.len
            };
            if (s.gun) out.gun = s.gun;
            if (s.cartridges) out.cartridges = s.cartridges;
            if (m.pairsExist) out.barrels = { firstPct: P(pct(s.barrel.b1h, s.barrel.b1n)), secondPct: P(pct(s.barrel.b2h, s.barrel.b2n)), doubles: s.barrel.doubles, blanks: s.barrel.blanks };
            if (ext) { out.favouriteClay = { type: ext.fav.type, hits: ext.fav.hits, shot: ext.fav.shot, pct: P(ext.fav.rate) }; out.worstClay = { type: ext.nem.type, hits: ext.nem.hits, shot: ext.nem.shot, pct: P(ext.nem.rate) }; }
            const note = noteAbout(m, s);
            if (note) out.notesMention = note;
            return out;
        });
        const n = m.ranked.length;
        const c = m.contrast;
        m.factsMode = true;
        const { bests, worsts } = awards(m);
        m.factsMode = false;
        const award = (a, kind) => ({ base: a.base, kind, defaultName: a.name, winners: a.who.map(s => s.name), stat: a.stat });
        return {
            discipline: D.discipline.name, ground: D.ground || '', event: D.event || '', date: D.date || '', standLabel: m.SL, standCount: m.nStands,
            squad: { hits: m.squad.hits, shot: m.squad.shot, misses: m.squad.misses, ratePct: P(m.squad.rate) },
            podium: n > 1 ? { winner: m.ranked[0].name, runnerUp: m.ranked[1].name, marginPoints: ptsGap(m.ranked[0].rate, m.ranked[1].rate), last: m.ranked[n - 1].name } : { winner: m.ranked[0]?.name || '', solo: true },
            shooters,
            standStories: m.best !== undefined ? {
                best: { stand: m.standName(m.best), squadPct: P(m.squad.perStand[m.best].rate) },
                worst: { stand: m.standName(m.worst), squadPct: P(m.squad.perStand[m.worst].rate) },
                contrast: c ? { stand: m.standName(c.si), high: { name: c.hi.name, pct: P(c.hi.standPcts[c.si]) }, low: { name: c.lo.name, pct: P(c.lo.standPcts[c.si]) }, gapPoints: ptsGap(c.hi.standPcts[c.si], c.lo.standPcts[c.si]) } : null
            } : null,
            milestones: m.milestones.length ? m.milestones.map(ms => ({ firstClaysOfEachStand: ms.k, clays: ms.scope, leaders: ms.leaders.map(s => s.name), leaderPct: P(ms.rows[ms.leaders[0].k].rate) })) : null,
            barrels: m.pairsExist ? { firstPct: P(pct(m.squad.barrel.b1h, m.squad.barrel.b1n)), secondPct: P(pct(m.squad.barrel.b2h, m.squad.barrel.b2n)), doubles: m.squad.barrel.doubles, blanks: m.squad.barrel.blanks, pairs: m.squad.barrel.pairs } : null,
            clayTypes: m.types.length ? m.types.map(t => ({ type: t, hits: m.squad.byType[t].hits, shot: m.squad.byType[t].shot, squadPct: P(pct(m.squad.byType[t].hits, m.squad.byType[t].shot)) })) : null,
            distances: m.ranges.length ? m.ranges.map(r => ({ range: r, hits: m.squad.byRange[r].hits, shot: m.squad.byRange[r].shot, squadPct: P(pct(m.squad.byRange[r].hits, m.squad.byRange[r].shot)) })) : null,
            weather: D.weather || null,
            notes: D.notes || null,
            kit: shooters.some(s => s.gun || s.cartridges) ? shooters.filter(s => s.gun || s.cartridges).map(s => ({ name: s.name, gun: s.gun || '', cartridges: s.cartridges || '' })) : null,
            awards: [...bests.map(a => award(a, 'best')), ...worsts.map(a => award(a, 'worst'))]
        };
    }
    const factsKey = (facts) => hashStr(JSON.stringify(facts)).toString(36);

    // Numbers an AI line may use: every number that appears anywhere in the facts, plus 0–3
    // (for "one miss", "two barrels"…). A line with any other number is dropped for a pool line.
    function allowedNumbers(facts) {
        const set = new Set(['0', '1', '2', '3']);
        const walk = (v) => {
            if (v === null || v === undefined) return;
            if (typeof v === 'number') set.add(String(v));
            else if (typeof v === 'string') (v.match(/\d+(?:\.\d+)?/g) || []).forEach(x => set.add(String(Number(x))));
            else if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(facts);
        return set;
    }

    // Percentages the facts actually contain (fields named …pct / …Pct, and "N%" in text).
    function allowedPercents(facts) {
        const set = new Set(['0', '100']);
        const walk = (v, key) => {
            if (v === null || v === undefined) return;
            if (typeof v === 'number') { if (/pct/i.test(key || '')) set.add(String(v)); }
            else if (typeof v === 'string') (v.match(/\d+(?=\s*%)/g) || []).forEach(x => set.add(String(Number(x))));
            else if (Array.isArray(v)) v.forEach(x => walk(x, key));
            else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, k));
        };
        walk(facts, '');
        return set;
    }

    // Check and tidy the AI's lines against the facts. Returns lookup maps for buildSlides.
    // A line is dropped (the deck uses its own line instead) if it contains a number the facts
    // don't, a percentage that isn't one of the facts' percentages, or a stand that doesn't exist.
    function checkAi(text, facts) {
        if (!text || typeof text !== 'object') return null;
        const nums = allowedNumbers(facts);
        const pcts = allowedPercents(facts);
        const standRe = new RegExp(`\\b${facts.standLabel}\\s+(\\d+)`, 'gi');
        const names = new Set(facts.shooters.map(s => s.name));
        const ok = (t, max = 200) => {
            const line = String(t || '').replace(/\s+/g, ' ').trim();
            if (!line || line.length > max) return '';
            const bad = (line.match(/\d+(?:\.\d+)?/g) || []).some(x => !nums.has(String(Number(x))))
                || (line.match(/\d+(?:\.\d+)?(?=\s*%)/g) || []).some(x => !pcts.has(String(Number(x))))
                || [...line.matchAll(standRe)].some(mt => Number(mt[1]) < 1 || Number(mt[1]) > facts.standCount);
            return bad ? '' : line;
        };
        const byName = (list, field) => {
            const out = {};
            (Array.isArray(list) ? list : []).forEach(e => { if (e && names.has(e.name) && !out[e.name]) { const l = ok(e[field], 220); if (l) out[e.name] = l; } });
            return out;
        };
        const bases = new Set((facts.awards || []).map(a => a.base));
        const awardNames = {};
        (Array.isArray(text.awardNames) ? text.awardNames : []).forEach(e => { if (e && bases.has(e.base)) { const l = ok(e.name, 48); if (l) awardNames[e.base] = l; } });
        const st = text.stories || {};
        return {
            titles: (Array.isArray(text.titles) ? text.titles : []).map(t => ok(t, 60)).filter(Boolean).slice(0, 5),
            cover: ok(text.cover), weather: facts.weather ? ok(text.weather) : '',
            squad: byName(text.squad, 'roast'), verdicts: byName(text.streakVerdicts, 'verdict'),
            kit: ok(text.kit), milestones: ok(text.milestones), barrels: ok(text.barrels), types: ok(text.types),
            streaks: ok(text.streaks), storiesOverall: ok(st.overall), storyBest: ok(st.best), storyWorst: ok(st.worst), storyContrast: ok(st.contrast),
            awards: ok(text.awards), awardNames, notes: facts.notes ? ok(text.notes) : '', closing: ok(text.closing)
        };
    }

    // The AI lines stored with the round, if they were written for exactly these facts.
    function activeAi(m) {
        const saved = m.data.deckAi;
        if (!saved || saved.use === false || !saved.text) return null;
        const facts = deckFacts(m);
        if (saved.key !== factsKey(facts)) return null;
        return checkAi(saved.text, facts);
    }

    // ---------------------------------------------------------------- one overall roast per slide

    const slideRoast = (text) => (text ? `<div class="dk-roast dk-slide-roast">${esc(text)}</div>` : '');
    const countBy = (list) => list.reduce((o, k) => ((o[k] = (o[k] || 0) + 1), o), {});

    function kitRoast(m, kit) {
        const pool = [];
        const guns = kit.filter(s => s.gun);
        const makes = countBy(guns.map(s => cap(s.gun.trim().split(/\s+/)[0].toLowerCase())));
        const [make, count] = Object.entries(makes).sort((a, b) => b[1] - a[1])[0] || [];
        if (count >= 2) pool.push(`${count} ${make}s in one squad. Brand loyalty or peer pressure?`, `${make} counted ${count} times. Somebody's on commission.`, `${count} ${make}s on the rack. How original.`);
        else if (guns.length >= 2) pool.push(`${guns.length} different guns, ${guns.length} different excuses.`, 'No two guns the same. A squad of individualists.');
        const W = m.ranked[0];
        if (W && m.ranked.length > 1) {
            if (W.gun) pool.push(`The ${W.gun} won the day. Expect it to be mentioned.`, `${W.name}'s ${W.gun} topped the lot. Correlation, not causation.`);
            else if (guns.length) pool.push(`${W.name} won without telling us the gun. Trade secret.`);
        }
        const essay = kit.filter(s => (s.cartridges || '').length > 60).sort((a, b) => b.cartridges.length - a.cartridges.length)[0];
        if (essay) pool.push(`${essay.name} wrote an essay on cartridges. Commitment noted.`, `${essay.name}'s cartridge notes run longer than some stands.`);
        if (!pool.length) pool.push('Tools of the trade, as declared by the squad.', 'The kit list. Results may vary.');
        return pick(m, 'slide:kit', pool);
    }

    function milestoneRoast(m) {
        const ms = m.milestones;
        const n = m.ranked.length;
        const first = ms[0];
        if (n < 2) {
            const s = m.ranked[0];
            return s ? pick(m, 'slide:ms', [`${s.name} against the clays: ${fmtPct(first.rows[s.k].rate)} after the first ${first.k}, ${fmtPct(s.rate)} at the end.`, `${fmtPct(first.rows[s.k].rate)} early on, ${fmtPct(s.rate)} by the finish. ${s.rate >= first.rows[s.k].rate ? 'Got better with age.' : 'Faded a touch.'}`]) : '';
        }
        const W = m.ranked[0];
        const sole = (lst) => (lst.length === 1 ? lst[0] : null);
        const leaders = [...ms.map(x => sole(x.leaders)), sole(leadersBy(m.shooters, s => s.rate))];
        const early = leaders[0];
        if (leaders.every(l => l && l === W)) return pick(m, 'slide:ms', [`${W.name} led from the first ${first.k} clays and never let go.`, `Wire to wire: ${W.name} on top at every milestone.`, `${W.name} hit the front early and stayed there.`]);
        if (early && early !== W) return pick(m, 'slide:ms', [`${early.name} led after the first ${first.k}. ${W.name} had other ideas.`, `Early pace from ${early.name}; ${W.name} finished stronger.`, `${early.name} peaked early. ${W.name} timed it better.`]);
        let changes = 0;
        leaders.reduce((prev, l) => { if (l && prev && l !== prev) changes++; return l || prev; }, null);
        if (changes) return pick(m, 'slide:ms', [`The lead changed hands ${plural(changes, 'time')}. Nobody could settle.`, `${plural(changes, 'lead change')} across the milestones. Keep up at the back.`]);
        return pick(m, 'slide:ms', ['Shared leads early on. Nobody wanted to commit.', 'Neck and neck through the milestones.']);
    }

    function barrelRoast(m) {
        const b = m.squad.barrel;
        const r1 = pct(b.b1h, b.b1n), r2 = pct(b.b2h, b.b2n);
        if (r1 === null || r2 === null) return '';
        const p1 = fmtPct(r1), p2 = fmtPct(r2);
        let lead;
        if (r2 > r1 + 0.05) lead = pick(m, 'slide:barrel', [`Second barrels beat first barrels (${p2} vs ${p1}). Slow starters.`, `The second shot was the better shot: ${p2} vs ${p1}.`, `${p2} with the second barrel, ${p1} with the first. Warming up mid-pair.`]);
        else if (r1 > r2 + 0.05) lead = pick(m, 'slide:barrel', [`First barrel ${p1}, second ${p2}. The second clay is where it went wrong.`, `Sharp first shots (${p1}), shakier follow-ups (${p2}).`, `${p1} then ${p2}: the second bird kept getting away.`]);
        else lead = pick(m, 'slide:barrel', [`First and second barrels within a whisker: ${p1} vs ${p2}.`, `${p1} and ${p2}. Both barrels pulling their weight.`]);
        const tail = b.blanks
            ? pick(m, 'slide:barrel:tail', [` ${plural(b.blanks, 'pair')} escaped both barrels.`, ` ${plural(b.blanks, 'pair')} with nothing from either barrel.`, ` ${b.blanks} blank${b.blanks === 1 ? '' : 's'} on the card.`])
            : pick(m, 'slide:barrel:tail', [' Not a single blank pair. Impressive.', ' No blanks at all. Tidy.']);
        return lead + tail;
    }

    function streaksOverall(m) {
        const S = m.shooters.filter(s => s.shot);
        if (!S.length) return '';
        const maxHit = Math.max(...S.map(s => s.hitStreak.len)), maxMiss = Math.max(...S.map(s => s.missStreak.len));
        const A = S.filter(s => s.hitStreak.len === maxHit), B = S.filter(s => s.missStreak.len === maxMiss);
        const an = joinNames(A.map(s => s.name)), bn = joinNames(B.map(s => s.name));
        if (maxMiss <= 1) return pick(m, 'slide:streak', [`${maxMiss ? 'Nobody missed two in a row.' : 'Not one miss all round.'} Best run: ${an}, ${maxHit} straight.`, `${an} put ${maxHit} together, and nobody ${maxMiss ? 'missed twice running' : 'missed at all'}. Tidy.`]);
        if (A.length === 1 && B.length === 1 && A[0] === B[0]) return pick(m, 'slide:streak', [`${an} had the best run (${maxHit}) and the worst slump (${maxMiss}). A rollercoaster.`, `Highs and lows for ${an}: ${maxHit} straight, then ${maxMiss} misses in a row.`]);
        return pick(m, 'slide:streak', [`${an}'s ${maxHit} in a row was the run of the day. ${bn}'s ${maxMiss}-miss slump was the one to forget.`, `Hot hand: ${an} (${maxHit} straight). Cold patch: ${bn} (${maxMiss} misses).`, `${an} strung ${maxHit} together; ${bn} dropped ${maxMiss} in a row. Swings and roundabouts.`]);
    }

    function storiesOverall(m) {
        if (m.best === undefined || m.best === m.worst) return '';
        const bp = fmtPct(m.squad.perStand[m.best].rate), wp = fmtPct(m.squad.perStand[m.worst].rate);
        const sb = m.standName(m.best), sw = m.standName(m.worst);
        const gap = ptsGap(m.squad.perStand[m.best].rate, m.squad.perStand[m.worst].rate);
        return pick(m, 'slide:stories', [`From ${bp} on ${sb} to ${wp} on ${sw}: a ${gap}-point swing in one round.`, `${sb} was a party (${bp}); ${sw} was a wake (${wp}).`, `${gap} points between the best and worst ${m.SL.toLowerCase()}s. Variety, they call it.`, `${sb}: smiles. ${sw}: silence. ${gap} points apart.`]);
    }

    function awardsRoast(m, bests, worsts) {
        const pool = [];
        const good = countBy(bests.flatMap(a => a.who.map(s => s.name)));
        const bad = countBy(worsts.flatMap(a => a.who.map(s => s.name)));
        const [topName, topN] = Object.entries(good).sort((a, b) => b[1] - a[1])[0] || [];
        if (topN >= 2) pool.push(`${topName} collects ${topN} awards. Cabinet space required.`, `${topN} awards for ${topName}. Speech prepared, presumably.`);
        const both = Object.keys(good).filter(nm => bad[nm]);
        if (both.length) pool.push(`${joinNames(both)} made both lists. Range.`, `${joinNames(both)}: a best and a worst. Versatile.`);
        const [badName, badN] = Object.entries(bad).sort((a, b) => b[1] - a[1])[0] || [];
        if (badN >= 2) pool.push(`${badName} takes ${badN} of the worsts. Consistency of a kind.`);
        const none = m.ranked.length > 1 ? m.shooters.filter(s => s.shot && !good[s.name] && !bad[s.name]).map(s => s.name) : [];
        if (none.length) pool.push(`${joinNames(none)} ${none.length === 1 ? 'leaves' : 'leave'} empty-handed. Next time.`, `Nothing for ${joinNames(none)} this week. Quietly anonymous.`);
        if (!pool.length) pool.push('Trophies all round. Well, some of them.', 'The silverware, such as it is.');
        return pick(m, 'slide:awards', pool);
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

    // True when two series share a value at the same point (lineChart draws those side by side).
    const sharesPoints = (series) => series.some((a, k) => series.some((b, j) => j > k && a.values.some((v, i) => v !== null && v !== undefined && v === b.values[i])));
    const sharedNote = (series) => (sharesPoints(series) ? '<div class="dk-footnote">Where lines meet on the same value they are drawn side by side, so every shooter stays visible.</div>' : '');

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
        // Series on the same value at the same point are spread a few pixels apart (in series
        // order), so lines that run together show as parallel lines and every marker stays visible.
        const DODGE = 12;
        const offsets = series.map(() => new Array(n).fill(0));
        for (let i = 0; i < n; i++) {
            const groups = new Map();
            series.forEach((s, k) => { const v = s.values[i]; if (v === null || v === undefined) return; const key = Math.round(v * 1e6); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(k); });
            groups.forEach(ks => { if (ks.length > 1) ks.forEach((k, j) => { offsets[k][i] = (j - (ks.length - 1) / 2) * DODGE; }); });
        }
        series.forEach((s, k) => {
            const pts = s.values.map((v, i) => (v === null || v === undefined ? null : [xAt(i), yAt(v) + offsets[k][i]]));
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
        const tight = m.shooters.length > 6 ? ' dk-tight' : '';   // big squads: tighter table rows
        const add = (cls, body, notes) => slides.push({ cls, body, notes });
        const D = m.data;
        m.wx = weatherFacts(D);
        m.seed = roundSeed(m, title);
        m.used = {};
        m.ai = activeAi(m);
        const A = m.ai;
        const say = (slot, fallback) => (A && A[slot]) || fallback();
        const meta = [D.discipline.name, D.ground, D.event, ukDate(D.date)].filter(Boolean).map(esc).join(' · ');
        const incomplete = m.shooters.filter(s => s.unshot > 0);
        const fewer = m.shooters.filter(s => s.shot < Math.max(...m.shooters.map(x => x.shot)));
        const compareNote = fewer.length ? `<div class="dk-note">${esc(joinNames(fewer.map(s => s.name)))} shot fewer clays than the rest, so everyone is compared by hit rate (%).</div>` : '';

        // 1. Cover
        add('dk-cover', `
            <div class="dk-kicker">${esc(D.discipline.code)} · ${meta}</div>
            <h1 class="dk-title">${esc(title)}</h1>
            <div class="dk-gag">${esc([say('cover', () => coverGag(m)), say('weather', () => weatherGag(m))].filter(Boolean).join(' '))}</div>
            ${D.weather ? `<div class="dk-weather">Conditions: ${esc(D.weather)}</div>` : ''}`,
            `Squad: ${m.shooters.length} shooters, ${m.squad.shot} clays shot, ${m.squad.hits} hits (${fmtPct(m.squad.rate)}), ${m.squad.misses} misses.${D.weather ? `\nWeather: ${D.weather}` : ''}`);

        // 2. Squad
        const hasGun = m.shooters.some(s => s.gun), hasCart = m.shooters.some(s => s.cartridges);
        // Long gun / cartridge text gets its own "The kit" slide so the squad slide stays readable.
        const kitSlide = (hasGun || hasCart) && (m.shooters.some(s => (s.gun || '').length + (s.cartridges || '').length > 50) || m.shooters.length > 6);
        const showCpsa = m.shooters.some(s => s.cpsa), showGun = hasGun && !kitSlide, showCart = hasCart && !kitSlide;
        const cols = ['Shooter', showCpsa && 'CPSA no.', 'Clays', showGun && 'Gun', showCart && 'Cartridges', 'Roast'].filter(Boolean);
        const tmpl = ['max-content', showCpsa && '0.8fr', '0.6fr', showGun && '1fr', showCart && '1fr', '2.6fr'].filter(Boolean).join(' ');
        add('', `
            <h2 class="dk-h">The squad</h2>
            <div class="dk-sub">${plural(m.shooters.length, 'shooter')} · ${m.squad.shot} clays · ${m.squad.hits} hits · ${fmtPct(m.squad.rate)} squad hit rate</div>
            <div class="dk-grid" style="grid-template-columns:${tmpl}">
                ${cols.map(c => `<div class="dk-hd">${c}</div>`).join('')}
                ${m.shooters.map(s => [
                    `<div class="dk-strong dk-nowrap">${who(s)}</div>`,
                    showCpsa && `<div>${esc(s.cpsa || '–')}</div>`,
                    `<div>${s.shot}${s.unshot ? ` <span class="dk-dim">(${s.unshot} not shot)</span>` : ''}</div>`,
                    showGun && `<div>${esc(s.gun || '–')}</div>`,
                    showCart && `<div>${esc(s.cartridges || '–')}</div>`,
                    `<div class="dk-roast">${esc(A?.squad[s.name] || squadRoast(m, s))}${(() => { const t = A?.squad[s.name] ? null : noteAbout(m, s); return t ? ` <span class="dk-note-quote">${esc(pick(m, `notes:${s.name}`, ['Notes say:', 'On the record:', 'The notes add:']))} “${esc(clip(t, 90))}”</span>` : ''; })()}</div>`
                ].filter(Boolean).join('')).join('')}
            </div>
            ${compareNote}`,
            m.shooters.map(s => `${s.name}: ${s.hits}/${s.shot} (${fmtPct(s.rate)})${s.unshot ? `, ${s.unshot} not shot` : ''}${s.gun ? `, gun ${s.gun}` : ''}${s.cartridges ? `, cartridges ${s.cartridges}` : ''}`).join('\n')
            + `\nSquad: ${m.squad.hits}/${m.squad.shot} (${fmtPct(m.squad.rate)}).`);
        if (kitSlide) {
            const kit = m.shooters.filter(s => s.gun || s.cartridges);
            add('dk-alt', `
                <h2 class="dk-h">The kit</h2>
                <div class="dk-sub">Guns and cartridges</div>
                ${slideRoast(say('kit', () => kitRoast(m, kit)))}
                <div class="dk-grid dk-tight" style="grid-template-columns:max-content ${hasGun ? '1fr ' : ''}${hasCart ? '1.8fr' : ''}">
                    <div class="dk-hd">Shooter</div>${hasGun ? '<div class="dk-hd">Gun</div>' : ''}${hasCart ? '<div class="dk-hd">Cartridges</div>' : ''}
                    ${kit.map(s => `<div class="dk-strong dk-nowrap">${who(s)}</div>${hasGun ? `<div>${esc(s.gun || '–')}</div>` : ''}${hasCart ? `<div>${esc(s.cartridges || '–')}</div>` : ''}`).join('')}
                </div>`,
                kit.map(s => `${s.name}: ${[s.gun && `gun ${s.gun}`, s.cartridges && `cartridges ${s.cartridges}`].filter(Boolean).join(', ')}`).join('\n'));
        }

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
                ${slideRoast(say('milestones', () => milestoneRoast(m)))}
                <div class="dk-grid${tight}" style="grid-template-columns:${mcols}">
                    <div class="dk-hd">Shooter</div>
                    ${m.milestones.map(ms => `<div class="dk-hd dk-c dk-stack"><span>First ${ms.scope}</span><span class="dk-dim">first ${ms.k} / ${SL.toLowerCase()}</span></div>`).join('')}
                    <div class="dk-hd dk-c dk-stack"><span>Full card</span><span class="dk-dim">${m.shooters[0] ? m.shooters[0].scheduled : ''} clays</span></div>
                    ${m.shooters.map(s => `<div class="dk-strong">${who(s)}</div>${m.milestones.map(ms => {
                        const row = ms.rows[s.k]; const lead = ms.leaders.includes(s);
                        return `<div class="dk-c ${lead ? 'dk-lead' : ''}">${row.hits}/${row.shot} · ${fmtPct(row.rate)}${lead ? ' ★' : ''}</div>`;
                    }).join('')}<div class="dk-c">${s.hits}/${s.shot} · ${fmtPct(s.rate)}</div>`).join('')}
                </div>
                ${tight ? '' : `<div class="dk-callouts">${callouts.map(c => `<div>${c}</div>`).join('')}${finalGap ? `<div>${finalGap}</div>` : ''}</div>`}
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
            }).join('')}</div>${sharedNote(m.shooters.map(s => ({ values: s.standPcts })))}`,
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
            <div class="dk-keys">${m.shooters.map(s => `<div><svg width="36" height="36" viewBox="0 0 36 36">${marker(s.marker, 18, 18, 10, s.colour)}</svg><strong>${esc(s.name)}</strong> ${s.hits}</div>`).join('')}</div>${sharedNote(m.shooters.map(s => ({ values: s.cumulative })))}`,
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
                ${slideRoast(say('barrels', () => barrelRoast(m)))}
                <div class="dk-grid${tight}" style="grid-template-columns:1.4fr repeat(3,0.8fr) repeat(3,0.8fr) 0.9fr 0.9fr">
                    <div class="dk-hd">Shooter</div><div class="dk-hd dk-c">1st hit</div><div class="dk-hd dk-c">1st miss</div><div class="dk-hd dk-c">1st %</div>
                    <div class="dk-hd dk-c">2nd hit</div><div class="dk-hd dk-c">2nd miss</div><div class="dk-hd dk-c">2nd %</div><div class="dk-hd dk-c">Doubles</div><div class="dk-hd dk-c">Blanks</div>
                    ${rows.map(r => `<div class="dk-strong">${r.label}</div><div class="dk-c">${r.b.b1h}</div><div class="dk-c">${r.b.b1n - r.b.b1h}</div><div class="dk-c">${fmtPct(pct(r.b.b1h, r.b.b1n))}</div><div class="dk-c">${r.b.b2h}</div><div class="dk-c">${r.b.b2n - r.b.b2h}</div><div class="dk-c">${fmtPct(pct(r.b.b2h, r.b.b2n))}</div><div class="dk-c">${r.b.doubles}</div><div class="dk-c">${r.b.blanks}</div>`).join('')}
                </div>
                <div class="dk-note">Doubles = both barrels hit · Blanks = both missed.</div>
                <div class="dk-footnote">${esc(pairing)}</div>`,
                rows.map((r, i) => `${i < m.shooters.length ? m.shooters[i].name : 'Squad'}: 1st ${r.b.b1h}/${r.b.b1n}, 2nd ${r.b.b2h}/${r.b.b2n}, doubles ${r.b.doubles}, blanks ${r.b.blanks} of ${r.b.pairs} complete pairs`).join('\n') + `\n${pairing}`);
        }

        // 8b. Clay types (only when clay presentations were described)
        if (m.types.length) {
            const cell = (v) => (v && v.shot ? `<div class="dk-c"><span class="dk-cell ${band(pct(v.hits, v.shot))}">${fmtPct(pct(v.hits, v.shot))}</span> <span class="dk-dim">${v.hits}/${v.shot}</span></div>` : '<div class="dk-c dk-dim">–</div>');
            const rowsFor = (keys, field, label) => keys.map(k => `<div class="dk-strong">${esc(label(k))}</div>${m.shooters.map(s => cell(s[field][k])).join('')}${cell(m.squad[field][k])}`).join('');
            const toughest = m.types.filter(t => m.squad.byType[t].shot >= MIN_TYPE_SHOTS).sort((a, b) => pct(m.squad.byType[a].hits, m.squad.byType[a].shot) - pct(m.squad.byType[b].hits, m.squad.byType[b].shot))[0];
            const easiest = m.types.filter(t => m.squad.byType[t].shot >= MIN_TYPE_SHOTS).sort((a, b) => pct(m.squad.byType[b].hits, m.squad.byType[b].shot) - pct(m.squad.byType[a].hits, m.squad.byType[a].shot))[0];
            const r = (t) => fmtPct(pct(m.squad.byType[t].hits, m.squad.byType[t].shot));
            const gag = say('types', () => (toughest && easiest && toughest !== easiest ? typesGag(m, easiest, toughest, r) : ''));
            const cols = `1.2fr repeat(${m.shooters.length + 1}, 1fr)`;
            const shown = m.types.slice(0, m.ranges.length ? 7 : 10);
            add('dk-alt', `
                <h2 class="dk-h">Clay types</h2>
                <div class="dk-sub">Hit rate by presentation, from the clay descriptions${m.types.length > shown.length ? ` · the ${shown.length} most-shot types` : ''}</div>
                <div class="dk-grid dk-tight" style="grid-template-columns:${cols}">
                    <div class="dk-hd">Presentation</div>${m.shooters.map(s => `<div class="dk-hd dk-c">${who(s)}</div>`).join('')}<div class="dk-hd dk-c">Squad</div>
                    ${rowsFor(shown, 'byType', t => t)}
                    ${m.ranges.length ? `<div class="dk-hd">Distance</div>${m.shooters.map(() => '<div class="dk-hd"></div>').join('')}<div class="dk-hd"></div>${rowsFor(m.ranges, 'byRange', k => ({ Close: 'Close (0–10 m)', Medium: 'Medium (10–20 m)', Far: 'Far (20 m+)' })[k])}` : ''}
                </div>
                ${gag ? `<div class="dk-roast dk-types-gag">${esc(gag)}</div>` : ''}`,
                m.types.map(t => `${t}: ` + m.shooters.map(s => s.byType[t] ? `${s.name} ${s.byType[t].hits}/${s.byType[t].shot}` : null).filter(Boolean).join(', ') + ` | squad ${m.squad.byType[t].hits}/${m.squad.byType[t].shot}`).join('\n')
                + (m.ranges.length ? '\n' + m.ranges.map(k => `${k}: squad ${m.squad.byRange[k].hits}/${m.squad.byRange[k].shot}`).join(', ') : '')
                + '\nOnly clays with a presentation set in the clay presentation dialog are counted.');
        }

        // 9. Streaks and slumps
        add('', `
            <h2 class="dk-h">Streaks and slumps</h2>
            <div class="dk-sub">In card order, running across ${SL.toLowerCase()}s</div>
            ${slideRoast(say('streaks', () => streaksOverall(m)))}
            <div class="dk-grid${tight}" style="grid-template-columns:max-content max-content max-content 1fr;${m.shooters.some(s => s.name.length > 14) || m.shooters.length > 6 ? ' font-size:24px;' : ''}">
                <div class="dk-hd">Shooter</div><div class="dk-hd">Longest hit streak</div><div class="dk-hd">Longest miss streak</div><div class="dk-hd">Verdict</div>
                ${m.shooters.map(s => `<div class="dk-strong dk-nowrap">${who(s)}</div>
                    <div class="dk-nowrap"><strong class="dk-good">${s.hitStreak.len}</strong> ${s.hitStreak.len ? `<span class="dk-dim">${esc(posText(m, s.hitStreak.from))} → ${esc(posText(m, s.hitStreak.to))}</span>` : ''}</div>
                    <div class="dk-nowrap"><strong class="dk-bad">${s.missStreak.len}</strong> ${s.missStreak.len ? `<span class="dk-dim">${esc(posText(m, s.missStreak.from))} → ${esc(posText(m, s.missStreak.to))}</span>` : ''}</div>
                    <div class="dk-roast">${esc(A?.verdicts[s.name] || streakRoast(m, s))}</div>`).join('')}
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
                ${slideRoast(say('storiesOverall', () => storiesOverall(m)))}
                <div class="dk-stories">
                    ${card('Best', m.best, say('storyBest', () => storyLine(m, 'best')), 'good')}
                    ${card('Worst', m.worst, say('storyWorst', () => storyLine(m, 'worst')), 'bad')}
                    ${c ? `<div class="dk-story blue"><div class="dk-story-label">Same ${SL.toLowerCase()}, different planet</div>
                        <div class="dk-story-title">${esc(m.standName(c.si))}</div>
                        <div><div class="dk-line">${who(c.hi)} ${c.hi.perStand[c.si].hits}/${c.hi.perStand[c.si].shot} · ${fmtPct(c.hi.standPcts[c.si])}</div><div class="dk-line">${who(c.lo)} ${c.lo.perStand[c.si].hits}/${c.lo.perStand[c.si].shot} · ${fmtPct(c.lo.standPcts[c.si])}</div></div>
                        <div class="dk-roast">${esc(say('storyContrast', () => storyLine(m, 'contrast', ptsGap(c.hi.standPcts[c.si], c.lo.standPcts[c.si]))))}</div></div>` : ''}
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
                ${slideRoast(say('awards', () => awardsRoast(m, bests, worsts)))}
                <div class="dk-awards"><div><div class="dk-hd dk-good">The bests</div>${list(bests, 'good')}</div><div><div class="dk-hd dk-bad">The worsts</div>${list(worsts, 'bad')}</div></div>`,
                [...bests, ...worsts].map(a => `${a.name}: ${a.who.map(s => s.name).join(' & ')} — ${a.stat}`).join('\n'));
        }

        // 12. Score check (replaces the paper-card audit: there are no handwritten totals here)
        add('dk-alt', `
            <h2 class="dk-h">Score check</h2>
            <div class="dk-sub">Every number in this deck is recomputed from the scored clays</div>
            <div class="dk-grid${tight}" style="grid-template-columns:1.3fr 1fr 1fr 1fr 1fr">
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
            <div class="dk-final${m.ranked.length > 6 ? ' dk-final-tight' : ''}">${m.ranked.map((s, i) => `<div><span class="dk-final-rank">${i + 1}</span> <span class="dk-final-name">${esc(s.name)}</span> <span class="dk-final-score">${s.hits}/${s.shot} · ${fmtPct(s.rate)}</span></div>`).join('')}</div>
            <div class="dk-gag dk-close-gag">${esc(say('closing', () => closingGag(m)))}</div>
            ${(() => { const t = say('notes', () => notesClosing(m)); return t ? `<div class="dk-close-notes">${esc(t)}</div>` : ''; })()}`,
            m.ranked.map((s, i) => `${i + 1}. ${s.name} ${s.hits}/${s.shot} (${fmtPct(s.rate)})`).join('\n')
            + (D.notes ? `\nRound notes: ${D.notes}` : ''));

        return slides;
    }

    const AWARD_NAMES = {
        'Top Gun': ['Top Gun', 'Deadeye', 'The Sharpshooter'],
        'The Unstoppable': ['The Unstoppable', 'Streak Machine', 'On Fire'],
        'Second Barrel Hero': ['Second Barrel Hero', 'Plan B Specialist', 'The Recovery Expert'],
        'Double Act': ['Double Act', 'Two for Two', 'Pair Bonded'],
        'Strong Finisher': ['Strong Finisher', 'Saved the Best for Last', 'The Closer'],
        'Clay Conservation Society': ['Clay Conservation Society', 'Friend of the Clays', 'Clay Rights Activist'],
        'The Long Drought': ['The Long Drought', 'Dry Spell', 'Lost in the Wilderness'],
        'Black Hole': ['Black Hole', 'The Bermuda Triangle', 'Here Be Dragons'],
        'Nemesis': ['Nemesis', 'Arch-Enemy', 'Sworn Enemy'],
        'Blank Cheque': ['Blank Cheque', 'Double Zero', 'Two Barrels, No Bodies'],
        'Second Barrel Snooze': ['Second Barrel Snooze', 'Plan B Failed', 'One-Barrel Wonder'],
        'Fade Away': ['Fade Away', 'Ran Out of Steam', 'Early Peaker']
    };
    // AI-written name if there is one, the plain base name when building facts, else a pool pick.
    const awardName = (m, base, pool) => (m.factsMode ? (pool ? pool[0] : base) : (m.ai?.awardNames?.[base] || pick(m, `award:${base}`, pool || AWARD_NAMES[base] || [base])));

    function awards(m) {
        const S = m.shooters.filter(s => s.shot > 0);
        if (!S.length) return { bests: [], worsts: [] };
        const bests = [], worsts = [];
        const top = (f) => leadersBy(S, f);
        const bottom = (f) => { const vals = S.map(f).filter(v => v !== null); if (!vals.length) return []; const lo = Math.min(...vals); return S.filter(s => f(s) === lo); };
        const standBest = S.map(s => s.standPcts.map((p, si) => ({ s, si, p, n: s.perStand[si].shot })).filter(x => x.n >= 2)).flat();
        const thirds = Math.max(1, Math.floor(m.nStands / 3));
        const rangeRate = (s, a, b) => { const h = sum(s.perStand.slice(a, b).map(p => p.hits)), n = sum(s.perStand.slice(a, b).map(p => p.shot)); return pct(h, n); };

        let w = top(s => s.rate); bests.push({ base: 'Top Gun', name: awardName(m, 'Top Gun'), who: w, stat: `${fmtPct(w[0].rate)} hit rate` });
        w = top(s => s.hitStreak.len); if (w[0].hitStreak.len) bests.push({ base: 'The Unstoppable', name: awardName(m, 'The Unstoppable'), who: w, stat: `${w[0].hitStreak.len} hits in a row` });
        if (standBest.length) {
            const hi = Math.max(...standBest.map(x => x.p)); const xs = standBest.filter(x => x.p === hi);
            bests.push({ base: 'Stand Slayer', name: awardName(m, 'Stand Slayer', [`${m.SL} Slayer`, `${m.SL} Destroyer`, `Owner of ${m.standName(xs[0].si)}`]), who: [...new Set(xs.map(x => x.s))], stat: `${fmtPct(hi)} on ${[...new Set(xs.map(x => x.si))].sort((a, b) => a - b).slice(0, 3).map(m.standName).join(', ')}` });
        }
        if (m.types.length) {
            // Specialist: best hit rate on the squad's most-shot clay type.
            const t = m.types[0];
            const rateOn = (s) => (s.byType[t] && s.byType[t].shot >= MIN_TYPE_SHOTS ? pct(s.byType[t].hits, s.byType[t].shot) : null);
            w = top(rateOn); if (w.length && rateOn(w[0]) !== null) bests.push({ base: 'Clay Specialist', name: awardName(m, 'Clay Specialist', [`${t} Specialist`, `${t} Whisperer`, `${t} Assassin`]), who: w, stat: `${fmtPct(rateOn(w[0]))} on ${typePlural(t)} (${w[0].byType[t].hits}/${w[0].byType[t].shot})` });
        }
        if (m.pairsExist) {
            w = top(s => pct(s.barrel.b2h, s.barrel.b2n)); if (w.length && w[0].barrel.b2n) bests.push({ base: 'Second Barrel Hero', name: awardName(m, 'Second Barrel Hero'), who: w, stat: `${fmtPct(pct(w[0].barrel.b2h, w[0].barrel.b2n))} with the 2nd barrel` });
            w = top(s => s.barrel.doubles); if (w[0].barrel.doubles) bests.push({ base: 'Double Act', name: awardName(m, 'Double Act'), who: w, stat: plural(w[0].barrel.doubles, 'double') });
        }
        if (m.nStands >= 3) {
            w = top(s => rangeRate(s, m.nStands - thirds, m.nStands)); if (w.length) bests.push({ base: 'Strong Finisher', name: awardName(m, 'Strong Finisher'), who: w, stat: `${fmtPct(rangeRate(w[0], m.nStands - thirds, m.nStands))} ${thirds === 1 ? `on the last ${m.SL.toLowerCase()}` : `over the last ${thirds} ${m.SL.toLowerCase()}s`}` });
        }

        if (S.length > 1) { w = bottom(s => s.rate); worsts.push({ base: 'Clay Conservation Society', name: awardName(m, 'Clay Conservation Society'), who: w, stat: `${fmtPct(w[0].rate)} — the most clays spared` }); }
        w = top(s => s.missStreak.len); if (w[0].missStreak.len >= 2) worsts.push({ base: 'The Long Drought', name: awardName(m, 'The Long Drought'), who: w, stat: `${w[0].missStreak.len} misses in a row` });
        if (standBest.length) {
            const lo = Math.min(...standBest.map(x => x.p)); const xs = standBest.filter(x => x.p === lo);
            if (lo < 1) worsts.push({ base: 'Black Hole', name: awardName(m, 'Black Hole'), who: [...new Set(xs.map(x => x.s))], stat: `${fmtPct(lo)} on ${[...new Set(xs.map(x => x.si))].sort((a, b) => a - b).slice(0, 3).map(m.standName).join(', ')}` });
        }
        {
            // Nemesis: the lowest hit rate anyone had on one clay type.
            const nems = S.map(s => ({ s, e: typeExtremes(s) })).filter(x => x.e && x.e.nem.rate < 0.5);
            if (nems.length) {
                const lo = Math.min(...nems.map(x => x.e.nem.rate));
                const xs = nems.filter(x => x.e.nem.rate === lo);
                worsts.push({ base: 'Nemesis', name: awardName(m, 'Nemesis'), who: xs.map(x => x.s), stat: `${xs[0].e.nem.type}: ${xs[0].e.nem.hits}/${xs[0].e.nem.shot} (${fmtPct(lo)})` });
            }
        }
        if (m.pairsExist) {
            w = top(s => s.barrel.blanks); if (w[0].barrel.blanks) worsts.push({ base: 'Blank Cheque', name: awardName(m, 'Blank Cheque'), who: w, stat: `${plural(w[0].barrel.blanks, 'pair')} missed with both barrels` });
            w = bottom(s => pct(s.barrel.b2h, s.barrel.b2n)); if (w.length && w[0].barrel.b2n && pct(w[0].barrel.b2h, w[0].barrel.b2n) < 1) worsts.push({ base: 'Second Barrel Snooze', name: awardName(m, 'Second Barrel Snooze'), who: w, stat: `${fmtPct(pct(w[0].barrel.b2h, w[0].barrel.b2n))} with the 2nd barrel` });
        }
        if (m.nStands >= 4) {
            const half = Math.floor(m.nStands / 2);
            const drop = (s) => { const a = rangeRate(s, 0, half), b = rangeRate(s, half, m.nStands); return a === null || b === null ? null : a - b; };
            w = top(drop); if (w.length && drop(w[0]) > 0) worsts.push({ base: 'Fade Away', name: awardName(m, 'Fade Away'), who: w, stat: `${fmtPct(rangeRate(w[0], 0, half))} first half → ${fmtPct(rangeRate(w[0], half, m.nStands))} second half` });
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
        .dk-weather { margin-top: 28px; font-size: 28px; color: #d6c7b8; max-width: 1600px; }
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
        .dk-note-quote { color: #fcd9a8; font-style: normal; }
        .dk-close-notes { margin-top: 14px; font-size: 30px; color: #1a0f08; font-style: italic; max-width: 1600px; }
        .dk-slide-roast { font-size: 30px; margin: 6px 0 18px; max-width: 1700px; }
        .dk-types-gag { margin-top: 18px; font-size: 30px; }
        .dk-good { color: #4ade80; } .dk-bad { color: #fb7185; }
        .dk-lead { color: #fdba74; font-weight: 700; }
        .dk-slide[data-fit] .dk-grid { font-size: var(--fit) !important; }
        .dk-grid > div.dk-nowrap { flex-wrap: nowrap; white-space: nowrap; padding-right: 28px; }
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
        .dk-final.dk-final-tight { gap: 2px; margin: 10px 0 20px; font-size: 38px; }
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
        #deck-viewer .dkv-desktop { display: none; }
        @media (hover: hover) and (pointer: fine) { #deck-viewer .dkv-desktop { display: inline-block; } }
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
        #deck-picker h4 { margin: 14px 0 2px; font-size: 15px; font-weight: 800; }
        #deck-picker .dkp-badge { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 6px; background: #f97316; color: #fff; font-size: 11px; font-weight: 800; vertical-align: middle; }
        #deck-picker .dkp-ai { margin-top: 10px; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 10px; background: #f8fafc; font-size: 14px; color: #334155; display: grid; gap: 8px; }
        #deck-picker .dkp-tone { display: flex; align-items: center; gap: 8px; font-weight: 700; }
        #deck-picker .dkp-tone select { height: 38px; border: 1px solid #94a3b8; border-radius: 8px; padding: 0 8px; font-size: 15px; font-weight: 600; background: #fff; }
        #deck-picker button.dkp-ai-btn { background: #f97316; color: #fff; border-color: #f97316; }
        #deck-picker button.dkp-ai-btn:disabled { opacity: 0.45; }
        #deck-picker button.dkp-link { border: 0; padding: 0; background: none; color: #9a3412; text-decoration: underline; font-size: 14px; }
        #deck-picker .dkp-ai-hint { font-size: 13px; color: #64748b; }
        #deck-picker .dkp-ai-error { font-size: 13px; color: #b91c1c; font-weight: 600; }
        #deck-picker button.dkp-more { width: 100%; margin-bottom: 8px; border-style: dashed; color: #9a3412; }
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

    const loadFonts = async () => {
        try { if (document.fonts?.load) await Promise.all(["700 40px 'Oswald'", "600 40px 'Oswald'", "400 24px 'DM Sans'", "700 24px 'DM Sans'"].map(f => document.fonts.load(f))); } catch (e) {}
    };

    // Very long text (e.g. unlimited cartridge descriptions) could run off a slide: render each
    // slide off-screen and step the table text down until it fits. Normal slides are untouched.
    function fitSlides(slides, title) {
        ensureStyles();
        const host = document.createElement('div');
        host.style.cssText = `position:fixed; left:-${W * 2}px; top:0; width:${W}px; height:${H}px; overflow:hidden; visibility:hidden;`;
        document.body.appendChild(host);
        try {
            slides.forEach((sl, i) => {
                delete sl.fit;
                host.innerHTML = slideHtml(sl, i, slides.length, title);
                const el = host.firstElementChild;
                const grid = el.querySelector('.dk-grid');
                if (!grid) return;
                let size = parseFloat(getComputedStyle(grid).fontSize) || 26;
                while (el.scrollHeight > el.clientHeight + 1 && size > 16) {
                    size -= 1;
                    el.style.setProperty('--fit', `${size}px`); el.setAttribute('data-fit', '');
                    sl.fit = size;
                }
            });
        } finally { host.remove(); }
        return slides;
    }

    function slideHtml(sl, i, n, title) {
        return `<section class="dk-slide ${sl.cls}"${sl.fit ? ` data-fit style="--fit:${sl.fit}px"` : ''} data-notes="${esc(sl.notes || '')}">${sl.body}<div class="dk-pageno">${esc(title)} · ${i + 1}/${n}</div></section>`;
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
        const bridge = window.ClayScorerDeck;
        const saved = m.data.deckTitle;
        const date = yyyymmdd(m.data.date);
        let roll = 0;
        let options = [];
        let aiStatus = null;          // { available, signedIn } from the server, or null (unknown / no server)
        let busy = false, aiError = '', justWrote = false;
        const tone = () => m.data.deckTone || 'cheeky';   // Cheeky is the default tone
        const ai = () => activeAi(m);
        // With AI-written jokes in use, the first set of title ideas is the AI's; "More ideas" then
        // offers the built-in ones. Right after writing, the first AI title is pre-selected.
        const optionsHtml = () => {
            const a = roll === 0 ? ai() : null;
            const aiTitles = a && a.titles.length ? a.titles.slice(0, 4).map(t => (date ? `${date} ${t}` : t)) : [];
            const suggestions = aiTitles.length ? aiTitles : titleSuggestions(m, roll);
            options = saved && !suggestions.includes(saved) ? [saved, ...suggestions] : suggestions;
            const pickIdx = justWrote && aiTitles.length ? options.indexOf(aiTitles[0]) : -1;
            return options.map((t, i) => {
                const on = pickIdx >= 0 ? i === pickIdx : (saved && roll === 0 ? t === saved : i === (saved ? 1 : 0));
                return `<label class="dkp-opt"><input type="radio" name="dkp-title" value="${esc(t)}" ${on ? 'checked' : ''}> <span>${esc(t)}${aiTitles.includes(t) ? ' <span class="dkp-badge">AI</span>' : ''}</span></label>`;
            }).join('');
        };
        const aiHtml = () => {
            const st = aiStatus;
            const stored = m.data.deckAi;
            const a = ai();
            const toneSel = `<label class="dkp-tone">Tone <select id="dkp-tone">${['gentle', 'cheeky', 'savage'].map(t => `<option value="${t}" ${tone() === t ? 'selected' : ''}>${cap(t)}</option>`).join('')}</select></label>`;
            let line;
            if (busy) line = '<span>Writing the jokes… this takes a few seconds.</span>';
            else if (a) line = `<span><strong>Using AI-written jokes</strong> (${esc(cap(stored.tone || 'cheeky'))}${stored.tone && stored.tone !== tone() ? ` — Rewrite to use ${esc(cap(tone()))}` : ''}).</span> <button type="button" data-act="builtin" class="dkp-link">Use built-in jokes</button>`;
            else if (stored && stored.use === false && stored.key === factsKey(deckFacts(m))) line = '<span>Using the built-in jokes.</span> <button type="button" data-act="useai" class="dkp-link">Use the AI-written ones</button>';
            else if (stored && stored.text) line = '<span>The scores or notes have changed since the AI wrote the jokes, so the built-in ones are used. Write again to update.</span>';
            else line = '<span>Built-in jokes, or have AI write the jokes and some title ideas for this round.</span>';
            const canWrite = st && st.available && st.signedIn && !busy;
            const btnLabel = a || (stored && stored.text) ? 'Rewrite with AI' : 'Write with AI';
            const hint = !st ? '' : !st.available ? '<div class="dkp-ai-hint">Writing with AI isn’t set up on this server.</div>' : !st.signedIn ? '<div class="dkp-ai-hint">Sign in (cloud button) to write with AI.</div>' : '';
            return `${st && st.available ? toneSel : ''}<div class="dkp-ai-line">${line}</div>
                ${st && st.available ? `<button type="button" data-act="ai" class="dkp-ai-btn" ${canWrite ? '' : 'disabled'}>${btnLabel}</button>` : ''}
                ${hint}${aiError ? `<div class="dkp-ai-error">${esc(aiError)}</div>` : ''}`;
        };
        const picker = document.createElement('div');
        picker.id = 'deck-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-modal', 'true');
        picker.innerHTML = `<div class="dkp-box">
            <h3>Presentation</h3>
            <div class="dkp-ai">${aiHtml()}</div>
            <h4>Title</h4>
            <p>Pick a title for the deck, or write your own.</p>
            <div class="dkp-list">${optionsHtml()}</div>
            <button type="button" data-act="more" class="dkp-more">More ideas</button>
            <label class="dkp-opt"><input type="radio" name="dkp-title" value="__custom"> <input type="text" id="dkp-custom" placeholder="Your own title" value=""></label>
            <div class="dkp-actions">
                <button type="button" data-act="cancel">Cancel</button>
                <button type="button" data-act="view" class="dkp-primary">Show slides</button>
            </div></div>`;
        document.body.appendChild(picker);
        const refresh = (titlesToo) => {
            picker.querySelector('.dkp-ai').innerHTML = aiHtml();
            if (titlesToo) { roll = 0; picker.querySelector('.dkp-list').innerHTML = optionsHtml(); }
        };
        // Is "Write with AI" available here? (No server → no AI controls; the deck still works.)
        fetch('/api/presentation/status', { credentials: 'same-origin' })
            .then(r => (r.ok ? r.json() : null)).catch(() => null)
            .then(st => { aiStatus = st && typeof st.available === 'boolean' ? st : null; if (document.body.contains(picker)) refresh(false); });
        const custom = picker.querySelector('#dkp-custom');
        custom.addEventListener('focus', () => { picker.querySelector('input[value="__custom"]').checked = true; });
        picker.addEventListener('change', (e) => {
            if (e.target.id !== 'dkp-tone') return;
            m.data.deckTone = e.target.value;
            bridge.setDeckTone(e.target.value);
            refresh(false);
        });
        const chosen = () => {
            const sel = picker.querySelector('input[name="dkp-title"]:checked');
            return sel && sel.value === '__custom' ? (custom.value.trim() || options[0]) : (sel ? sel.value : options[0]);
        };
        const writeWithAi = async () => {
            busy = true; aiError = ''; refresh(false);
            try {
                const facts = deckFacts(m);
                const res = await fetch('/api/presentation/write', {
                    method: 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json', 'X-ClayScorer': '1' },
                    body: JSON.stringify({ facts, tone: tone() })
                });
                let data = null;
                try { data = await res.json(); } catch (e) {}
                if (!res.ok || !data || !data.text) throw new Error(data?.error || `Server error (${res.status})`);
                const stored = { key: factsKey(facts), tone: data.tone || tone(), model: data.model || '', at: Date.now(), text: data.text };
                m.data.deckAi = stored;
                bridge.setDeckAi(stored);
                justWrote = true;
            } catch (err) {
                aiError = `${err.message || 'The AI writer failed.'} The built-in jokes still work.`;
            } finally {
                busy = false;
                if (document.body.contains(picker)) refresh(true);
            }
        };
        picker.addEventListener('click', (e) => {
            if (e.target === picker) return picker.remove();
            const act = e.target.closest('button')?.dataset.act;
            if (!act) return;
            if (act === 'cancel') return picker.remove();
            if (act === 'more') { roll++; picker.querySelector('.dkp-list').innerHTML = optionsHtml(); return; }
            if (act === 'ai') return writeWithAi();
            if (act === 'builtin' || act === 'useai') {
                const stored = { ...m.data.deckAi, use: act === 'useai' };
                m.data.deckAi = stored;
                bridge.setDeckAi(stored);
                return refresh(true);
            }
            const title = chosen();
            bridge.setDeckTitle(title);
            picker.remove();
            view(m, title);
            // Re-fit once the slide fonts have loaded (their widths decide what fits).
            loadFonts().then(() => { if (current && current.title === title) { fitSlides(current.slides, title); show(); } });
        });
    }

    function view(m, title) {
        const slides = fitSlides(buildSlides(m, title), title);
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
                <button type="button" data-act="share" class="dkv-primary">Share</button>
                <button type="button" data-act="save" class="dkv-desktop" title="Save to this computer">Save</button>
                <button type="button" data-act="print">Print</button>
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
            else if (act === 'print') printDeck(m, title);
            else if (act === 'share') shareDeck(m, title, e.target.closest('button'));
            else if (act === 'save') shareDeck(m, title, e.target.closest('button'), true);
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

    // Share: render every slide to an image and wrap them in a 16:9 PDF (one slide per page).
    async function shareDeck(m, title, btn, saveOnly = false) {
        const bridge = window.ClayScorerDeck;
        if (!window.html2canvas || !bridge?.pdfFromCanvases) return;
        const label = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
        const host = document.createElement('div');
        host.style.cssText = `position:fixed; left:0; top:0; width:${W}px; height:${H}px; z-index:-1; overflow:hidden;`;
        document.body.appendChild(host);
        try {
            if (document.fonts?.load) await Promise.all(["700 40px 'Oswald'", "600 40px 'Oswald'", "400 24px 'DM Sans'", "700 24px 'DM Sans'"].map(f => document.fonts.load(f)));
            const slides = fitSlides(buildSlides(m, title), title);
            const canvases = [];
            for (let i = 0; i < slides.length; i++) {
                host.innerHTML = slideHtml(slides[i], i, slides.length, title);
                canvases.push(await window.html2canvas(host.firstElementChild, { scale: 0.75, width: W, height: H, backgroundColor: null, useCORS: true }));
            }
            const blob = await bridge.pdfFromCanvases(canvases, 841.89, 473.56);
            const file = new File([blob], `${m.data.filenameStem}_presentation.pdf`, { type: 'application/pdf' });
            await (saveOnly && bridge.saveFiles ? bridge.saveFiles([file]) : bridge.shareFiles([file]));
        } catch (e) {
            console.error(e);
            bridge.notify('Could not create the presentation PDF.', 'error');
        } finally {
            host.remove();
            if (btn) { btn.disabled = false; btn.textContent = label; }
        }
    }

    async function printDeck(m, title) {
        ensureStyles();
        try { if (document.fonts?.load) await Promise.all(["700 40px 'Oswald'", "600 40px 'Oswald'", "400 24px 'DM Sans'", "700 24px 'DM Sans'"].map(f => document.fonts.load(f))); } catch (e) {}
        const slides = fitSlides(buildSlides(m, title), title);
        let host = document.getElementById('deck-print');
        if (!host) { host = document.createElement('div'); host.id = 'deck-print'; document.body.appendChild(host); }
        host.innerHTML = slides.map((sl, i) => `<div class="dk-page">${slideHtml(sl, i, slides.length, title)}</div>`).join('');
        try {
            if (document.fonts?.load) await Promise.all(["700 40px 'Oswald'", "600 40px 'Oswald'", "400 24px 'DM Sans'", "700 24px 'DM Sans'"].map(f => document.fonts.load(f)));
        } catch (e) {}
        const prevTitle = document.title;
        const fileTitle = `${m.data.filenameStem}_presentation`;
        document.title = fileTitle;
        document.body.classList.remove('print-images');
        document.body.classList.add('print-deck');
        const restore = () => {
            document.body.classList.remove('print-deck');
            document.title = prevTitle;
            window.removeEventListener('afterprint', restore);
        };
        window.addEventListener('afterprint', restore);
        window.print();
    }

    window.ClayScorerPresentation = { open, analyse, titleSuggestions, buildSlides, _fit: fitSlides, _ai: { deckFacts, factsKey, checkAi }, _view: view, _print: printDeck, _share: shareDeck, _model: model };
})();
