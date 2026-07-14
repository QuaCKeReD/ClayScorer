/* Multi-discipline clay scoring engine.
 *
 * Each discipline page sets `window.DISCIPLINE` before loading this file:
 *   {
 *     id, name, code, storageKey, standLabel,
 *     maxShooters, showFirstUpRotation,
 *     editable: { standCount, targetsPerStand, extraClay },
 *     defaults: { standCount, targetsPerStand },  // only when standCount editable
 *     targetOptions: [4, 6, 8, 10],               // only when targetsPerStand editable
 *     enableStandDescriptions: false,             // optional, defaults to true
 *     fixedStands: [{ id, targets, labels? }],    // null for variable ESP
 *     optionTarget: { label, fallbackStandId }     // optional floating target
 *   }
 *
 * Storage keys are per-discipline so each round is independent.
 */
(function () {
    'use strict';

    // Bump this string when you ship a change so it's easy to confirm from DevTools
    // that a page has picked up the new build (rather than serving from SW cache).
    const SCORER_BUILD = 'scorer 2026-07-14 (sportrap stand format defaults)';
    console.info('%c[ClayScorer] %s', 'color:#f97316;font-weight:bold', SCORER_BUILD);

    const D = window.DISCIPLINE;
    if (!D) { console.error('DISCIPLINE config missing'); return; }

    const KEY = D.storageKey;
    const MAX_SHOOTERS = D.maxShooters || 6;
    const CLASSES = ['AAA', 'AA', 'A', 'B', 'C', 'U'];
    const HAS_STAND_DESCRIPTIONS = D.enableStandDescriptions !== false;
    const HAS_PRESENTATION_MAP = D.id === 'compak' || D.id === 'sportrap';
    const ROTATE = !HAS_PRESENTATION_MAP && D.showFirstUpRotation !== false;
    const ROUND_LABEL = HAS_PRESENTATION_MAP ? 'Round' : D.standLabel;
    const PHYSICAL_STAND_LABEL = 'Stand';
    const STAND_ROTATION_DEFAULT_VERSION = 1;
    const SPORTRAP_STAND_FORMAT_DEFAULT_VERSION = 1;
    const CLAY_META_OPTIONS = {
        presentation: ['Crosser', 'Teal', 'Crow', 'Driven', 'Looper', 'Batue', 'Rabbit'],
        direction: ['LR', 'RL', 'Away', 'Towards'],
        starting: ['Low', 'Mid', 'High'],
        travelling: ['Up', 'Down', 'Level'],
        claySize: ['Std110', 'Midi90', 'Mini70'],
        clayFace: ['Edge', 'Belly', 'Top'],
        clayVisibility: ['Full', 'Part'],
        colour: ['Orange', 'Black', 'Pink', 'Green']
    };

    const standTargets = (s) => s.targets + (s.extraClay ? 1 : 0);
    const presentationCountForStand = (s) => s.presentationCount || D.presentationCount || (D.fixedStands ? standTargets(s) : 2 + (s.extraClay ? 1 : 0));
    const presentationLabel = (idx) => {
        const letter = String.fromCharCode(65 + idx);
        if (D.id === 'sportrap') return letter;
        if (D.id === 'compak') return `${idx + 1}/${letter}`;
        return `Clay ${idx + 1}`;
    };
    const OPTION = D.optionTarget || null;
    const scheduledRoundTargets = () => state.stands.reduce((sum, s) => sum + standTargets(s), 0);

    const KEY_CURRENT = KEY;
    const KEY_HISTORY = KEY + ':history';

    const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const roundKey = (s) => `${(s.ground || '').trim().toLowerCase()}|${s.date || ''}|${(s.event || '').trim().toLowerCase()}`;
    const isNamedRound = (s) => !!((s.ground || '').trim() || (s.event || '').trim());
    const readHistory = () => { try { return JSON.parse(localStorage.getItem(KEY_HISTORY) || '{}'); } catch (e) { return {}; } };
    const writeHistory = (h) => { try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch (e) {} };

    // yyyymmdd from an ISO date string like "2026-07-06" -> "260706".
    const yyyymmdd = (iso) => (!iso || iso.length < 10) ? '' : iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
    // Filename-safe slug: lowercase alphanumerics with dashes.
    const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Stem shared by every export: `YYYYMMDD-${discipline}[-ground][-event]`. Empty parts are skipped.
    const filenameStem = () => [yyyymmdd(state.date), D.id, slug(state.ground), slug(state.event)].filter(Boolean).join('_');

    // Minimal RFC-4180ish CSV helpers. Quote values that contain comma/quote/newline;
    // parser respects quoted fields and "" escaping so round-tripping user-typed ground
    // or shooter names (e.g. "Smith, John") is safe.
    const csvEscape = (v) => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    function csvParseLine(line) {
        const out = [];
        let cur = '', inQ = false, i = 0;
        while (i < line.length) {
            const c = line[i];
            if (inQ) {
                if (c === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
                    inQ = false; i++;
                } else { cur += c; i++; }
            } else {
                if (c === ',') { out.push(cur); cur = ''; i++; }
                else if (c === '"' && cur === '') { inQ = true; i++; }
                else { cur += c; i++; }
            }
        }
        out.push(cur);
        return out;
    }

    // Accepts YYYYMMDD, YYMMDD, or already-ISO YYYY-MM-DD and returns YYYY-MM-DD (or null).
    function parseDateField(str) {
        if (!str) return null;
        const s = String(str).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const digits = s.replace(/[^0-9]/g, '');
        if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        if (digits.length === 6) return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
        return null;
    }

    function normalizeClayMeta(meta, total) {
        const current = Array.isArray(meta) ? meta : [];
        return Array.from({ length: total }, (_, idx) => {
            const item = current[idx] || {};
            return {
                presentation: item.presentation || '',
                direction: Array.isArray(item.direction) ? item.direction.filter(v => CLAY_META_OPTIONS.direction.includes(v)) : [],
                starting: item.starting || '',
                travelling: item.travelling || '',
                claySize: item.claySize || '',
                clayFace: item.clayFace || '',
                clayVisibility: item.clayVisibility || '',
                colour: item.colour || ''
            };
        });
    }

    function clayMetaSummary(meta, idx) {
        if (!meta) return '';
        const parts = [
            meta.presentation,
            ...(meta.direction || []),
            meta.starting,
            meta.travelling,
            meta.claySize,
            meta.clayFace,
            meta.clayVisibility,
            meta.colour
        ].filter(Boolean);
        return parts.length ? `C${idx + 1}: ${parts.join(' ')}` : '';
    }

    function clayMetaShortLabel(meta, fallback) {
        const parts = [
            meta.presentation,
            (meta.direction || []).join('/'),
            meta.starting,
            meta.travelling,
            meta.claySize,
            meta.clayFace,
            meta.clayVisibility,
            meta.colour
        ].filter(Boolean);
        return parts.length ? parts.join(' ') : fallback;
    }

    function standPresentationText(stand) {
        const clayText = (stand.clayMeta || []).map(clayMetaSummary).filter(Boolean).join(' | ');
        return clayText;
    }

    function clayMetaOptionRow(targetIdx, key, label, options, value, multi = false) {
        const selected = multi ? (Array.isArray(value) ? value : []) : [];
        return `<div class="space-y-1">
            <div class="text-[8px] font-black uppercase tracking-widest text-slate-400">${label}</div>
            <div data-meta-row class="flex flex-wrap gap-1">
                ${options.map(opt => {
                    const checked = multi ? selected.includes(opt) : value === opt;
                    const inputType = multi ? 'checkbox' : 'radio';
                    const name = multi ? '' : `name="clay-${targetIdx}-${key}"`;
                    const handler = multi
                        ? `updateClayMeta(${targetIdx}, '${key}', Array.from(this.closest('[data-meta-row]').querySelectorAll('input:checked')).map(input => input.value).join(','))`
                        : `updateClayMeta(${targetIdx}, '${key}', this.checked ? this.value : '')`;
                    return `<label class="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-[9px] font-black uppercase text-slate-600">
                        <input type="${inputType}" ${name} value="${escapeHtml(opt)}" ${checked ? 'checked' : ''} onchange="${handler}">
                        ${escapeHtml(opt)}
                    </label>`;
                }).join('')}
            </div>
        </div>`;
    }

    function renderClayMetaControls(stand) {
        if (!HAS_STAND_DESCRIPTIONS) return '';
        const total = presentationCountForStand(stand);
        stand.clayMeta = normalizeClayMeta(stand.clayMeta, total);
        return stand.clayMeta.map((meta, idx) => {
            const isSportingExtra = !D.fixedStands && stand.extraClay && idx === total - 1;
            const label = isSportingExtra ? 'Extra' : presentationLabel(idx);
            return `<details data-clay-meta-control class="relative">
                <summary class="list-none cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[9px] font-black uppercase text-white truncate">
                    <span class="text-orange-400">${label}</span>
                    <span data-clay-meta-summary="${idx}" class="normal-case font-bold text-slate-300 ml-1">${escapeHtml(clayMetaShortLabel(meta, 'Set presentation'))}</span>
                </summary>
                <div class="absolute right-0 z-30 mt-1 w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-2 shadow-xl space-y-2">
                    ${clayMetaOptionRow(idx, 'presentation', 'Presentation', CLAY_META_OPTIONS.presentation, meta.presentation)}
                    ${clayMetaOptionRow(idx, 'direction', 'Direction', CLAY_META_OPTIONS.direction, meta.direction, true)}
                    ${clayMetaOptionRow(idx, 'starting', 'Starting', CLAY_META_OPTIONS.starting, meta.starting)}
                    ${clayMetaOptionRow(idx, 'travelling', 'Travelling', CLAY_META_OPTIONS.travelling, meta.travelling)}
                    ${clayMetaOptionRow(idx, 'claySize', 'Clay Size', CLAY_META_OPTIONS.claySize, meta.claySize)}
                    ${clayMetaOptionRow(idx, 'clayFace', 'Clay Face', CLAY_META_OPTIONS.clayFace, meta.clayFace)}
                    ${clayMetaOptionRow(idx, 'clayVisibility', 'Clay Face Amount', CLAY_META_OPTIONS.clayVisibility, meta.clayVisibility)}
                    ${clayMetaOptionRow(idx, 'colour', 'Colour', CLAY_META_OPTIONS.colour, meta.colour)}
                </div>
            </details>`;
        }).join('');
    }

    function normalizeShotPresentationMap(values, totalShots, presentationCount) {
        const current = Array.isArray(values) ? values : [];
        return Array.from({ length: totalShots }, (_, idx) => {
            const value = parseInt(current[idx], 10);
            return value >= 1 && value <= presentationCount ? value : '';
        });
    }

    function defaultShotFormat(idx) {
        if (D.id === 'sportrap') {
            if (idx === 1) return 'report';
            if (idx === 3) return 'sim';
        }
        return 'single';
    }

    function isOldSportrapDefault(values, totalShots) {
        if (D.id !== 'sportrap' || totalShots !== 5 || !Array.isArray(values)) return false;
        const joined = values.slice(0, 5).join(',');
        return joined === 'report,single,single,sim,single'
            || joined === 'single,report,report,sim,sim';
    }

    function normalizeShotFormatMap(values, totalShots) {
        const current = isOldSportrapDefault(values, totalShots) ? [] : (Array.isArray(values) ? values : []);
        return Array.from({ length: totalShots }, (_, idx) => {
            const value = current[idx];
            return ['single', 'report', 'sim'].includes(value) ? value : defaultShotFormat(idx);
        });
    }

    function legacyShotFormatMap(stand) {
        if (!state.presentationFormat || !Array.isArray(state.shooters)) return [];
        const shooterWithFormat = state.shooters.find(sh => Array.isArray(state.presentationFormat?.[sh.id]?.[stand.id]));
        return shooterWithFormat ? state.presentationFormat[shooterWithFormat.id][stand.id] : [];
    }

    function legacyShotPresentationMap(stand) {
        if (!state.presentationMap || !Array.isArray(state.shooters)) return [];
        const shooterWithPresentation = state.shooters.find(sh => Array.isArray(state.presentationMap?.[sh.id]?.[stand.id]));
        return shooterWithPresentation ? state.presentationMap[shooterWithPresentation.id][stand.id] : [];
    }

    function getShotPresentationMap(shId, stand) {
        if (!HAS_PRESENTATION_MAP) return [];
        state.presentationMap = state.presentationMap || {};
        state.presentationMap[shId] = state.presentationMap[shId] || {};
        const normalized = normalizeShotPresentationMap(
            state.presentationMap[shId][stand.id],
            standTargets(stand),
            presentationCountForStand(stand)
        );
        state.presentationMap[shId][stand.id] = normalized;
        return normalized;
    }

    function getStandPresentationMap(stand) {
        if (!HAS_PRESENTATION_MAP) return [];
        state.standPresentation = state.standPresentation || {};
        const source = Array.isArray(state.standPresentation[stand.id]) ? state.standPresentation[stand.id] : legacyShotPresentationMap(stand);
        const normalized = normalizeShotPresentationMap(source, standTargets(stand), presentationCountForStand(stand));
        state.standPresentation[stand.id] = normalized;
        return normalized;
    }

    function getStandFormatMap(stand) {
        if (!HAS_PRESENTATION_MAP) return [];
        state.standFormat = state.standFormat || {};
        const source = Array.isArray(state.standFormat[stand.id]) ? state.standFormat[stand.id] : legacyShotFormatMap(stand);
        const normalized = normalizeShotFormatMap(source, standTargets(stand));
        state.standFormat[stand.id] = normalized;
        return normalized;
    }

    function resetSportrapStandFormatDefaults() {
        if (D.id !== 'sportrap') return;
        state.standFormat = state.standFormat || {};
        state.stands.forEach(st => {
            state.standFormat[st.id] = normalizeShotFormatMap([], standTargets(st));
        });
        state._sportrapStandFormatDefaultVersion = SPORTRAP_STAND_FORMAT_DEFAULT_VERSION;
    }

    function physicalStandCount() {
        return Math.max(1, D.fixedStands?.length || state.stands?.length || 1);
    }

    function defaultShooterRoundStand(shId, roundId) {
        const count = physicalStandCount();
        const shooterIdx = Math.max(0, state.shooters.findIndex(sh => sh.id === shId));
        const roundIdx = Math.max(0, state.stands.findIndex(st => st.id === roundId));
        return ((shooterIdx + roundIdx) % count) + 1;
    }

    function resetShooterStandDefaults() {
        if (!HAS_PRESENTATION_MAP) return;
        state.shooterStand = {};
        state.shooters.forEach(sh => {
            state.shooterStand[sh.id] = {};
            state.stands.forEach(st => {
                state.shooterStand[sh.id][st.id] = defaultShooterRoundStand(sh.id, st.id);
            });
        });
        state._standRotationDefaultVersion = STAND_ROTATION_DEFAULT_VERSION;
    }

    function getShooterRoundStand(shId, roundId) {
        if (!HAS_PRESENTATION_MAP) return '';
        state.shooterStand = state.shooterStand || {};
        state.shooterStand[shId] = state.shooterStand[shId] || {};
        const count = physicalStandCount();
        const existing = parseInt(state.shooterStand[shId][roundId], 10);
        if (existing >= 1 && existing <= count) return existing;
        const defaultStand = defaultShooterRoundStand(shId, roundId);
        state.shooterStand[shId][roundId] = defaultStand;
        return defaultStand;
    }

    // Note: the outer `history` variable is the undo snapshot — the persisted round history
    // dict is read/written via readHistory()/writeHistory() to avoid the name collision.
    let history = null;
    let state;

    function makeDefaultState() {
        const stands = D.fixedStands
            ? D.fixedStands.map(s => {
                const stand = { ...s, extraClay: !!s.extraClay, description: HAS_STAND_DESCRIPTIONS ? (s.description || '') : '' };
                stand.clayMeta = normalizeClayMeta(s.clayMeta, presentationCountForStand(stand));
                return stand;
            })
            : Array.from({ length: D.defaults.standCount }, (_, i) => ({
                id: i + 1, targets: D.defaults.targetsPerStand, extraClay: false, description: '', clayMeta: normalizeClayMeta([], 2)
            }));
        return {
            ground: '', date: new Date().toISOString().split('T')[0], event: '', notes: '',
            shooters: [{ id: Date.now(), name: 'Shooter 1', cpsa: '', class: 'U' }],
            stands, hits: {}, optionHits: {}, activeIdx: 0, isLocked: false
        };
    }

    function normalizeStands(stands) {
        const current = Array.isArray(stands) ? stands : [];
        if (!D.fixedStands) {
            return current.map(st => {
                const normalized = { ...st, extraClay: !!st.extraClay, description: HAS_STAND_DESCRIPTIONS ? (st.description || '') : '' };
                normalized.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(normalized));
                return normalized;
            });
        }
        return D.fixedStands.map((fixed, idx) => {
            const existing = current.find(st => st.id === fixed.id) || current[idx] || {};
            const normalized = {
                ...fixed,
                extraClay: !!fixed.extraClay,
                description: HAS_STAND_DESCRIPTIONS ? (existing.description || fixed.description || '') : '',
                ...(existing.presentationCount ? { presentationCount: existing.presentationCount } : {})
            };
            normalized.clayMeta = normalizeClayMeta(existing.clayMeta || fixed.clayMeta, presentationCountForStand(normalized));
            return normalized;
        });
    }

    function normalizeState() {
        state.stands = normalizeStands(state.stands);
        state.optionHits = state.optionHits || {};
        state.presentationMap = state.presentationMap || {};
        state.presentationFormat = state.presentationFormat || {};
        state.standFormat = state.standFormat || {};
        state.standPresentation = state.standPresentation || {};
        state.shooterStand = state.shooterStand || {};

        // Previous Skeet build stored the option as a fifth Station 7 target.
        // Move that saved value into the per-shooter floating option slot.
        if (OPTION && OPTION.migrateFromStandId) {
            state.shooters.forEach(sh => {
                const arr = state.hits?.[sh.id]?.[OPTION.migrateFromStandId];
                if (arr && arr.length > OPTION.migrateFromIndex && !state.optionHits[sh.id]) {
                    const hit = arr[OPTION.migrateFromIndex];
                    if (hit !== null && hit !== undefined) {
                        state.optionHits[sh.id] = { standId: OPTION.fallbackStandId, hit };
                    }
                }
            });
        }
        if (OPTION) state.shooters.forEach(sh => reconcileOptionHit(sh.id));
        if (HAS_PRESENTATION_MAP) {
            if (state._standRotationDefaultVersion !== STAND_ROTATION_DEFAULT_VERSION) {
                resetShooterStandDefaults();
            }
            if (D.id === 'sportrap' && state._sportrapStandFormatDefaultVersion !== SPORTRAP_STAND_FORMAT_DEFAULT_VERSION) {
                resetSportrapStandFormatDefaults();
            }
            state.stands.forEach(st => {
                getStandFormatMap(st);
                getStandPresentationMap(st);
            });
            state.shooters.forEach(sh => state.stands.forEach(st => {
                getShooterRoundStand(sh.id, st.id);
            }));
        }
    }

    function shooterScheduledStats(shId) {
        let hit = 0, shot = 0, firstMissStandId = null;
        state.stands.forEach(st => {
            const total = standTargets(st);
            const arr = state.hits[shId]?.[st.id] || [];
            for (let i = 0; i < total; i++) {
                if (arr[i] === true) hit++;
                if (arr[i] !== null && arr[i] !== undefined) shot++;
                if (arr[i] === false && firstMissStandId === null) firstMissStandId = st.id;
            }
        });
        return { hit, shot, firstMissStandId };
    }

    function getOptionStandId(shId) {
        if (!OPTION) return null;
        const existing = state.optionHits?.[shId];
        if (existing?.standId) return existing.standId;
        const stats = shooterScheduledStats(shId);
        if (stats.firstMissStandId !== null) return stats.firstMissStandId;
        if (stats.shot >= scheduledRoundTargets() && stats.hit === scheduledRoundTargets()) {
            return OPTION.fallbackStandId || state.stands[state.stands.length - 1]?.id || null;
        }
        return null;
    }

    function getOptionHit(shId) {
        const opt = state.optionHits?.[shId];
        return opt ? opt.hit : null;
    }

    function getOptionHitForStand(shId, stId) {
        const opt = state.optionHits?.[shId];
        return opt && opt.standId === stId ? opt.hit : null;
    }

    function shooterStandStats(shId, stand) {
        const total = standTargets(stand);
        const arr = state.hits[shId]?.[stand.id] || [];
        let hits = 0, shot = 0;
        for (let i = 0; i < total; i++) {
            if (arr[i] === true) hits++;
            if (arr[i] !== null && arr[i] !== undefined) shot++;
        }
        const opt = getOptionHitForStand(shId, stand.id);
        const hasOption = OPTION && getOptionStandId(shId) === stand.id;
        if (hasOption && opt !== null && opt !== undefined) {
            shot++;
            if (opt === true) hits++;
        }
        const possible = total + (hasOption ? 1 : 0);
        return { hits, shot, possible, completed: shot >= possible };
    }

    function completedStandDifficulty(stand) {
        if (!state.shooters.length) return null;
        let hits = 0, possible = 0;
        for (const sh of state.shooters) {
            const stats = shooterStandStats(sh.id, stand);
            if (!stats.completed) return null;
            hits += stats.hits;
            possible += stats.possible;
        }
        return possible > 0 ? { id: stand.id, avg: hits / possible } : null;
    }

    function reconcileOptionHit(shId) {
        if (!OPTION || !state.optionHits?.[shId]) return;
        const stats = shooterScheduledStats(shId);
        const straightComplete = stats.shot >= scheduledRoundTargets() && stats.hit === scheduledRoundTargets();
        const validStandId = stats.firstMissStandId !== null
            ? stats.firstMissStandId
            : (straightComplete ? (OPTION.fallbackStandId || state.stands[state.stands.length - 1]?.id) : null);

        if (validStandId === null) {
            delete state.optionHits[shId];
        } else if (state.optionHits[shId].standId !== validStandId) {
            state.optionHits[shId].standId = validStandId;
        }
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

    function cloneData(value) {
        return JSON.parse(JSON.stringify(value || {}));
    }

    function replaceHistory(store) {
        writeHistory(store || {});
        renderHistory();
    }

    function refreshCurrentRoundFromHistory() {
        if (!state._roundKey) return false;
        const store = readHistory();
        const round = store[state._roundKey];
        if (!round) return false;
        state = Object.assign({}, makeDefaultState(), round);
        normalizeState();
        render();
        saveStateOnly();
        return true;
    }

    function setMenuExpanded(name, expanded) {
        const button = document.getElementById(`${name}-menu-btn`);
        const menu = document.getElementById(`${name}-dropdown`);
        if (!button || !menu) return;
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        menu.classList.toggle('hidden', !expanded);
    }

    window.closeHeaderMenus = () => {
        setMenuExpanded('history', false);
        setMenuExpanded('cloud', false);
        setMenuExpanded('export', false);
    };

    window.toggleHeaderMenu = (name) => {
        const menu = document.getElementById(`${name}-dropdown`);
        if (!menu) return;
        const willOpen = menu.classList.contains('hidden');
        window.closeHeaderMenus();
        if (willOpen) setMenuExpanded(name, true);
    };

    function closeClayMetaControls() {
        document.querySelectorAll('[data-clay-meta-control][open]').forEach(detail => { detail.open = false; });
    }

    function load() {
        const s = localStorage.getItem(KEY_CURRENT);
        if (!s) return false;
        try {
            const parsed = JSON.parse(s);
            state = Object.assign({}, state, parsed);
            normalizeState();
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
                state.stands.push({ id: i, targets: D.defaults.targetsPerStand, extraClay: false, description: '', clayMeta: normalizeClayMeta([], 2) });
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
        if (state.presentationMap) delete state.presentationMap[id];
        if (state.presentationFormat) delete state.presentationFormat[id];
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
        history = { hits: JSON.parse(JSON.stringify(state.hits)), optionHits: JSON.parse(JSON.stringify(state.optionHits || {})) };
        const arr = ensureHitsArray(shId, stand);
        const curr = arr[idx];
        arr[idx] = (curr === val) ? null : val;
        reconcileOptionHit(shId);
        if (arr[idx] !== null && navigator.vibrate) {
            val ? navigator.vibrate(50) : navigator.vibrate([40, 40, 40]);
        }
        render(); save();
    };

    window.toggleOptionHit = (shId, stId, val) => {
        if (state.isLocked || !OPTION) return;
        const optionStandId = getOptionStandId(shId);
        if (optionStandId !== stId) return;
        history = { hits: JSON.parse(JSON.stringify(state.hits)), optionHits: JSON.parse(JSON.stringify(state.optionHits || {})) };
        if (!state.optionHits) state.optionHits = {};
        const curr = state.optionHits[shId]?.hit ?? null;
        if (curr === val) {
            delete state.optionHits[shId];
        } else {
            state.optionHits[shId] = { standId: stId, hit: val };
        }
        if (val !== null && navigator.vibrate) {
            val ? navigator.vibrate(50) : navigator.vibrate([40, 40, 40]);
        }
        render(); save();
    };

    window.undo = () => {
        if (!history) return;
        if (history.hits) {
            state.hits = history.hits;
            state.optionHits = history.optionHits || {};
        } else {
            state.hits = history;
        }
        history = null; render(); save();
    };

    window.setBirds = (c) => {
        if (state.isLocked || !D.editable.targetsPerStand) return;
        const st = state.stands[state.activeIdx];
        st.targets = c;
        st.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(st));
        state.shooters.forEach(sh => { if (state.hits[sh.id]?.[st.id]) ensureHitsArray(sh.id, st); });
        render(); save();
    };

    window.setExtraClay = () => {
        if (state.isLocked || !D.editable.extraClay) return;
        const st = state.stands[state.activeIdx];
        st.extraClay = !st.extraClay;
        st.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(st));
        state.shooters.forEach(sh => { if (state.hits[sh.id]?.[st.id]) ensureHitsArray(sh.id, st); });
        render(); save();
    };

    // Free-text description for the presentation of clays at the active stand
    // (e.g. "left-to-right crosser + rabbit"). Persists per-round so it survives
    // history load/save, and appears in every export (CSV Descriptions line,
    // PDF + PNG grid header subtitle).
    window.updateStandDescription = (v) => {
        if (state.isLocked || !HAS_STAND_DESCRIPTIONS) return;
        const st = state.stands[state.activeIdx];
        if (!st) return;
        st.description = v;
        save();
    };

    window.updateClayMeta = (targetIdx, key, value) => {
        if (state.isLocked || !HAS_STAND_DESCRIPTIONS) return;
        const st = state.stands[state.activeIdx];
        if (!st) return;
        st.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(st));
        if (!st.clayMeta[targetIdx]) return;
        st.clayMeta[targetIdx][key] = key === 'direction'
            ? String(value || '').split(',').filter(Boolean)
            : value;
        const summaryEl = document.querySelector(`[data-clay-meta-summary="${targetIdx}"]`);
        if (summaryEl) summaryEl.textContent = clayMetaShortLabel(st.clayMeta[targetIdx], 'Set presentation');
        save();
    };

    window.updateShotPresentation = (shId, stId, shotIdx, value) => {
        if (state.isLocked || !HAS_PRESENTATION_MAP) return;
        const st = state.stands.find(s => s.id === stId);
        if (!st) return;
        const map = getShotPresentationMap(shId, st);
        const parsed = parseInt(value, 10);
        map[shotIdx] = Number.isFinite(parsed) ? parsed : '';
        save();
    };

    window.updateStandShotPresentation = (stId, shotIdx, value) => {
        if (state.isLocked || !HAS_PRESENTATION_MAP) return;
        const st = state.stands.find(s => s.id === stId);
        if (!st) return;
        const map = getStandPresentationMap(st);
        const parsed = parseInt(value, 10);
        map[shotIdx] = Number.isFinite(parsed) ? parsed : '';
        save(); render();
    };

    window.updateStandShotFormat = (stId, shotIdx, value) => {
        if (state.isLocked || !HAS_PRESENTATION_MAP) return;
        const st = state.stands.find(s => s.id === stId);
        if (!st) return;
        const formats = getStandFormatMap(st);
        formats[shotIdx] = ['single', 'report', 'sim'].includes(value) ? value : 'single';
        save(); render();
    };

    window.updateShooterRoundStand = (shId, roundId, value) => {
        if (state.isLocked || !HAS_PRESENTATION_MAP) return;
        state.shooterStand = state.shooterStand || {};
        state.shooterStand[shId] = state.shooterStand[shId] || {};
        const parsed = parseInt(value, 10);
        state.shooterStand[shId][roundId] = parsed >= 1 && parsed <= physicalStandCount() ? parsed : getShooterRoundStand(shId, roundId);
        save(); render();
    };

    window.addPresentationOption = () => {
        if (state.isLocked || D.id !== 'compak') return;
        const st = state.stands[state.activeIdx];
        st.presentationCount = presentationCountForStand(st) + 1;
        st.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(st));
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
        if (getOptionHit(shId) === true) t++;
        return t;
    }

    async function deleteRemoteRoundIfAvailable(key) {
        const deleteRemoteRound = window.ClayScorerCloud?.deleteRemoteRound;
        if (!key || typeof deleteRemoteRound !== 'function') return;
        try {
            await deleteRemoteRound(key);
        } catch (err) {
            console.warn('[ClayScorer] Firebase round delete failed', err);
            alert('Deleted locally, but the Firebase delete failed. Try cloud sync again when you are online.');
        }
    }

    async function deleteRemoteHistoryIfAvailable() {
        const deleteRemoteHistory = window.ClayScorerCloud?.deleteRemoteHistory;
        if (typeof deleteRemoteHistory !== 'function') return;
        try {
            await deleteRemoteHistory();
        } catch (err) {
            console.warn('[ClayScorer] Firebase history delete failed', err);
            alert('Deleted local history, but the Firebase history delete failed. Try cloud sync again when you are online.');
        }
    }

    window.deleteCurrentRound = async () => {
        const key = state._roundKey || (isNamedRound(state) ? roundKey(state) : null);
        const store = readHistory();
        const storedRound = key ? store[key] : null;
        const label = ((storedRound || state).ground || '').trim()
            || ((storedRound || state).event || '').trim()
            || getUKDate((storedRound || state).date);
        const hasStoredRound = key && !!storedRound;
        const message = hasStoredRound
            ? `Delete "${label}" from current round, history, and Firebase if synced?`
            : `Delete the current ${D.name} round from this device?`;
        if (!confirm(message)) return;

        if (hasStoredRound) {
            delete store[key];
            writeHistory(store);
            await deleteRemoteRoundIfAvailable(key);
        }
        localStorage.removeItem(KEY_CURRENT);
        state = makeDefaultState();
        history = null;
        saveStateOnly();
        render();
    };

    window.deleteHistory = async () => {
        if (!confirm(`Delete all saved ${D.name} round history and the current round from this device and Firebase if synced?`)) return;
        writeHistory({});
        localStorage.removeItem(KEY_HISTORY);
        localStorage.removeItem(KEY_CURRENT);
        state = makeDefaultState();
        history = null;
        saveStateOnly();
        render();
        await deleteRemoteHistoryIfAvailable();
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
        normalizeState();
        if (!state.stands.length) state.stands = makeDefaultState().stands;
        state.activeIdx = Math.min(state.activeIdx || 0, state.stands.length - 1);
        history = null;
        render(); save();
    };

    window.deleteRound = async (key) => {
        const store = readHistory();
        if (!store[key]) return;
        const round = store[key];
        const label = (round.ground || '').trim() || (round.event || '').trim() || getUKDate(round.date);
        if (!confirm(`Delete round "${label}" from history?`)) return;
        delete store[key];
        writeHistory(store);
        await deleteRemoteRoundIfAvailable(key);
        if (state._roundKey === key) {
            state = makeDefaultState();
            history = null;
            save();
        }
        render();
    };

    window.downloadCSV = () => {
        const q = csvEscape;
        const abbr = ROUND_LABEL.slice(0, 2).toUpperCase();
        // Header block: Discipline / Date / Ground / Event / Rounds/Stands (base + optional +1 per row)
        let csv = `Discipline,${q(D.name)}\n`;
        csv += `Date,${yyyymmdd(state.date)}\n`;
        csv += `Ground,${q(state.ground)}\n`;
        csv += `Event,${q(state.event)}\n`;
        csv += `${HAS_PRESENTATION_MAP ? 'Rounds' : 'Stands'},${state.stands.map(s => `${s.targets}${s.extraClay ? '+1' : ''}`).join(',')}\n`;
        if (OPTION) csv += `Option Target,${q(OPTION.label || 'OPT')}\n`;
        // Only emit the Descriptions line if any stand actually has one — keeps the CSV
        // tidy for rounds that never used the field.
        if (HAS_STAND_DESCRIPTIONS && state.stands.some(s => (s.description || '').trim())) {
            csv += `Descriptions,${state.stands.map(s => q(s.description || '')).join(',')}\n`;
        }
        if (HAS_STAND_DESCRIPTIONS && state.stands.some(s => (s.clayMeta || []).some(meta => clayMetaSummary(meta, 0)))) {
            csv += `Clay Metadata,${state.stands.map(s => q(JSON.stringify(normalizeClayMeta(s.clayMeta, presentationCountForStand(s))))).join(',')}\n`;
        }
        csv += `\n`;
        // Totals block: per-shooter, per-stand hits + grand total
        csv += `Shooter,CPSA,Class,`;
        csv += state.stands.map(s => `${abbr}${s.id}${s.extraClay ? '+1' : ''}`).join(',') + ',Total\n';
        state.shooters.forEach(s => {
            const perStand = state.stands.map(st => {
                const base = state.hits[s.id]?.[st.id]?.filter(h => h === true).length || 0;
                return base + (getOptionHitForStand(s.id, st.id) === true ? 1 : 0);
            });
            csv += `${q(s.name)},${q(s.cpsa)},${q(s.class)},${perStand.join(',')},${getShooterTotal(s.id)}\n`;
        });
        // Details block: per-target H (hit) / M (miss) / . (not shot). Lets importCSV
        // reconstruct the exact hit arrays instead of falling back to "N hits at front".
        csv += `\nDetails\nShooter,Stand,Shots\n`;
        state.shooters.forEach(s => {
            state.stands.forEach(st => {
                const arr = state.hits[s.id]?.[st.id];
                if (!arr || !arr.length) return;
                const shots = arr.map(h => h === true ? 'H' : h === false ? 'M' : '.').join('');
                csv += `${q(s.name)},${st.id},${shots}\n`;
            });
        });
        if (OPTION) {
            csv += `\nOption\nShooter,Stand,Shot\n`;
            state.shooters.forEach(s => {
                const opt = state.optionHits?.[s.id];
                if (!opt || opt.hit === null || opt.hit === undefined) return;
                csv += `${q(s.name)},${opt.standId},${opt.hit === true ? 'H' : 'M'}\n`;
            });
        }
        const blob = new Blob([csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${filenameStem()}.csv`;
        a.click();
    };

    // Parse an exported CSV back into { meta, stands, shooters, totals, details }.
    // Both the new format (with Stands line + Details block) and legacy exports work.
    function parseCSV(text) {
        const lines = text.replace(/\r\n?/g, '\n').split('\n');
        const meta = {};
        let stands = null;              // [{ targets, extraClay, description? }]
        let descriptions = null;        // parallel array of strings, applied to stands below
        let clayMetadata = null;        // parallel array of per-stand clay metadata JSON strings
        const shooters = [];            // [{ name, cpsa, class }]
        const totals = {};              // shooterName -> [perStandHits]
        const details = {};             // shooterName -> { standId -> shotString }
        const optionDetails = {};       // shooterName -> { standId, hit }

        let i = 0;
        // Header block: Key,Value lines until blank line
        while (i < lines.length && lines[i].trim()) {
            const parts = csvParseLine(lines[i]);
            const [key, ...rest] = parts;
            if (key === 'Discipline') meta.discipline = rest[0];
            else if (key === 'Date') meta.date = rest[0];
            else if (key === 'Ground') meta.ground = rest[0];
            else if (key === 'Event') meta.event = rest[0];
            else if (key === 'Option Target') meta.optionTarget = rest[0];
            else if (key === 'Stands' || key === 'Rounds') {
                stands = rest.filter(spec => spec !== '' || rest.length === 1).map(spec => {
                    const m = String(spec).match(/^(\d+)(\+1)?$/);
                    return m ? { targets: parseInt(m[1], 10), extraClay: !!m[2] } : null;
                }).filter(Boolean);
            }
            else if (key === 'Descriptions') {
                // rest is a parallel array to Stands — one entry per stand, possibly empty.
                descriptions = rest;
            }
            else if (key === 'Clay Metadata') {
                clayMetadata = rest;
            }
            i++;
        }
        // Merge descriptions into stands (positional match)
        if (stands && descriptions) {
            stands = stands.map((s, idx) => ({ ...s, description: descriptions[idx] || '' }));
        }
        if (stands && clayMetadata) {
            stands = stands.map((s, idx) => {
                let parsedMeta = [];
                try { parsedMeta = JSON.parse(clayMetadata[idx] || '[]'); } catch (e) { parsedMeta = []; }
                const standForCount = { ...s, id: idx + 1 };
                const presentationCount = Math.max(presentationCountForStand(standForCount), parsedMeta.length);
                return { ...s, presentationCount, clayMeta: normalizeClayMeta(parsedMeta, presentationCount) };
            });
        }
        while (i < lines.length && !lines[i].trim()) i++;

        // Totals block header
        if (i >= lines.length) throw new Error('missing totals block');
        const totalsHeader = csvParseLine(lines[i++]);
        if (totalsHeader[0] !== 'Shooter') throw new Error('malformed totals header');
        const standCols = [];
        for (let c = 3; c < totalsHeader.length - 1; c++) {
            const m = String(totalsHeader[c]).match(/^[A-Z]{1,3}(\d+)(\+1)?$/);
            standCols.push(m ? { id: parseInt(m[1], 10), extraClay: !!m[2] } : { id: c - 2, extraClay: false });
        }
        // Fall back to inferring stands from header columns if the Stands line was absent
        if (!stands) {
            const defaultTargets = D.fixedStands ? null : (D.defaults?.targetsPerStand || 8);
            stands = standCols.map((sc, idx) => ({
                targets: D.fixedStands ? (D.fixedStands[idx]?.targets ?? defaultTargets ?? 8) : defaultTargets,
                extraClay: sc.extraClay,
                clayMeta: [],
            }));
        }
        // Attach the id from the totals header (in case ids aren't 1..N contiguous)
        stands = stands.map((s, idx) => ({ ...s, id: standCols[idx]?.id ?? idx + 1 }));

        // Totals rows: until blank line, next section header, or EOF
        while (i < lines.length && lines[i].trim() && lines[i].trim() !== 'Details') {
            const parts = csvParseLine(lines[i++]);
            const [name, cpsa, cls] = parts;
            if (!name) continue;
            shooters.push({ name, cpsa: cpsa || '', class: cls || 'U' });
            totals[name] = stands.map((_, sIdx) => parseInt(parts[3 + sIdx], 10) || 0);
        }
        while (i < lines.length && !lines[i].trim()) i++;

        // Optional Details block
        if (i < lines.length && lines[i].trim() === 'Details') {
            i++;
            if (i < lines.length && csvParseLine(lines[i])[0] === 'Shooter') i++;
            while (i < lines.length && lines[i].trim()) {
                const [name, standStr, shots] = csvParseLine(lines[i++]);
                if (!name || !standStr || !shots) continue;
                const standId = parseInt(standStr, 10);
                if (!details[name]) details[name] = {};
                details[name][standId] = shots;
            }
        }
        while (i < lines.length && !lines[i].trim()) i++;

        // Optional Skeet option-target block.
        if (i < lines.length && lines[i].trim() === 'Option') {
            i++;
            if (i < lines.length && csvParseLine(lines[i])[0] === 'Shooter') i++;
            while (i < lines.length && lines[i].trim()) {
                const [name, standStr, shot] = csvParseLine(lines[i++]);
                if (!name || !standStr || !shot) continue;
                optionDetails[name] = { standId: parseInt(standStr, 10), hit: shot === 'H' ? true : shot === 'M' ? false : null };
            }
        }

        return { meta, stands, shooters, totals, details, optionDetails };
    }

    // File-picker onchange handler — hidden input lives inside the history section.
    window.handleImportChange = (input) => {
        const file = input.files?.[0];
        input.value = '';  // reset so the same file can be re-picked
        if (file) window.importCSV(file);
    };

    window.importCSV = async (file) => {
        let text;
        try { text = await file.text(); } catch (err) { alert('Could not read file: ' + err.message); return; }
        let parsed;
        try { parsed = parseCSV(text); } catch (err) { alert('Could not parse CSV: ' + err.message); return; }

        // Discipline guard — the shared engine can only score what the current page is set up for.
        if (parsed.meta.discipline && parsed.meta.discipline !== D.name && parsed.meta.discipline !== D.code) {
            alert(`This CSV is from "${parsed.meta.discipline}". Open that discipline's page and import there.`);
            return;
        }

        // Fixed disciplines: the CSV's stand structure must line up with the discipline's fixed layout.
        if (D.fixedStands) {
            const ok = parsed.stands.length === D.fixedStands.length
                && parsed.stands.every((s, idx) => {
                    const fixed = D.fixedStands[idx];
                    const isMigratedOptionStand = OPTION
                        && OPTION.migrateFromStandId === fixed.id
                        && s.targets === fixed.targets + 1;
                    return s.targets === fixed.targets || isMigratedOptionStand;
                });
            if (!ok) { alert(`Stand structure doesn't match ${D.name}'s fixed layout — import cancelled.`); return; }
        }

        const importedState = makeDefaultState();
        importedState.date = parseDateField(parsed.meta.date) || importedState.date;
        importedState.ground = parsed.meta.ground || '';
        importedState.event = parsed.meta.event || '';
        // Rebuild stands using imported target/extraClay/description + labels from D.fixedStands if it exists
        importedState.stands = parsed.stands.map((s, idx) => {
            const fixed = D.fixedStands?.[idx];
            return {
                id: s.id,
                targets: fixed?.targets ?? s.targets,
                extraClay: fixed ? !!fixed.extraClay : !!s.extraClay,
                description: HAS_STAND_DESCRIPTIONS ? (s.description || '') : '',
                ...(s.presentationCount ? { presentationCount: s.presentationCount } : {}),
                clayMeta: normalizeClayMeta(s.clayMeta, presentationCountForStand({ ...(fixed || s), ...(s.presentationCount ? { presentationCount: s.presentationCount } : {}), extraClay: fixed ? !!fixed.extraClay : !!s.extraClay })),
                ...(fixed?.labels ? { labels: fixed.labels } : {}),
            };
        });
        // Fresh shooter ids so they don't collide with any existing round's ids
        importedState.shooters = parsed.shooters.map((sh, idx) => ({
            id: Date.now() + idx,
            name: sh.name,
            cpsa: sh.cpsa,
            class: sh.class || 'U',
        }));
        // Reconstruct hits: prefer the Details block when present, otherwise pack N hits
        // then (total - N) misses so per-stand totals and the leaderboard match.
        importedState.hits = {};
        importedState.optionHits = {};
        importedState.shooters.forEach((sh, shIdx) => {
            importedState.hits[sh.id] = {};
            const srcName = parsed.shooters[shIdx].name;
            importedState.stands.forEach((st, stIdx) => {
                const total = standTargets(st);
                const detail = parsed.details[srcName]?.[st.id];
                let arr;
                if (detail) {
                    arr = detail.split('').slice(0, total).map(c => c === 'H' ? true : c === 'M' ? false : null);
                    while (arr.length < total) arr.push(null);
                } else {
                    const hitCount = Math.min(parsed.totals[srcName]?.[stIdx] || 0, total);
                    arr = Array.from({ length: total }, (_, k) => k < hitCount ? true : false);
                }
                importedState.hits[sh.id][st.id] = arr;
            });
            if (OPTION) {
                const opt = parsed.optionDetails?.[srcName];
                if (opt && opt.hit !== null && opt.hit !== undefined) {
                    importedState.optionHits[sh.id] = opt;
                } else if (OPTION.migrateFromStandId) {
                    const detail = parsed.details[srcName]?.[OPTION.migrateFromStandId];
                    const migratedShot = detail?.[OPTION.migrateFromIndex];
                    if (migratedShot === 'H' || migratedShot === 'M') {
                        importedState.optionHits[sh.id] = {
                            standId: OPTION.fallbackStandId,
                            hit: migratedShot === 'H'
                        };
                    } else {
                        const standIdx = parsed.stands.findIndex(st => st.id === OPTION.migrateFromStandId);
                        const legacyHits = parsed.totals[srcName]?.[standIdx];
                        const fixedTotal = D.fixedStands?.[standIdx]?.targets;
                        if (Number.isFinite(legacyHits) && Number.isFinite(fixedTotal) && legacyHits > fixedTotal) {
                            importedState.optionHits[sh.id] = {
                                standId: OPTION.fallbackStandId,
                                hit: true
                            };
                        }
                    }
                }
            }
        });
        const currentState = state;
        state = importedState;
        normalizeState();
        state = currentState;

        // Legacy CSVs (no `Details` block) can't tell us the real per-shot order —
        // we can only pack `hitCount` H's at the front and the remaining misses after.
        // Warn before proceeding so the user knows a subsequent re-export will show
        // that same "all hits then all misses" pattern rather than the true sequence.
        const hasDetails = Object.keys(parsed.details).length > 0;
        if (!hasDetails) {
            if (!confirm(
                'This CSV has no per-target Details block, so the exact hit/miss order can\'t be recovered.\n\n' +
                'Per-stand totals will be preserved, but hits will be packed at the start of each stand and misses at the end. ' +
                'A subsequent CSV export will show that same order.\n\n' +
                'Import anyway?'
            )) return;
        }

        const importKey = roundKey(importedState);
        const store = readHistory();
        if (!isNamedRound(importedState)) {
            alert('Import needs at least a Ground or Event so the round has an identity — aborting.');
            return;
        }
        if (store[importKey] && !confirm('A round already exists in history for this date/ground/event. Overwrite it?')) return;

        store[importKey] = { ...importedState, _roundKey: importKey, _updatedAt: Date.now() };
        writeHistory(store);
        renderHistory();

        if (confirm(`Imported "${importedState.ground || importedState.event}". Load it as the current round now?`)) {
            window.loadRound(importKey);
        }
    };

    function generateExportGrid(tid) {
        const grid = document.getElementById(tid);
        grid.innerHTML = '';
        const isShare = tid === 'cap-grid';
        const rowH = isShare ? '45px' : '30px';
        const headH = isShare ? '40px' : '25px';
        const pairH = isShare ? '25px' : '18px';
        const abbr = ROUND_LABEL.slice(0, 3).toUpperCase();
        const hitBg = '#4ade80';
        const missBg = '#f87171';
        const markStyle = isShare ? 'font-weight:900;' : 'font-weight:400; color:#334155;';
        const blockBorder = '1pt solid black';
        const standHeaderBorder = `border-left:${blockBorder} !important; border-right:${blockBorder} !important;`;
        const standEdgeBorder = (idx, count) => [
            idx === 0 ? `border-left:${blockBorder} !important;` : '',
            idx === count - 1 ? `border-right:${blockBorder} !important;` : ''
        ].filter(Boolean).join(' ');
        const shooterBorder = `border-top:${blockBorder} !important;`;
        const shooterBottomBorder = `border-bottom:${blockBorder} !important;`;
        const headerBottomBorder = `border-bottom:${blockBorder} !important;`;
        const markCellStyle = `${markStyle} line-height:1;${isShare ? ` height:${rowH}; min-height:${rowH};` : ''}`;
        const optionMarkStyle = `${markStyle} line-height:1;${isShare ? ' min-height:90px;' : ''}`;
        const markCell = (mark) => isShare
            ? `<div style="position:relative; width:100%; height:${rowH};"><div style="position:absolute; left:0; right:0; top:50%; transform:translateY(-58%); text-align:center; ${markStyle} line-height:1;">${mark}</div></div>`
            : `<div class="cell-center" style="${markCellStyle}">${mark}</div>`;
        const optionCell = (mark, stand) => isShare
            ? `<div style="position:relative; width:100%; height:90px;"><div style="position:absolute; left:0; right:0; top:50%; transform:translateY(-58%); text-align:center; ${markStyle} line-height:1;"><div>${mark}</div><div style="font-size:7pt; font-weight:normal; margin-top:2px;">${stand}</div></div></div>`
            : `<div class="cell-center" style="flex-direction:column; ${optionMarkStyle}"><span>${mark}</span><span style="font-size:7pt; font-weight:normal;">${stand}</span></div>`;

        let h = `<tr style="background:#f0f0f0"><th style="width:200px; vertical-align:middle; border-right:${blockBorder} !important; ${headerBottomBorder}" rowspan="2"><div class="cell-center">NAME</div></th>`;
        state.stands.forEach(st => {
            const total = standTargets(st);
            const pairCount = Math.ceil(total / 2);
            const descTxt = standPresentationText(st);
            const descHtml = descTxt
                ? `<div style="font-size:${isShare ? '9pt' : '7pt'}; font-style:italic; font-weight:normal; line-height:1.1; padding:2px 4px 0; white-space:normal; word-break:break-word;">${escapeHtml(descTxt)}</div>`
                : '';
            const heightStyle = descTxt ? '' : `height:${headH};`;
            h += `<th colspan="${pairCount}" style="vertical-align:middle; ${heightStyle} ${standHeaderBorder}"><div style="display:flex; flex-direction:column; align-items:center; justify-content:center; padding:2px 0;"><div style="font-weight:900;">${abbr} ${st.id}${st.extraClay ? '+1' : ''}</div>${descHtml}</div></th>`;
        });
        if (OPTION) {
            h += `<th style="width:70px; vertical-align:middle; border-left:${blockBorder} !important; border-right:${blockBorder} !important; ${headerBottomBorder}" rowspan="2"><div class="cell-center">${escapeHtml(OPTION.label || 'OPT')}</div></th>`;
        }
        h += `<th style="width:60px; vertical-align:middle; border-left:${blockBorder} !important; ${headerBottomBorder}" rowspan="2"><div class="cell-center">TOTAL</div></th></tr><tr>`;
        state.stands.forEach(st => {
            const total = standTargets(st);
            const pairCount = Math.ceil(total / 2);
            for (let p = 1; p <= pairCount; p++) {
                h += `<th style="font-size:6pt; height:${pairH}; background:#fafafa; vertical-align:middle; ${standEdgeBorder(p - 1, pairCount)} ${headerBottomBorder}"><div class="cell-center">P${p}</div></th>`;
            }
        });
        grid.innerHTML = h + '</tr>';

        const sorted = state.shooters.map(s => ({ ...s, t: getShooterTotal(s.id) })).sort((a, b) => b.t - a.t);
        sorted.forEach(s => {
            let r1 = `<tr><td style="text-align:left; padding-left:10px; vertical-align:middle; white-space:normal; border-right:${blockBorder} !important; ${shooterBorder} ${shooterBottomBorder}" rowspan="2"><strong>${s.name}</strong></td>`;
            let r2 = `<tr>`;
            state.stands.forEach(st => {
                const total = standTargets(st);
                const pairCount = Math.ceil(total / 2);
                const hits = state.hits[s.id]?.[st.id] || Array(total).fill(null);
                for (let i = 0; i < pairCount * 2; i += 2) {
                    const edgeStyle = standEdgeBorder(i / 2, pairCount);
                    const d = (idx) => {
                        if (idx >= total) return { m: '', bg: 'transparent' };
                        if (hits[idx] === true) return { m: '/', bg: hitBg };
                        if (hits[idx] === false) return { m: 'O', bg: missBg };
                        return { m: '', bg: 'transparent' };
                    };
                    const b1 = d(i), b2 = d(i + 1);
                    r1 += `<td style="background:${b1.bg}; height:${rowH}; vertical-align:middle; ${edgeStyle} ${shooterBorder}">${markCell(b1.m)}</td>`;
                    r2 += `<td style="background:${b2.bg}; height:${rowH}; vertical-align:middle; ${edgeStyle} ${shooterBottomBorder}">${markCell(b2.m)}</td>`;
                }
            });
            if (OPTION) {
                const opt = state.optionHits?.[s.id];
                const optMark = opt?.hit === true ? '/' : opt?.hit === false ? 'O' : '';
                const optBg = opt?.hit === true ? hitBg : opt?.hit === false ? missBg : 'transparent';
                const optStand = opt?.standId ? `${abbr} ${opt.standId}` : '';
                r1 += `<td style="background:${optBg}; vertical-align:middle; border-left:${blockBorder} !important; border-right:${blockBorder} !important; ${shooterBorder} ${shooterBottomBorder}" rowspan="2">${optionCell(optMark, optStand)}</td>`;
            }
            r1 += `<td style="font-weight:bold; font-size:16pt; vertical-align:middle; background:#fafafa; border-left:${blockBorder} !important; ${shooterBorder} ${shooterBottomBorder}" rowspan="2"><div class="cell-center">${s.t}</div></td></tr>`;
            grid.innerHTML += r1 + r2 + '</tr>';
        });
    }

    window.exportToPDF = () => {
        document.getElementById('p-ground').innerText = state.ground || 'N/A';
        document.getElementById('p-date').innerText = yyyymmdd(state.date) || 'N/A';
        document.getElementById('p-event').innerText = state.event || '';
        const evRow = document.getElementById('p-event-row');
        if (evRow) evRow.style.display = (state.event || '').trim() ? '' : 'none';
        document.getElementById('p-notes').innerText = state.notes || '';
        document.getElementById('p-discipline').innerText = D.name;
        generateExportGrid('p-grid');

        // The browser derives the print dialog's suggested filename from document.title.
        // Swap it, print, then restore on the afterprint event so the tab title stays clean.
        const prevTitle = document.title;
        document.title = filenameStem();
        const restore = () => { document.title = prevTitle; window.removeEventListener('afterprint', restore); };
        window.addEventListener('afterprint', restore);
        window.print();
    };

    window.shareAsImage = async () => {
        const container = document.getElementById('capture-container');
        document.getElementById('cap-ground').innerText = state.ground || 'N/A';
        document.getElementById('cap-date').innerText = yyyymmdd(state.date) || 'N/A';
        document.getElementById('cap-event').innerText = state.event || '';
        const capEv = document.getElementById('cap-event-row');
        if (capEv) capEv.style.display = (state.event || '').trim() ? '' : 'none';
        document.getElementById('cap-discipline').innerText = D.name;
        generateExportGrid('cap-grid');
        const filename = `${filenameStem()}.png`;
        try {
            container.style.position = 'fixed'; container.style.left = '0'; container.style.top = '0'; container.style.zIndex = '-1';
            const canvas = await html2canvas(container, { scale: 3, backgroundColor: '#ffffff', useCORS: true });
            container.style.position = 'absolute'; container.style.left = '-9999px';
            canvas.toBlob(async (blob) => {
                if (!blob) return;
                const file = new File([blob], filename, { type: 'image/png' });
                if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: `${D.name} Squad Leaderboard` });
                } else {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = filename;
                    a.click();
                }
            });
        } catch (e) { console.error(e); }
    };

    function mountSkeleton() {
        const setupStand = D.editable.standCount
            ? `<div class="space-y-1">
                 <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">${ROUND_LABEL} Count</label>
                 <select id="field-stand-count" onchange="updateStandCount(this.value)" class="w-full bg-slate-50 border-none rounded-lg p-2 text-xs font-black">
                   ${Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}">${i + 1} ${ROUND_LABEL}${i > 0 ? 's' : ''}</option>`).join('')}
                 </select>
               </div>`
            : `<div class="space-y-1">
                 <label class="text-[9px] font-black text-slate-400 uppercase tracking-tighter">Format</label>
                 <div id="field-format" class="bg-slate-50 rounded-lg p-2 text-xs font-black text-slate-700"></div>
               </div>`;
        const standDescriptionControl = HAS_STAND_DESCRIPTIONS && !HAS_PRESENTATION_MAP
            ? `<div class="bg-slate-800 px-3 py-2 border-t border-slate-700 no-print">
                    <div id="clay-meta-controls" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5"></div>
                </div>`
            : '';

        document.getElementById('app-root').innerHTML = `
        <header class="bg-slate-900 text-white sticky top-0 z-50 shadow-md no-print w-full relative">
            <div class="max-w-5xl mx-auto p-3 flex justify-between items-center gap-2 relative">
                <div class="flex items-center gap-2 min-w-0">
                    <a href="index.html" aria-label="Home" class="w-8 h-8 flex items-center justify-center bg-orange-500 rounded-lg shadow-sm">
                        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6">
                            <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>
                        </svg>
                    </a>
                    <div class="min-w-0">
                        <div class="text-[8px] text-orange-400 font-black uppercase tracking-widest leading-none">${D.code}</div>
                        <h1 class="text-base font-bold tracking-tight uppercase italic leading-none mt-0.5 truncate max-w-[82px] sm:max-w-none">${D.name}</h1>
                    </div>
                </div>
                <span id="offline-status" class="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-green-400/80 inline-flex items-center justify-center cursor-default pointer-events-none" title="Offline Ready" aria-label="Offline Ready">
                    <i data-lucide="wifi-off" class="w-3 h-3"></i>
                </span>
                <div class="flex items-center gap-1 flex-shrink-0">
                    <button id="history-menu-btn" onclick="toggleHeaderMenu('history')" class="bg-slate-800 px-1.5 sm:px-2 py-1.5 rounded-lg border border-slate-700 inline-flex items-center gap-1" aria-expanded="false" aria-controls="history-dropdown" title="History">
                        <i data-lucide="archive" class="w-4 h-4 text-slate-300"></i>
                        <span id="history-count-badge" class="min-w-5 h-5 px-1 rounded bg-orange-500 text-white text-[10px] font-black leading-5 text-center">0</span>
                    </button>
                    <button id="cloud-menu-btn" onclick="toggleHeaderMenu('cloud')" class="bg-slate-800 px-1.5 sm:px-2 py-1.5 rounded-lg border border-slate-700 inline-flex items-center gap-1" aria-expanded="false" aria-controls="cloud-dropdown">
                        <i data-lucide="cloud" class="w-4 h-4 text-slate-300"></i>
                        <span id="cloud-status-badge" class="h-5 px-1.5 rounded bg-slate-700 text-slate-300 text-[9px] font-black leading-5 text-center uppercase">Off</span>
                    </button>
                    <button id="export-menu-btn" onclick="toggleHeaderMenu('export')" class="bg-orange-500 p-2 rounded-lg border border-orange-400 inline-flex items-center justify-center" aria-expanded="false" aria-controls="export-dropdown" title="Export">
                        <i data-lucide="download" class="w-4 h-4 text-white"></i>
                    </button>
                    <button id="lock-btn" onclick="toggleLock()" class="bg-slate-800 p-2 rounded-lg border border-slate-700">
                        <i data-lucide="unlock" id="lock-icon" class="w-4 h-4 text-slate-400"></i>
                    </button>
                </div>
            </div>
            <div class="w-full bg-slate-800 h-1"><div id="progress-bar" class="bg-orange-500 h-full transition-all duration-500 w-0"></div></div>
            <div id="header-dropdown-layer" class="absolute left-0 right-0 top-full pointer-events-none">
                <div class="max-w-5xl mx-auto relative">
                    <div id="history-dropdown" class="hidden pointer-events-auto absolute right-2 top-2 w-[calc(100vw-1rem)] max-w-md">
                        <section id="history-section" class="bg-white text-slate-900 rounded-xl shadow-xl border border-slate-200 overflow-hidden"></section>
                    </div>
                    <div id="cloud-dropdown" class="hidden pointer-events-auto absolute right-2 top-2 w-[calc(100vw-1rem)] max-w-md">
                        <div id="cloud-sync-panel"></div>
                    </div>
                    <div id="export-dropdown" class="hidden pointer-events-auto absolute right-2 top-2 w-48">
                        <div class="bg-white text-slate-900 rounded-xl shadow-xl border border-slate-200 overflow-hidden p-2">
                            <button onclick="closeHeaderMenus(); exportToPDF();" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[10px] font-black uppercase text-slate-700 hover:bg-slate-100">
                                <i data-lucide="file-text" class="w-4 h-4 text-slate-500"></i>
                                Export PDF
                            </button>
                            <button onclick="closeHeaderMenus(); downloadCSV();" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[10px] font-black uppercase text-slate-700 hover:bg-slate-100">
                                <i data-lucide="file-spreadsheet" class="w-4 h-4 text-slate-500"></i>
                                Export CSV
                            </button>
                            <button onclick="closeHeaderMenus(); shareAsImage();" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-[10px] font-black uppercase text-slate-700 hover:bg-slate-100">
                                <i data-lucide="image" class="w-4 h-4 text-slate-500"></i>
                                Export Image
                            </button>
                        </div>
                    </div>
                </div>
            </div>
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

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 p-3 no-print">
                <div class="flex justify-between items-center mb-2">
                    <h3 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Squad Members</h3>
                    <button onclick="addShooter()" class="text-[9px] bg-slate-900 text-white px-3 py-1 rounded-lg font-black uppercase">Add Shooter</button>
                </div>
                <div id="squad-list" class="space-y-2"></div>
            </section>

            <div id="stand-nav" class="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-hide no-scrollbar px-1 no-print"></div>
            ${OPTION ? `
            <section id="option-status" class="bg-white rounded-xl shadow-sm border border-slate-200 p-2 no-print"></section>
            ` : ''}

            <section class="bg-white rounded-xl shadow-lg border border-slate-200 overflow-visible no-print">
                <div class="bg-slate-900 px-3 py-2.5 text-white flex justify-between items-center">
                    <div class="flex items-baseline gap-2">
                        <h2 id="active-stand-title" class="text-lg font-black italic uppercase">${ROUND_LABEL} 1</h2>
                        <span id="active-stand-targets" class="text-[9px] text-orange-400 font-bold uppercase"></span>
                    </div>
                    <button id="undo-btn" onclick="undo()" class="hidden text-[9px] font-black text-white uppercase flex items-center gap-1 bg-slate-800 px-2 py-1 rounded-lg border border-slate-700">
                        <i data-lucide="rotate-ccw" size="10"></i> Undo
                    </button>
                </div>

                ${standDescriptionControl}

                <div id="scoring-controls"></div>
                <div id="scoring-area" class="divide-y divide-slate-100"></div>

                <div class="bg-slate-50 p-3 flex gap-3 no-print border-t border-slate-200">
                    <button onclick="nav(-1)" id="nav-prev" class="flex-1 bg-white border border-slate-300 py-3 rounded-xl text-xs font-black disabled:opacity-30 tracking-widest uppercase">Prev</button>
                    <button onclick="nav(1)" id="nav-next" class="flex-1 bg-slate-900 text-white py-3 rounded-xl text-xs font-black disabled:opacity-30 tracking-widest uppercase">Next ${ROUND_LABEL}</button>
                </div>
            </section>

            ${HAS_PRESENTATION_MAP ? `
            <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-visible no-print">
                <details class="group" open>
                    <summary class="list-none cursor-pointer p-2 bg-slate-100 border-b border-slate-200 flex items-center justify-between gap-2 text-[9px] font-black uppercase text-slate-500">
                        <span class="flex items-center gap-1"><i data-lucide="chevron-right" class="w-3 h-3 transition-transform group-open:rotate-90"></i> Presentation Options</span>
                        ${D.id === 'compak' ? '<button onclick="event.preventDefault(); addPresentationOption()" class="bg-slate-900 text-white px-2 py-1 rounded-md">+ Presentation</button>' : ''}
                    </summary>
                    <div id="fixed-presentation-controls" class="p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5"></div>
                </details>
                <details class="group border-t border-slate-200">
                    <summary class="list-none cursor-pointer p-2 bg-slate-100 flex items-center gap-1 text-[9px] font-black uppercase text-slate-500">
                        <i data-lucide="chevron-right" class="w-3 h-3 transition-transform group-open:rotate-90"></i> Stand Setup
                    </summary>
                    <div id="stand-shot-controls"></div>
                </details>
            </section>
            ` : ''}

            <section class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden no-print">
                <div class="p-2 bg-slate-100 border-b border-slate-200 flex justify-between items-center text-[9px] font-black uppercase text-slate-500">
                    <span>Leaderboard Summary</span>
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
                <div style="border-bottom: 2pt solid black; padding: 10px 0; display: flex; justify-content: space-between; font-size: 14pt;">
                    <div><strong>GROUND:</strong> <span id="cap-ground"></span></div>
                    <div style="text-align:center; text-transform: uppercase;"><strong><span id="cap-discipline"></span> Leaderboard</strong></div>
                    <div><strong>DATE:</strong> <span id="cap-date"></span></div>
                </div>
                <div id="cap-event-row" style="display:none; text-align:center; font-size: 12pt; font-weight: bold; font-style: italic; padding: 6px 0 10px; margin-bottom: 10px; border-bottom: 1pt solid #ccc;"><strong>EVENT:</strong> <span id="cap-event"></span></div>
                <div style="height: 10px;"></div>
                <table id="cap-grid"></table>
                <div style="margin-top: 30px; display: flex; justify-content: space-between; align-items: center; font-size: 11pt; font-weight: bold;">
                    <span>Generated by QuaCKeReD</span>
                    <div style="border-top: 1.5pt solid black; width: 300px; text-align: center; padding-top: 8px;">SCORER / SHOOTER SIGNATURE</div>
                </div>
            </div>

            <div class="hidden print-only" id="print-view">
                <div class="print-header">
                    <div><strong>GROUND:</strong> <span id="p-ground"></span></div>
                    <div style="text-align:center; text-transform: uppercase;"><strong><span id="p-discipline"></span> Scorecard</strong></div>
                    <div style="text-align:right"><strong>DATE:</strong> <span id="p-date"></span></div>
                </div>
                <div id="p-event-row" class="print-event" style="display:none;"><strong>EVENT:</strong> <span id="p-event"></span></div>
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
        const badge = document.getElementById('history-count-badge');
        if (badge) badge.textContent = entries.length > 99 ? '99+' : String(entries.length);

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
                const opt = (r.optionHits || {})[sh.id];
                if (opt && opt.hit !== null && opt.hit !== undefined) {
                    totalShot++;
                    if (opt.hit === true) totalHits++;
                }
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

        const emptyHint = entries.length ? '' : '<p class="text-[10px] text-slate-400 mt-0.5 font-medium normal-case tracking-normal">Rounds are saved automatically once you enter a Ground or Event.</p>';
        el.innerHTML = `
            <div class="p-3 border-b border-slate-100">
                <div class="min-w-0 mb-2">
                    <h3 class="text-[10px] font-black uppercase tracking-widest text-slate-400">Round History</h3>
                    ${emptyHint}
                </div>
                <div class="flex flex-wrap justify-between gap-4 items-center">
                    <button onclick="deleteHistory()" class="text-[9px] bg-red-50 text-red-600 px-3 py-1.5 rounded-lg font-black uppercase border border-red-100">Delete History</button>
                    <div class="ml-auto flex flex-wrap justify-end gap-1.5">
                        <label class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200 cursor-pointer inline-flex items-center">
                            Import CSV
                            <input type="file" accept=".csv,text/csv" onchange="handleImportChange(this)" style="display:none">
                        </label>
                        <button onclick="newRound()" class="text-[9px] bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-black uppercase border border-slate-200">+ New Round</button>
                    </div>
                </div>
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

    function renderStandFormatControls() {
        const el = document.getElementById('stand-shot-controls');
        if (!el) return;
        if (!HAS_PRESENTATION_MAP) { el.innerHTML = ''; return; }
        const standRows = state.stands.map(stand => {
            const total = standTargets(stand);
            const formats = getStandFormatMap(stand);
            const presentations = getStandPresentationMap(stand);
            let clayHtml = '';
            for (let p = 0; p < total;) {
                const value = formats[p] || 'single';
                const groupSize = value !== 'single' && (p + 1) < total ? 2 : 1;
                const label = groupSize === 2 ? `${p + 1}-${p + 2}` : `${p + 1}`;
                const shotIdxs = Array.from({ length: groupSize }, (_, offset) => p + offset);
                const presentationSelects = shotIdxs.map(idx => {
                    const selected = presentations[idx] || '';
                    return `<select onchange="updateStandShotPresentation(${stand.id},${idx},this.value)" ${state.isLocked ? 'disabled' : ''} class="w-full h-7 bg-slate-50 border border-slate-200 rounded-md px-1 text-[8px] font-black text-slate-700 disabled:opacity-60">
                        <option value="">Presentation</option>
                        ${Array.from({ length: presentationCountForStand(stand) }, (_, optIdx) => optIdx + 1).map(opt => `<option value="${opt}" ${selected === opt ? 'selected' : ''}>${presentationLabel(opt - 1)}</option>`).join('')}
                    </select>`;
                }).join('');
                clayHtml += `<div class="pair-stack" style="flex:${groupSize} 1 0;">
                    <label class="block text-[7px] font-black uppercase tracking-widest text-slate-400 mb-1">Clay ${label}</label>
                    <select onchange="updateStandShotFormat(${stand.id},${p},this.value)" ${state.isLocked ? 'disabled' : ''} class="w-full h-7 bg-slate-900 text-white border border-slate-700 rounded-md px-1 text-[8px] font-black uppercase disabled:opacity-60">
                        <option value="single" ${value === 'single' ? 'selected' : ''}>Single</option>
                        <option value="report" ${value === 'report' ? 'selected' : ''}>On Report</option>
                        <option value="sim" ${value === 'sim' ? 'selected' : ''}>Sim Pair</option>
                    </select>
                    <div class="mt-1 flex gap-1">${presentationSelects}</div>
                </div>`;
                p += groupSize;
            }
            return `<div class="py-2 border-t border-slate-700 first:border-t-0">
                <div class="text-[9px] font-black uppercase tracking-widest text-orange-400 mb-1.5">${PHYSICAL_STAND_LABEL} ${stand.id}</div>
                <div class="flex gap-1 w-full overflow-x-hidden">${clayHtml}</div>
            </div>`;
        }).join('');
        el.innerHTML = `<div class="bg-slate-800 px-2 py-2 no-print">
            ${standRows}
        </div>`;
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
        if (OPTION) {
            sTotalPossible += state.shooters.length;
            state.shooters.forEach(sh => {
                const opt = state.optionHits?.[sh.id];
                if (opt && opt.hit !== null && opt.hit !== undefined) sTotalShot++;
            });
        }
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
            document.getElementById('field-format').innerText = `${state.stands.length} ${ROUND_LABEL}s / ${totalTargets + (OPTION ? 1 : 0)} Targets`;
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
            btn.innerText = HAS_PRESENTATION_MAP ? `R${s.id}` : s.id;
            btn.onclick = () => { if (!state.isLocked) { state.activeIdx = i; render(); save(); } };
            navDiv.appendChild(btn);
        });
        const optionStatus = document.getElementById('option-status');
        if (optionStatus) {
            const optLabel = OPTION.label || 'OPT';
            const chips = state.shooters.map(sh => {
                const opt = state.optionHits?.[sh.id];
                const optStandId = getOptionStandId(sh.id);
                const used = opt && opt.hit !== null && opt.hit !== undefined;
                const available = !used && optStandId !== null;
                const text = used
                    ? `Used ${ROUND_LABEL.slice(0, 2).toUpperCase()} ${opt.standId}`
                    : (available ? `Available ${ROUND_LABEL.slice(0, 2).toUpperCase()} ${optStandId}` : 'Not used');
                const cls = used
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : (available ? 'bg-orange-50 border-orange-300 text-orange-800' : 'bg-slate-50 border-slate-200 text-slate-500');
                const dot = used ? 'bg-emerald-500' : (available ? 'bg-orange-500' : 'bg-slate-300');
                return `<div class="min-w-0 flex items-center gap-1.5 rounded-lg border px-2 py-1 ${cls}">
                    <span class="w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}"></span>
                    <span class="truncate font-black">${escapeHtml(sh.name)}</span>
                    <span class="flex-shrink-0 font-bold opacity-80">${text}</span>
                </div>`;
            }).join('');
            optionStatus.innerHTML = `<div class="flex items-center gap-2">
                <div class="flex-shrink-0 text-[9px] font-black uppercase tracking-widest text-slate-400">${escapeHtml(optLabel)}</div>
                <div class="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 text-[9px] uppercase">${chips}</div>
            </div>`;
        }

        // Active header
        document.getElementById('active-stand-title').innerText = `${ROUND_LABEL} ${st.id}`;
        const total = standTargets(st);
        const optionAvailableHere = OPTION && state.shooters.some(sh => getOptionStandId(sh.id) === st.id);
        document.getElementById('active-stand-targets').innerText = `${total} Target${total !== 1 ? 's' : ''}${st.extraClay ? ' (+1)' : ''}${optionAvailableHere ? ` + ${OPTION.label || 'OPT'}` : ''}`;
        const clayMetaEl = document.getElementById('clay-meta-controls');
        if (clayMetaEl) clayMetaEl.innerHTML = renderClayMetaControls(st);
        const fixedPresentationEl = document.getElementById('fixed-presentation-controls');
        if (fixedPresentationEl) fixedPresentationEl.innerHTML = renderClayMetaControls(st);
        renderScoringControls();
        renderStandFormatControls();

        // Scoring rows. Sporting rotates first-up; Compak/Sportrap keep shooter order fixed.
        const n = state.shooters.length;
        const leadIdx = ROTATE ? (state.activeIdx % n) : 0;
        const sArea = document.getElementById('scoring-area'); sArea.innerHTML = '';
        const visibleShooters = Array.from({ length: n }, (_, i) => state.shooters[(i + leadIdx) % n]);
        const activeShooterId = visibleShooters.find(sh => !shooterStandStats(sh.id, st).completed)?.id || visibleShooters[visibleShooters.length - 1]?.id;

        for (let i = 0; i < n; i++) {
            const s = visibleShooters[i];
            const hits = state.hits[s.id]?.[st.id] || Array(total).fill(null);
            const optionStandId = getOptionStandId(s.id);
            const optionOnThisStand = OPTION && optionStandId === st.id;
            const optionHit = optionOnThisStand ? getOptionHit(s.id) : null;
            const count = hits.filter(h => h === true).length + (optionHit === true ? 1 : 0);
            const possible = total + (optionOnThisStand ? 1 : 0);
            const row = document.createElement('div');
            row.className = `p-2.5 space-y-1.5 ${s.id === activeShooterId ? 'bg-orange-50/40 first-up-highlight' : ''} ${state.isLocked ? 'pointer-events-none' : ''}`;

            let gridHtml = '';
            const selectedStandId = HAS_PRESENTATION_MAP ? getShooterRoundStand(s.id, st.id) : st.id;
            const setupStand = HAS_PRESENTATION_MAP ? (state.stands.find(stand => stand.id === selectedStandId) || st) : st;
            const standFormatMap = HAS_PRESENTATION_MAP ? getStandFormatMap(setupStand) : [];
            const standPresentationMap = HAS_PRESENTATION_MAP ? getStandPresentationMap(setupStand) : [];
            const shooterStandSelect = HAS_PRESENTATION_MAP
                ? `<select onchange="updateShooterRoundStand(${s.id},${st.id},this.value)" class="h-6 bg-slate-50 border border-slate-200 rounded-md px-1 text-[8px] font-black uppercase text-slate-700">
                    ${state.stands.map(setup => `<option value="${setup.id}" ${selectedStandId === setup.id ? 'selected' : ''}>${PHYSICAL_STAND_LABEL} ${setup.id}</option>`).join('')}
                </select>`
                : '';
            const presentationBadge = (shotIdx) => {
                if (!HAS_PRESENTATION_MAP) return '';
                const value = standPresentationMap[shotIdx];
                return `<div class="flex-1 min-w-0 h-5 rounded-md bg-slate-100 border border-slate-200 px-1 text-[8px] font-black text-slate-600 flex items-center justify-center">${value ? presentationLabel(value - 1) : '-'}</div>`;
            };
            for (let p = 0; p < total;) {
                const format = standFormatMap[p] || 'single';
                const groupSize = HAS_PRESENTATION_MAP && format !== 'single' && (p + 1) < total ? 2 : 1;
                const shotIdxs = Array.from({ length: groupSize }, (_, offset) => p + offset);
                const pairClass = shotIdxs.some(idx => st.extraClay && idx === total - 1) ? 'pair-stack pair-extra' : 'pair-stack';
                const hitRow = shotIdxs.map(idx => {
                    const hit = hits[idx];
                    return `<button onclick="toggleHit(${s.id},${st.id},${idx},true)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${hit === true ? 'hit-bg' : 'bg-white border-slate-300 text-slate-400'}">H</button>`;
                }).join('');
                const missRow = shotIdxs.map(idx => {
                    const hit = hits[idx];
                    return `<button onclick="toggleHit(${s.id},${st.id},${idx},false)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${hit === false ? 'miss-bg' : 'bg-white border-slate-300 text-slate-400'}">M</button>`;
                }).join('');
                const presentationLabels = shotIdxs.map(idx => presentationBadge(idx)).join('');
                const labels = shotIdxs.map(idx => {
                    const isExtra = st.extraClay && idx === total - 1;
                    return `<div class="flex-1">${st.labels?.[idx] ?? (isExtra ? '+1' : '')}</div>`;
                }).join('');
                gridHtml += `<div class="${pairClass}" style="flex:${groupSize} 1 0;">
                    <div class="flex gap-1">
                        ${hitRow}
                    </div>
                    <div class="flex gap-1">
                        ${missRow}
                    </div>
                    ${HAS_PRESENTATION_MAP ? `<div class="flex gap-1">${presentationLabels}</div>` : ''}
                    ${labels.replace(/<div class="flex-1"><\/div>/g, '').trim() ? `<div class="flex gap-1 text-[7px] font-black text-slate-500 text-center uppercase pt-0.5">${labels}</div>` : ''}
                </div>`;
                p += groupSize;
            }
            if (optionOnThisStand) {
                const optLabel = OPTION.label || 'OPT';
                gridHtml += `<div class="pair-stack pair-extra">
                    <div class="flex gap-1">
                        <button onclick="toggleOptionHit(${s.id},${st.id},true)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${optionHit === true ? 'hit-bg' : 'bg-white border-slate-300 text-slate-400'}">H</button>
                    </div>
                    <div class="flex gap-1">
                        <button onclick="toggleOptionHit(${s.id},${st.id},false)" class="flex-1 h-9 rounded-md font-black text-[10px] border shadow-sm ${optionHit === false ? 'miss-bg' : 'bg-white border-slate-300 text-slate-400'}">M</button>
                    </div>
                    <div class="flex gap-1 text-[7px] font-black text-slate-500 text-center uppercase pt-0.5">
                        <div class="flex-1">${escapeHtml(optLabel)}</div>
                    </div>
                </div>`;
            }

            row.innerHTML = `<div class="flex justify-between items-center px-1">
                <div class="flex items-center gap-1.5">
                    <span class="text-[11px] font-black uppercase truncate max-w-[140px] tracking-tight">${s.name}</span>
                    ${i === 0 && ROTATE ? '<span class="bg-orange-500 text-white text-[6px] px-1 rounded-full font-black uppercase">First Up</span>' : ''}
                    ${shooterStandSelect}
                </div>
                <div class="text-base font-black italic text-slate-900">${count}<span class="text-slate-300 text-[8px] not-italic ml-0.5">/${possible}</span></div>
            </div>
            <div class="flex gap-1 w-full overflow-x-hidden">${gridHtml}</div>`;
            sArea.appendChild(row);
        }

        // Leaderboard
        const lbHeader = document.getElementById('lb-header');
        lbHeader.innerHTML = `<th class="p-2 border-b text-left w-12 tracking-tighter">${ROUND_LABEL.slice(0, 3).toUpperCase()}</th>`;
        const perf = state.shooters.map(sh => {
            let totalH = 0, totalAtt = 0;
            state.stands.forEach(stnd => {
                if (state.hits[sh.id]?.[stnd.id]) {
                    totalH += state.hits[sh.id][stnd.id].filter(h => h === true).length;
                    totalAtt += state.hits[sh.id][stnd.id].filter(h => h !== null).length;
                }
            });
            const opt = state.optionHits?.[sh.id];
            if (opt && opt.hit !== null && opt.hit !== undefined) {
                if (opt.hit === true) totalH++;
                totalAtt++;
            }
            const pct = totalAtt > 0 ? Math.round((totalH / totalAtt) * 100) : null;
            return { ...sh, t: totalH, att: totalAtt, pct, isStraight: totalH === totalAtt && totalH > 0 };
        }).sort((a, b) => b.t - a.t);
        perf.forEach(sh => {
            lbHeader.innerHTML += `<th class="p-1 border-b border-l border-slate-200 text-center align-bottom"><div class="break-words leading-tight min-w-[50px]">${sh.isStraight ? '&#128293;<br>' : ''}${sh.name}</div></th>`;
        });

        const lbBody = document.getElementById('lb-body'); lbBody.innerHTML = '';
        const completedDifficulties = state.stands.map(completedStandDifficulty).filter(Boolean);
        const hardId = completedDifficulties.slice().sort((a, b) => a.avg - b.avg)[0]?.id;

        state.stands.forEach((stand, idx) => {
            let row = `<td class="p-2 font-bold border-b text-slate-400 text-[8px]">${ROUND_LABEL.slice(0, 2).toUpperCase()} ${stand.id}${stand.extraClay ? '+1' : ''} ${stand.id === hardId ? '&#10071;' : ''}</td>`;
            perf.forEach(sh => {
                const base = state.hits[sh.id]?.[stand.id]?.filter(h => h === true).length || 0;
                const opt = getOptionHitForStand(sh.id, stand.id) === true ? 1 : 0;
                row += `<td class="p-2 text-center border-b border-l border-slate-100 font-black">${base + opt}</td>`;
            });
            const tr = document.createElement('tr');
            tr.className = state.activeIdx === idx ? 'bg-orange-50' : '';
            tr.innerHTML = row;
            lbBody.appendChild(tr);
        });

        const f = document.getElementById('lb-footer');
        const scheduledClays = scheduledRoundTargets() + (OPTION ? 1 : 0);
        let fRow = `<tr class="bg-slate-900 text-white font-black"><td class="p-2 uppercase text-[7px]">Total<br><span class="text-[8px] text-slate-400 normal-case">${scheduledClays} clays</span></td>`;
        perf.forEach(sh => {
            const pctHtml = sh.pct === null ? '' : `<div class="text-sm text-slate-400 leading-none mt-0.5">${sh.pct}%</div>`;
            fRow += `<td class="p-2 text-center text-sm border-l border-slate-700">${sh.t}${pctHtml}</td>`;
        });
        f.innerHTML = fRow + '</tr>';

        document.getElementById('nav-prev').disabled = state.activeIdx === 0;
        document.getElementById('nav-next').disabled = state.activeIdx === state.stands.length - 1;

        if (window.lucide) lucide.createIcons();
    }

    // Service workers are only allowed on http(s) origins. Under `file://` the origin is
    // "null" and the browser rejects registration outright — skip it entirely so we don't
    // spam the console when the file is opened directly (double-click / preview).
    if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service_worker.js').catch(err => console.warn('SW registration failed', err));
        });
    }

    window.ClayScorerCloud = {
        getDiscipline: () => ({
            id: D.id,
            name: D.name,
            code: D.code,
            storageKey: D.storageKey
        }),
        getCurrentState: () => cloneData(state),
        getHistory: () => cloneData(readHistory()),
        saveCurrent: () => save(),
        replaceHistory,
        loadRound: (key) => window.loadRound(key),
        refreshCurrentRoundFromHistory
    };

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
        document.addEventListener('click', (e) => {
            if (e.target.closest('#history-dropdown, #cloud-dropdown, #export-dropdown, #history-menu-btn, #cloud-menu-btn, #export-menu-btn')) return;
            window.closeHeaderMenus();
        });
        document.addEventListener('click', (e) => {
            if (e.target.closest('[data-clay-meta-control]')) return;
            closeClayMetaControls();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                window.closeHeaderMenus();
                closeClayMetaControls();
            }
        });
        load();
        // Make sure a loaded named round is present in the history dict — otherwise a
        // previous session's typing (which no longer writes history on every keystroke)
        // could leave state named but history empty until the user next mutates something.
        if (isNamedRound(state)) save();
        render();
    });
})();
