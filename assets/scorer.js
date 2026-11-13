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
 *     scrollScoreRows: false,                     // optional, defaults to true: on phones the H/M
 *                                                 // stacks scroll sideways, ~3 pairs in view
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
    const SCORER_BUILD = 'scorer 2026-11-13 (scrolling score rows)';
    console.info('%c[ClayScorer] %s', 'color:#f97316;font-weight:bold', SCORER_BUILD);

    const D = window.DISCIPLINE;
    if (!D) { console.error('DISCIPLINE config missing'); return; }

    const KEY = D.storageKey;
    const MAX_SHOOTERS = D.maxShooters || 6;
    const CLASSES = ['AAA', 'AA', 'A', 'B', 'C', 'U'];
    const HAS_STAND_DESCRIPTIONS = D.enableStandDescriptions !== false;
    const SCROLL_SCORE_ROWS = D.scrollScoreRows !== false;
    const HAS_PRESENTATION_MAP = D.id === 'compak' || D.id === 'sportrap';
    const ROTATE = !HAS_PRESENTATION_MAP && D.showFirstUpRotation !== false;
    const ROUND_LABEL = HAS_PRESENTATION_MAP ? 'Round' : D.standLabel;
    const PHYSICAL_STAND_LABEL = 'Stand';
    const STAND_ROTATION_DEFAULT_VERSION = 1;
    const SPORTRAP_STAND_FORMAT_DEFAULT_VERSION = 1;
    const CLAY_META_OPTIONS = {
        presentation: ['Crosser', 'Teal', 'Crow', 'Driven', 'Looper', 'Battue', 'Rabbit', 'Rabbue', 'Quartering'],
        direction: ['LR', 'RL', 'Away', 'Towards'],
        starting: ['Low', 'Mid', 'High'],
        travelling: ['Up', 'Level', 'Down'],
        claySize: ['Std110', 'Midi90', 'Mini70'],
        clayFace: ['Edge', 'Belly', 'Top'],
        clayVisibility: ['Full', 'Part'],
        colour: ['Orange', 'Black', 'Pink', 'Green']
    };
    // Presentation choices are laid out over two rows in the clay dialog.
    const CLAY_PRESENTATION_ROWS = [
        ['Crosser', 'Teal', 'Crow', 'Driven', 'Looper'],
        ['Battue', 'Rabbit', 'Rabbue', 'Quartering']
    ];
    // Pre-selected in the dialog for a clay nobody has described yet, and stored on its first edit.
    const CLAY_META_DEFAULTS = {
        starting: 'Low',
        travelling: 'Level',
        claySize: 'Std110',
        clayVisibility: 'Full',
        colour: 'Orange'
    };
    const CLAY_META_FIELDS = [
        { key: 'presentation', label: 'Presentation', rows: CLAY_PRESENTATION_ROWS },
        { key: 'direction', label: 'Direction', multi: true },
        { key: 'starting', label: 'Starting' },
        { key: 'travelling', label: 'Travelling' },
        { key: 'claySize', label: 'Clay size' },
        { key: 'clayFace', label: 'Clay face' },
        { key: 'clayVisibility', label: 'Clay face amount' },
        { key: 'colour', label: 'Colour' }
    ];
    // Older rounds stored the misspelt 'Batue'.
    const LEGACY_PRESENTATION = { Batue: 'Battue' };

    // Shared class strings so sizing/contrast for field use (sunlight, gloves) is tuned in one place.
    const LABEL = 'block text-xs font-semibold text-slate-800';
    const FIELD = 'block w-full min-w-0 h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold text-slate-900';
    const CARD = 'bg-white rounded-xl shadow border border-slate-300';
    const SECTION_HEAD = 'text-xs font-bold uppercase tracking-wider text-slate-700';
    const BTN_SCORE = 'flex-1 h-12 rounded-md font-black text-sm border-2 shadow-sm';
    const BTN_SMALL = 'text-xs font-bold px-3 py-1.5 rounded-lg border';
    const MENU_ITEM = 'w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left text-sm font-semibold text-slate-700 hover:bg-slate-100';
    const scoreBtnClass = (selected, isHit) => `${BTN_SCORE} ${selected
        ? (isHit ? 'hit-bg' : 'miss-bg')
        : (isHit ? 'score-btn-hit' : 'score-btn-miss')}`;

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
    // Every history write is announced so the server sync (assets/server-sync.js) can push
    // changes, renames and deletes; it diffs against what it last synced.
    const writeHistory = (h) => {
        try { localStorage.setItem(KEY_HISTORY, JSON.stringify(h)); } catch (e) {}
        document.dispatchEvent(new CustomEvent('clayscorer:history-written'));
    };
    // Deletes reach the server too when signed in; the sync module sets this flag.
    const syncNote = () => (window.ClayScorerCloud?.isSignedIn?.() ? ' (and from the server)' : '');

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
                presentation: LEGACY_PRESENTATION[item.presentation] || item.presentation || '',
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

    const CLAY_DIRECTION_TEXT = { LR: 'left to right', RL: 'right to left', Away: 'away', Towards: 'towards you' };
    const CLAY_TRAVEL_TEXT = { Up: 'rising', Level: 'staying level', Down: 'dropping' };
    const CLAY_SIZE_TEXT = { Std110: 'standard', Midi90: 'midi', Mini70: 'mini' };
    const joinOr = (list) => list.join(' or ');

    const isClayMetaEmpty = (meta) => !meta || CLAY_META_FIELDS.every(f => f.multi
        ? !(meta[f.key] || []).length
        : !meta[f.key]);
    // What the dialog shows as selected: an untouched clay shows the defaults.
    const effectiveClayMeta = (meta) => (isClayMetaEmpty(meta) ? { ...meta, ...CLAY_META_DEFAULTS } : meta);

    // Natural-language description of one clay, e.g.
    // "Crosser going left to right and away, starting low and rising. Orange standard clay showing its full belly."
    function clayMetaDescription(meta) {
        if (isClayMetaEmpty(meta)) return '';
        const dirs = meta.direction || [];
        const lateral = dirs.filter(d => d === 'LR' || d === 'RL').map(d => CLAY_DIRECTION_TEXT[d]);
        const depth = dirs.filter(d => d === 'Away' || d === 'Towards').map(d => CLAY_DIRECTION_TEXT[d]);
        const dirGroups = [lateral, depth].filter(g => g.length).map(joinOr);
        let dirText = '';
        if (dirGroups.length) {
            const comingTowards = !lateral.length && depth.length === 1 && dirs.includes('Towards');
            dirText = `${comingTowards ? 'coming' : 'going'} ${dirGroups.join(' and ')}`;
        }

        const moveParts = [];
        if (meta.starting) moveParts.push(`starting ${meta.starting.toLowerCase()}`);
        if (meta.travelling) moveParts.push(CLAY_TRAVEL_TEXT[meta.travelling] || meta.travelling.toLowerCase());
        const moveText = moveParts.join(' and ');

        let flight = [meta.presentation, dirText].filter(Boolean).join(' ');
        flight = [flight, moveText].filter(Boolean).join(', ');

        const face = (meta.clayFace || '').toLowerCase();
        const part = meta.clayVisibility === 'Part';
        let faceText = '';
        if (face === 'edge') faceText = part ? 'partly edge-on' : 'edge-on';
        else if (face) faceText = part ? `showing part of its ${face}` : `showing its full ${face}`;
        else if (meta.clayVisibility) faceText = part ? ', partly visible' : ', fully visible';
        const clayWords = [(meta.colour || '').toLowerCase(), CLAY_SIZE_TEXT[meta.claySize] || ''].filter(Boolean);
        const clayText = (clayWords.length || faceText)
            ? `${clayWords.join(' ')} clay${faceText.startsWith(',') ? faceText : (faceText ? ` ${faceText}` : '')}`.trim()
            : '';

        const sentence = (t) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : '');
        return [sentence(flight), sentence(clayText)].filter(Boolean).join(' ');
    }

    function clayMetaLabel(stand, idx) {
        const total = presentationCountForStand(stand);
        return (!D.fixedStands && stand.extraClay && idx === total - 1) ? 'Extra' : presentationLabel(idx);
    }

    // One description line per described clay, prefixed with its label ("Clay 1: …", "A: …").
    function standPresentationLines(stand) {
        return (stand.clayMeta || [])
            .map((meta, idx) => {
                const text = clayMetaDescription(meta);
                return text ? `${clayMetaLabel(stand, idx)}: ${text}` : '';
            })
            .filter(Boolean);
    }

    const CLAY_CHIP = 'flex-1 min-w-[4.25rem] h-9 px-2 rounded-lg border text-xs font-semibold';
    const clayChipClass = (on) => `${CLAY_CHIP} ${on
        ? 'bg-orange-500 border-orange-500 text-white'
        : 'bg-white border-slate-300 text-slate-800 hover:bg-slate-100'}`;
    const clayOptionText = (key, opt) => (key === 'direction'
        ? { LR: 'Left → right', RL: 'Right → left', Away: 'Away', Towards: 'Towards' }[opt] || opt
        : opt);
    const clayOptionOn = (meta, field, opt) => (field.multi
        ? (meta[field.key] || []).includes(opt)
        : meta[field.key] === opt);

    function clayMetaPanelHtml(targetIdx, meta) {
        const shown = effectiveClayMeta(meta);
        return CLAY_META_FIELDS.map(field => {
            const rows = field.rows || [CLAY_META_OPTIONS[field.key]];
            return `<div class="space-y-1" role="group" aria-label="${field.label}">
                <div class="${LABEL}">${field.label}${field.multi ? ' <span class="font-normal text-slate-500">(choose any)</span>' : ''}</div>
                ${rows.map(row => `<div class="flex gap-1">
                    ${row.map(opt => {
                        const on = clayOptionOn(shown, field, opt);
                        return `<button type="button" data-meta-key="${field.key}" data-meta-value="${escapeHtml(opt)}" aria-pressed="${on}"
                            onclick="toggleClayMeta(${targetIdx}, '${field.key}', '${escapeHtml(opt)}')" class="${clayChipClass(on)}">${escapeHtml(clayOptionText(field.key, opt))}</button>`;
                    }).join('')}
                </div>`).join('')}
            </div>`;
        }).join('');
    }

    function renderClayMetaControls(stand) {
        if (!HAS_STAND_DESCRIPTIONS) return '';
        const total = presentationCountForStand(stand);
        stand.clayMeta = normalizeClayMeta(stand.clayMeta, total);
        return stand.clayMeta.map((meta, idx) => {
            const label = clayMetaLabel(stand, idx);
            const text = clayMetaDescription(meta);
            return `<details data-clay-meta-control data-clay-idx="${idx}" class="relative">
                <summary class="list-none cursor-pointer rounded-lg border border-slate-500 bg-slate-700 px-2 py-2 text-xs font-bold text-white truncate" title="${escapeHtml(text)}">
                    <span class="text-orange-400">${label}</span>
                    <span data-clay-meta-summary="${idx}" class="font-semibold ml-1 ${text ? 'text-slate-100' : 'text-slate-300 italic'}">${escapeHtml(text || 'Tap to describe')}</span>
                </summary>
                <div class="absolute right-0 z-30 mt-1 w-[min(34rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-xl border border-slate-300 bg-white shadow-xl">
                    <div class="flex items-center justify-between gap-2 px-3 py-2 bg-slate-100 border-b border-slate-300 rounded-t-xl">
                        <span class="${SECTION_HEAD}">${ROUND_LABEL} ${stand.id} · <span class="text-orange-600">${label}</span></span>
                        <button type="button" onclick="closeClayMeta()" class="${BTN_SMALL} bg-slate-900 text-white border-slate-900">Done</button>
                    </div>
                    <div class="p-3 space-y-2.5">${clayMetaPanelHtml(idx, meta)}</div>
                    <div data-clay-meta-preview="${idx}" class="px-3 pb-3 text-sm text-slate-700 ${text ? '' : 'hidden'}"><span class="font-semibold text-slate-900">Description:</span> <span data-clay-meta-preview-text>${escapeHtml(text)}</span></div>
                </div>
            </details>`;
        }).join('');
    }

    // Updates the open dialog in place (no innerHTML swap, so the outside-click handler
    // still sees the tapped button inside the dialog).
    function refreshClayMetaControl(targetIdx, meta) {
        const control = document.querySelector(`[data-clay-meta-control][data-clay-idx="${targetIdx}"]`);
        if (!control) return;
        const shown = effectiveClayMeta(meta);
        control.querySelectorAll('[data-meta-key]').forEach(btn => {
            const field = CLAY_META_FIELDS.find(f => f.key === btn.dataset.metaKey);
            const on = clayOptionOn(shown, field, btn.dataset.metaValue);
            btn.setAttribute('aria-pressed', String(on));
            btn.className = clayChipClass(on);
        });
        const text = clayMetaDescription(meta);
        const summaryEl = control.querySelector(`[data-clay-meta-summary="${targetIdx}"]`);
        if (summaryEl) {
            summaryEl.textContent = text || 'Tap to describe';
            summaryEl.className = `font-semibold ml-1 ${text ? 'text-slate-100' : 'text-slate-300 italic'}`;
            summaryEl.parentElement.title = text;
        }
        const preview = control.querySelector(`[data-clay-meta-preview="${targetIdx}"]`);
        if (preview) {
            preview.classList.toggle('hidden', !text);
            preview.querySelector('[data-clay-meta-preview-text]').textContent = text;
        }
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
        const fresh = {
            ground: '', date: new Date().toISOString().split('T')[0], event: '', notes: '',
            shooters: [{ id: Date.now(), name: 'Shooter 1', cpsa: '', class: 'U' }],
            stands, hits: {}, optionHits: {}, activeIdx: 0, isLocked: false
        };
        // Normalise now (normalizeState works on the global `state`) so a fresh round already has
        // the shape it will have after a reload; otherwise the first reload looks like an edit.
        const current = state;
        state = fresh;
        normalizeState();
        state = current;
        return fresh;
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
            // Only re-stamp _updatedAt when the round actually changed: sync resolves conflicts
            // by newest _updatedAt, so a save that merely re-opens a round mustn't look like an edit.
            const { _updatedAt: _prevStamp, ...prevContent } = store[newKey] || {};
            const { _updatedAt: _stateStamp, ...nextContent } = { ...state, _roundKey: newKey };
            if (!store[newKey] || JSON.stringify(prevContent) !== JSON.stringify(nextContent)) {
                store[newKey] = { ...nextContent, _updatedAt: Date.now() };
                dirty = true;
            }
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
        const shooter = state.shooters.find(s => s.id === id);
        const hasScores = Object.values(state.hits[id] || {}).some(arr => (arr || []).some(h => h !== null && h !== undefined))
            || (state.optionHits?.[id]?.hit ?? null) !== null;
        if (hasScores && !confirm(`Remove ${shooter?.name || 'this shooter'} and their recorded scores? This can't be undone.`)) return;
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
        lastTap = { shId, stId, idx };
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

    // Tap an option in the clay dialog. Single-choice fields toggle (tap again to clear);
    // Direction is multi-choice. The first edit of an untouched clay stores the defaults
    // the dialog was showing, then applies the tap as a plain selection.
    window.toggleClayMeta = (targetIdx, key, opt) => {
        if (state.isLocked || !HAS_STAND_DESCRIPTIONS) return;
        const st = state.stands[state.activeIdx];
        if (!st) return;
        st.clayMeta = normalizeClayMeta(st.clayMeta, presentationCountForStand(st));
        const meta = st.clayMeta[targetIdx];
        if (!meta) return;
        const fresh = isClayMetaEmpty(meta);
        if (fresh) Object.assign(meta, CLAY_META_DEFAULTS);
        if (key === 'direction') {
            const set = new Set(meta.direction || []);
            set.has(opt) ? set.delete(opt) : set.add(opt);
            meta.direction = CLAY_META_OPTIONS.direction.filter(v => set.has(v));
        } else if (fresh) {
            meta[key] = opt;
        } else {
            meta[key] = meta[key] === opt ? '' : opt;
        }
        refreshClayMetaControl(targetIdx, meta);
        save();
    };

    window.closeClayMeta = () => closeClayMetaControls();

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

    // Non-blocking message for outcomes that need no decision (import results, sync failures).
    // Keep confirm() for anything destructive.
    let toastTimer = null;
    function notify(message, tone = 'info') {
        const el = document.getElementById('toast');
        if (!el) { alert(message); return; }
        el.textContent = message;
        el.className = `toast toast-${tone}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 5000);
    }

    function getShooterTotal(shId) {
        let t = 0;
        state.stands.forEach(st => {
            if (state.hits[shId]?.[st.id]) t += state.hits[shId][st.id].filter(h => h === true).length;
        });
        if (getOptionHit(shId) === true) t++;
        return t;
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
            ? `Delete "${label}" from the current round and history${syncNote()}?`
            : `Delete the current ${D.name} round from this device?`;
        if (!confirm(message)) return;

        if (hasStoredRound) {
            delete store[key];
            writeHistory(store);
        }
        localStorage.removeItem(KEY_CURRENT);
        state = makeDefaultState();
        history = null;
        saveStateOnly();
        render();
    };

    window.deleteHistory = async () => {
        if (!confirm(`Delete all saved ${D.name} round history and the current round from this device${syncNote()}?`)) return;
        writeHistory({});
        localStorage.removeItem(KEY_HISTORY);
        localStorage.removeItem(KEY_CURRENT);
        state = makeDefaultState();
        history = null;
        saveStateOnly();
        render();
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
        if (!confirm(`Delete round "${label}" from history${syncNote()}?`)) return;
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
        if (HAS_STAND_DESCRIPTIONS && state.stands.some(s => (s.clayMeta || []).some(meta => !isClayMetaEmpty(meta)))) {
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
        try { text = await file.text(); } catch (err) { notify('Could not read file: ' + err.message, 'error'); return; }
        let parsed;
        try { parsed = parseCSV(text); } catch (err) { notify('Could not parse CSV: ' + err.message, 'error'); return; }

        // Discipline guard — the shared engine can only score what the current page is set up for.
        if (parsed.meta.discipline && parsed.meta.discipline !== D.name && parsed.meta.discipline !== D.code) {
            notify(`This CSV is from "${parsed.meta.discipline}". Open that discipline's page and import there.`, 'error');
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
            if (!ok) { notify(`Stand structure doesn't match ${D.name}'s fixed layout — import cancelled.`, 'error'); return; }
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
            notify('Import needs at least a Ground or Event so the round has an identity — import cancelled.', 'error');
            return;
        }
        if (store[importKey] && !confirm('A round already exists in history for this date/ground/event. Overwrite it?')) return;

        store[importKey] = { ...importedState, _roundKey: importKey, _updatedAt: Date.now() };
        writeHistory(store);
        renderHistory();

        if (confirm(`Imported "${importedState.ground || importedState.event}". Load it as the current round now?`)) {
            window.loadRound(importKey);
        } else {
            notify('Import saved to round history.', 'success');
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
            const descLines = standPresentationLines(st);
            const descTxt = descLines.length > 0;
            const descHtml = descTxt
                ? `<div style="font-size:${isShare ? '9pt' : '7pt'}; font-style:italic; font-weight:normal; line-height:1.15; padding:2px 4px 0; white-space:normal; word-break:break-word; text-align:left;">${descLines.map(escapeHtml).join('<br>')}</div>`
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
            ? `<div class="space-y-1 min-w-0">
                 <label for="field-stand-count" class="${LABEL}">Number of ${ROUND_LABEL.toLowerCase()}s</label>
                 <select id="field-stand-count" onchange="updateStandCount(this.value)" class="${FIELD}">
                   ${Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}">${i + 1} ${ROUND_LABEL}${i > 0 ? 's' : ''}</option>`).join('')}
                 </select>
               </div>`
            : `<div class="space-y-1 min-w-0">
                 <span class="${LABEL}">Format</span>
                 <div id="field-format" class="h-11 flex items-center bg-slate-100 border border-slate-300 rounded-lg px-2 text-sm font-semibold text-slate-700"></div>
               </div>`;
        const standDescriptionControl = HAS_STAND_DESCRIPTIONS && !HAS_PRESENTATION_MAP
            ? `<div class="bg-slate-500 px-3 py-2 border-t border-slate-400 no-print">
                    <div class="text-[11px] font-semibold text-white mb-1.5">Clay presentation (optional) — tap a clay to describe it</div>
                    <div id="clay-meta-controls" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5"></div>
                </div>`
            : '';
        const headerBtn = 'bg-slate-800 h-9 px-2 rounded-lg border border-slate-700 inline-flex items-center gap-1.5 text-slate-200';

        document.getElementById('app-root').innerHTML = `
        <header id="app-header" class="bg-slate-900 text-white sticky top-0 z-50 shadow-md no-print w-full relative">
            <div class="max-w-5xl mx-auto p-3 flex justify-between items-center gap-2 relative">
                <div class="flex items-center gap-2 min-w-0">
                    <a href="index.html" aria-label="All disciplines" title="All disciplines" class="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-orange-500 rounded-lg shadow-sm">
                        <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6">
                            <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>
                        </svg>
                    </a>
                    <div class="min-w-0">
                        <div class="text-[11px] text-orange-400 font-black uppercase tracking-widest leading-none">${D.code}</div>
                        <h1 class="text-base font-bold tracking-tight uppercase italic leading-none mt-0.5 truncate max-w-[110px] sm:max-w-none">${D.name}</h1>
                    </div>
                    <span id="offline-status" class="hidden flex-shrink-0 items-center gap-1 rounded-full bg-slate-800 border border-slate-700 px-2 py-0.5 text-[11px] font-semibold text-amber-300" title="No connection — scores are still saved on this device">
                        <i data-lucide="wifi-off" class="w-3 h-3"></i><span class="hidden sm:inline">Offline</span>
                    </span>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                    <button id="history-menu-btn" onclick="toggleHeaderMenu('history')" class="${headerBtn}" aria-expanded="false" aria-controls="history-dropdown" aria-label="Round history" title="Round history">
                        <i data-lucide="archive" class="w-4 h-4"></i>
                        <span class="hidden sm:inline text-xs font-semibold">History</span>
                        <span id="history-count-badge" class="min-w-5 h-5 px-1 rounded bg-orange-500 text-white text-[11px] font-black leading-5 text-center">0</span>
                    </button>
                    <button id="cloud-menu-btn" onclick="toggleHeaderMenu('cloud')" class="${headerBtn}" aria-expanded="false" aria-controls="cloud-dropdown" aria-label="Cloud sync" title="Cloud sync">
                        <i data-lucide="cloud" class="w-4 h-4"></i>
                        <span id="cloud-status-badge" class="h-5 px-1.5 rounded bg-slate-700 text-slate-300 text-[11px] font-black leading-5 text-center uppercase">Off</span>
                    </button>
                    <button id="export-menu-btn" onclick="toggleHeaderMenu('export')" class="bg-orange-500 h-9 px-2 rounded-lg border border-orange-400 inline-flex items-center gap-1.5 text-white" aria-expanded="false" aria-controls="export-dropdown" aria-label="Export or share" title="Export or share">
                        <i data-lucide="share-2" class="w-4 h-4"></i>
                        <span class="hidden sm:inline text-xs font-semibold">Export</span>
                    </button>
                    <button id="lock-btn" onclick="toggleLock()" class="${headerBtn}" aria-pressed="false" aria-label="Lock scores" title="Lock scores">
                        <i data-lucide="unlock" id="lock-icon" class="w-4 h-4"></i>
                        <span id="lock-label" class="hidden sm:inline text-xs font-semibold">Lock</span>
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
                    <div id="export-dropdown" class="hidden pointer-events-auto absolute right-2 top-2 w-60">
                        <div class="bg-white text-slate-900 rounded-xl shadow-xl border border-slate-200 overflow-hidden p-2">
                            <button onclick="closeHeaderMenus(); exportToPDF();" class="${MENU_ITEM}">
                                <i data-lucide="printer" class="w-4 h-4 text-slate-500"></i>
                                Print / save as PDF
                            </button>
                            <button onclick="closeHeaderMenus(); shareAsImage();" class="${MENU_ITEM}">
                                <i data-lucide="image" class="w-4 h-4 text-slate-500"></i>
                                Share scorecard image
                            </button>
                            <button onclick="closeHeaderMenus(); downloadCSV();" class="${MENU_ITEM}">
                                <i data-lucide="file-spreadsheet" class="w-4 h-4 text-slate-500"></i>
                                Download CSV
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </header>

        <main id="app-container" class="max-w-5xl mx-auto p-2 space-y-3">

            <details id="setup-panel" class="${CARD} no-print group" open>
                <summary class="list-none cursor-pointer p-3 block">
                    <!-- Flex lives on inner divs: iOS Safari doesn't reliably lay out a flex <summary>. -->
                    <div class="flex items-center gap-2">
                        <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 flex-shrink-0 transition-transform group-open:rotate-90"></i>
                        <div class="flex-1 min-w-0 ${SECTION_HEAD}">Round setup</div>
                        <button onclick="event.preventDefault(); newRound()" class="${BTN_SMALL} bg-white text-slate-700 border-slate-300 flex-shrink-0">+ New round</button>
                    </div>
                    <div id="setup-summary" class="mt-1 pl-6 text-sm font-semibold text-slate-800 break-words"></div>
                </summary>
                <div class="px-3 pb-3 pt-3 space-y-4 border-t border-slate-100">
                    <div class="grid grid-cols-2 gap-2">
                        <div class="col-span-2 sm:col-span-1 space-y-1 min-w-0">
                            <label for="field-ground" class="${LABEL}">Shooting ground</label>
                            <input type="text" id="field-ground" placeholder="e.g. West Wycombe" class="${FIELD}" oninput="updateField('ground', this.value)" onchange="commitField('ground', this.value)">
                        </div>
                        <div class="space-y-1 min-w-0">
                            <label for="field-date" class="${LABEL}">Date</label>
                            <input type="date" id="field-date" class="${FIELD}" onchange="commitField('date', this.value)">
                        </div>
                        ${setupStand}
                        <div class="col-span-2 space-y-1">
                            <label for="field-event" class="${LABEL}">Event name</label>
                            <input type="text" id="field-event" placeholder="e.g. Club Championship" class="${FIELD}" oninput="updateField('event', this.value)" onchange="commitField('event', this.value)">
                        </div>
                        <p class="col-span-2 text-xs text-slate-500">Scores save automatically. Enter a ground or event name to keep this round in History.</p>
                    </div>

                    <div>
                        <div class="flex justify-between items-center mb-2">
                            <h3 class="${SECTION_HEAD}">Squad <span id="squad-count" class="normal-case font-semibold text-slate-400"></span></h3>
                            <button id="add-shooter-btn" onclick="addShooter()" class="${BTN_SMALL} bg-slate-900 text-white border-slate-900 disabled:opacity-40">+ Add shooter</button>
                        </div>
                        <div class="squad-grid-item px-2.5 pb-1 text-[11px] font-semibold text-slate-700" aria-hidden="true">
                            <span>#</span><span>Name</span><span>CPSA no.</span><span>Class</span><span></span>
                        </div>
                        <div id="squad-list" class="space-y-2"></div>
                    </div>

                    ${HAS_PRESENTATION_MAP ? `
                    <details class="group/stand rounded-xl border border-slate-200 overflow-hidden">
                        <summary class="list-none cursor-pointer p-2.5 bg-slate-100 block ${SECTION_HEAD}">
                            <div class="flex items-center gap-1.5"><i data-lucide="chevron-right" class="w-4 h-4 flex-shrink-0 transition-transform group-open/stand:rotate-90"></i> Stand setup</div>
                        </summary>
                        <p class="px-3 py-2 text-xs text-slate-600 bg-white">A <strong>round</strong> (R1–R${state.stands.length}) is one pass of the squad. Each shooter starts each round on a physical <strong>stand</strong> (1–${physicalStandCount()}). Set how each stand's clays are thrown here.</p>
                        <div id="stand-shot-controls"></div>
                    </details>
                    ` : ''}
                </div>
            </details>

            <div id="stand-nav-wrap" class="sticky z-40 -mx-2 px-2 py-1 bg-slate-300/95 backdrop-blur no-print" style="top: var(--header-h, 64px)">
                <div id="stand-nav" class="flex items-center gap-1.5 overflow-x-auto scrollbar-hide px-1 py-1" role="tablist" aria-label="${ROUND_LABEL}s"></div>
            </div>
            ${OPTION ? `
            <section id="option-status" class="${CARD} p-2 no-print"></section>
            ` : ''}

            ${HAS_PRESENTATION_MAP ? `
            <details id="presentation-panel" class="${CARD} group overflow-visible no-print" open>
                <summary class="list-none cursor-pointer p-2.5 bg-slate-100 rounded-xl block ${SECTION_HEAD}">
                    <div class="flex items-center justify-between gap-2">
                        <span class="flex items-center gap-1.5 min-w-0"><i data-lucide="chevron-right" class="w-4 h-4 flex-shrink-0 transition-transform group-open:rotate-90"></i> Presentations <span id="presentation-round" class="normal-case font-semibold text-slate-500"></span></span>
                        ${D.id === 'compak' ? `<button onclick="event.preventDefault(); addPresentationOption()" class="${BTN_SMALL} bg-slate-900 text-white border-slate-900 normal-case tracking-normal flex-shrink-0">+ Presentation</button>` : ''}
                    </div>
                </summary>
                <div id="fixed-presentation-controls" class="p-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5"></div>
            </details>
            ` : ''}

            <div id="lock-banner" class="hidden no-print rounded-xl border border-amber-300 bg-amber-100 text-amber-900 p-3 items-center justify-between gap-2">
                <span class="text-sm font-semibold flex items-center gap-2"><i data-lucide="lock" class="w-4 h-4"></i> Round locked — scores can't be changed</span>
                <button onclick="toggleLock()" class="${BTN_SMALL} bg-amber-900 text-white border-amber-900">Unlock</button>
            </div>

            <section id="scoring-card" class="bg-white rounded-xl shadow-lg border border-slate-200 overflow-visible no-print">
                <div class="bg-slate-600 px-3 py-2.5 text-white flex justify-between items-center rounded-t-xl">
                    <div class="flex items-baseline gap-2">
                        <h2 id="active-stand-title" class="text-xl font-black italic uppercase">${ROUND_LABEL} 1</h2>
                        <span id="active-stand-targets" class="text-xs text-orange-200 font-semibold"></span>
                    </div>
                    <button id="undo-btn" onclick="undo()" class="hidden ${BTN_SMALL} text-white items-center gap-1 bg-slate-700 border-slate-500">
                        <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> Undo
                    </button>
                </div>

                ${standDescriptionControl}

                <div id="scoring-controls"></div>
                <div id="scoring-area" class="divide-y divide-slate-300"></div>
            </section>

            <section class="${CARD} overflow-hidden no-print">
                <div class="p-2.5 bg-slate-100 border-b border-slate-300 ${SECTION_HEAD}">Leaderboard</div>
                <div class="overflow-x-auto">
                    <table class="w-full text-xs" id="leaderboard">
                        <thead><tr id="lb-header" class="bg-slate-100 font-bold border-b border-slate-300"></tr></thead>
                        <tbody id="lb-body"></tbody>
                        <tfoot id="lb-footer"></tfoot>
                    </table>
                </div>
                <p class="px-3 py-2 text-[11px] text-slate-700 border-t border-slate-200">&#128293; no misses so far &middot; &#10071; hardest completed ${ROUND_LABEL.toLowerCase()} &middot; shaded row = current ${ROUND_LABEL.toLowerCase()}</p>
            </section>

            <section class="${CARD} p-3 no-print">
                <label for="field-notes" class="${SECTION_HEAD} mb-1.5 flex items-center gap-1"><i data-lucide="sticky-note" class="w-3.5 h-3.5"></i> Round notes</label>
                <textarea id="field-notes" placeholder="Weather, conditions, anything to remember…" class="w-full h-20 bg-white border border-slate-400 rounded-xl p-3 text-sm outline-none focus:ring-1 focus:ring-orange-500 resize-none" oninput="updateField('notes', this.value)"></textarea>
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

        <nav id="stand-nav-bar" class="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-300 shadow-[0_-4px_12px_rgba(15,23,42,0.12)] no-print" style="padding-bottom: env(safe-area-inset-bottom)">
            <div class="max-w-5xl mx-auto p-2 flex gap-2">
                <button onclick="nav(-1)" id="nav-prev" class="flex-1 bg-white border border-slate-300 h-12 rounded-xl text-sm font-bold disabled:opacity-30 inline-flex items-center justify-center gap-1"><i data-lucide="chevron-left" class="w-4 h-4"></i> Prev</button>
                <button onclick="nav(1)" id="nav-next" class="flex-[2] bg-slate-900 text-white h-12 rounded-xl text-sm font-bold disabled:opacity-30 inline-flex items-center justify-center gap-1">Next ${ROUND_LABEL.toLowerCase()} <i data-lucide="chevron-right" class="w-4 h-4"></i></button>
            </div>
        </nav>
        <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
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
            if (totalShot) parts.push(`${totalHits}/${totalShot} hit`);
            const meta = parts.join(' &middot; ');
            const encKey = escapeHtml(k);
            return `<div class="flex items-center gap-2 px-3 py-2.5 border-t border-slate-100 ${isCurrent ? 'bg-orange-50' : ''}">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-bold truncate">${escapeHtml(title)}${subtitle ? ` <span class="font-semibold text-slate-500">&middot; ${escapeHtml(subtitle)}</span>` : ''}</div>
                    <div class="text-xs text-slate-500 mt-0.5">${meta}${isCurrent ? ' &middot; <span class="text-orange-700 font-semibold">Open now</span>' : ''}</div>
                </div>
                ${isCurrent ? '' : `<button data-history-action="load" data-history-key="${encKey}" class="${BTN_SMALL} bg-slate-900 text-white border-slate-900">Open</button>`}
                <button data-history-action="delete" data-history-key="${encKey}" class="text-red-500 p-1.5" aria-label="Delete round ${escapeHtml(title)}" title="Delete round"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`;
        }).join('');

        const emptyHint = entries.length ? '' : '<p class="text-xs text-slate-500 mt-1">No saved rounds yet. A round is saved here automatically once it has a ground or event name.</p>';
        el.innerHTML = `
            <div class="p-3 border-b border-slate-100">
                <div class="flex items-center justify-between gap-2">
                    <h3 class="${SECTION_HEAD}">Round history</h3>
                    <div class="flex flex-wrap justify-end gap-1.5">
                        <label class="${BTN_SMALL} bg-slate-100 text-slate-700 border-slate-200 cursor-pointer inline-flex items-center gap-1">
                            <i data-lucide="upload" class="w-3.5 h-3.5"></i> Import CSV
                            <input type="file" accept=".csv,text/csv" onchange="handleImportChange(this)" style="display:none">
                        </label>
                        <button onclick="closeHeaderMenus(); newRound()" class="${BTN_SMALL} bg-slate-900 text-white border-slate-900">+ New round</button>
                    </div>
                </div>
                ${emptyHint}
            </div>
            ${entries.length ? `<div class="max-h-72 overflow-y-auto">${rows}</div>` : ''}
            ${entries.length ? `<div class="p-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-2">
                <span class="text-[11px] font-semibold text-slate-500">Danger zone</span>
                <button onclick="deleteHistory()" class="${BTN_SMALL} bg-white text-red-600 border-red-200">Delete all history</button>
            </div>` : ''}`;
        if (window.lucide) lucide.createIcons();
    }

    function renderScoringControls() {
        const el = document.getElementById('scoring-controls');
        if (!D.editable.targetsPerStand && !D.editable.extraClay) { el.innerHTML = ''; return; }
        const st = state.stands[state.activeIdx];
        let html = '';
        if (D.editable.targetsPerStand) {
            const opts = D.targetOptions || [4, 6, 8, 10];
            html += `<div class="bg-slate-500 px-2 pt-2 pb-1 no-print">
                <div class="text-[11px] font-semibold text-white mb-1">Pairs on this ${ROUND_LABEL.toLowerCase()}</div>
                <div class="flex gap-1">${opts.map(o => `
                    <button onclick="setBirds(${o})" aria-pressed="${st.targets === o}" class="flex-1 h-9 rounded-lg text-sm font-bold ${st.targets === o ? 'bg-orange-500 text-white ring-2 ring-white' : 'bg-slate-600 text-white'}">${o / 2}</button>
                `).join('')}</div>
            </div>`;
        }
        if (D.editable.extraClay) {
            html += `<div class="bg-slate-500 px-2 pb-2 pt-1 no-print">
                <button onclick="setExtraClay()" role="switch" aria-checked="${!!st.extraClay}" class="w-full h-9 px-2 rounded-lg text-sm font-semibold flex items-center justify-between ${st.extraClay ? 'bg-orange-500 text-white' : 'bg-slate-600 text-white'}">
                    <span>Extra single clay (+1)</span>
                    <span class="toggle-track ${st.extraClay ? 'is-on' : ''}"><span class="toggle-thumb"></span></span>
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
            const presentations = getStandPresentationMap(stand);
            const clayHtml = shotGroups(stand, getStandFormatMap(stand)).map(shotIdxs => {
                const p = shotIdxs[0];
                const value = getStandFormatMap(stand)[p] || 'single';
                const label = shotIdxs.length === 2 ? `${p + 1}–${p + 2}` : `${p + 1}`;
                const presentationSelects = shotIdxs.map(idx => {
                    const selected = presentations[idx] || '';
                    return `<select onchange="updateStandShotPresentation(${stand.id},${idx},this.value)" ${state.isLocked ? 'disabled' : ''} aria-label="${PHYSICAL_STAND_LABEL} ${stand.id} clay ${idx + 1} presentation" class="w-full h-8 bg-slate-50 border border-slate-200 rounded-md px-1 text-xs font-semibold text-slate-700 disabled:opacity-60">
                        <option value="">–</option>
                        ${Array.from({ length: presentationCountForStand(stand) }, (_, optIdx) => optIdx + 1).map(opt => `<option value="${opt}" ${selected === opt ? 'selected' : ''}>${presentationLabel(opt - 1)}</option>`).join('')}
                    </select>`;
                }).join('');
                return `<div class="pair-stack" style="flex:${shotIdxs.length} 1 0; min-width:${shotIdxs.length * 64}px;">
                    <label class="block text-[11px] font-semibold text-slate-500 mb-0.5">Clay ${label}</label>
                    <select onchange="updateStandShotFormat(${stand.id},${p},this.value)" ${state.isLocked ? 'disabled' : ''} aria-label="${PHYSICAL_STAND_LABEL} ${stand.id} clay ${label} format" class="w-full h-8 bg-slate-900 text-white border border-slate-700 rounded-md px-1 text-xs font-semibold disabled:opacity-60">
                        <option value="single" ${value === 'single' ? 'selected' : ''}>Single</option>
                        <option value="report" ${value === 'report' ? 'selected' : ''}>On report</option>
                        <option value="sim" ${value === 'sim' ? 'selected' : ''}>Sim pair</option>
                    </select>
                    <div class="mt-1 flex gap-1">${presentationSelects}</div>
                </div>`;
            }).join('');
            return `<div class="py-2 border-t border-slate-200 first:border-t-0">
                <div class="text-xs font-bold uppercase tracking-wider text-orange-600 mb-1.5">${PHYSICAL_STAND_LABEL} ${stand.id}</div>
                <div class="flex flex-wrap gap-1 w-full">${clayHtml}</div>
            </div>`;
        }).join('');
        el.innerHTML = `<div class="bg-white px-3 pb-3">
            ${standRows}
        </div>`;
    }

    // Groups a stand's target indices by how they're thrown, so pairs render side by side in
    // one pair-stack and singles get their own. STR/CSP follow the per-stand format map;
    // labelled stands (ESK) pair the doubles (H+L / L+H / H/L); ESP pairs consecutive
    // targets and leaves the +1 extra clay single.
    function shotGroups(stand, formatMap) {
        const total = standTargets(stand);
        const isDouble = (idx) => /[+/]/.test(stand.labels?.[idx] || '');
        const groups = [];
        for (let p = 0; p < total;) {
            let size;
            if (HAS_PRESENTATION_MAP) size = (formatMap[p] || 'single') !== 'single' ? 2 : 1;
            else if (stand.labels) size = isDouble(p) && isDouble(p + 1) ? 2 : 1;
            else size = stand.extraClay && p === total - 1 ? 1 : 2;
            size = Math.min(size, total - p);
            groups.push(Array.from({ length: size }, (_, offset) => p + offset));
            p += size;
        }
        return groups;
    }

    // 'empty' | 'partial' | 'done' across the whole squad, for the stand nav markers.
    function standProgress(stand) {
        let shot = 0, done = state.shooters.length > 0;
        state.shooters.forEach(sh => {
            const stats = shooterStandStats(sh.id, stand);
            shot += stats.shot;
            if (!stats.completed) done = false;
        });
        return done ? 'done' : (shot > 0 ? 'partial' : 'empty');
    }

    // Setup auto-collapses once the first target is recorded and re-opens for a fresh round;
    // in between, the user's own open/close choice is left alone.
    let lastAnyShot = null;
    // Phone score strips (SCROLL_SCORE_ROWS): keep each shooter's sideways scroll across
    // re-renders, and nudge the next group into view when a tap completes the current one.
    let lastTap = null;
    let lastStripStandId = null;

    function updateStripFade(strip) {
        const max = strip.scrollWidth - strip.clientWidth;
        strip.classList.toggle('fade-left', strip.scrollLeft > 2);
        strip.classList.toggle('fade-right', max > 2 && strip.scrollLeft < max - 2);
    }

    // Scroll needed (from `left`) to show `el` fully inside `strip`.
    function stripLeftToShow(strip, el, left) {
        const start = el.offsetLeft;
        const end = start + el.offsetWidth;
        if (start < left) return start;
        if (end > left + strip.clientWidth) return end - strip.clientWidth;
        return left;
    }

    function positionScoreStrips(sArea, st, prevStripScroll) {
        const sameStand = lastStripStandId === st.id;
        const tap = lastTap;
        lastTap = null;
        lastStripStandId = st.id;
        sArea.querySelectorAll('[data-score-strip]').forEach(strip => {
            const shId = Number(strip.dataset.scoreStrip);
            if (strip.scrollWidth <= strip.clientWidth + 1) { updateStripFade(strip); return; }
            const groups = Array.from(strip.children);
            let left;
            if (sameStand && prevStripScroll[shId] !== undefined) {
                left = prevStripScroll[shId];
            } else {
                // New stand (or first render): open on this shooter's first unfinished group.
                const next = groups.find(g => !g.hasAttribute('data-done'));
                left = next ? stripLeftToShow(strip, next, 0) : strip.scrollWidth;
            }
            strip.scrollLeft = left;
            if (tap && tap.shId === shId && tap.stId === st.id) {
                const tapped = groups.find(g => Number(g.dataset.first) <= tap.idx && tap.idx <= Number(g.dataset.last));
                const next = tapped?.hasAttribute('data-done') ? tapped.nextElementSibling : null;
                if (next) {
                    const target = stripLeftToShow(strip, next, strip.scrollLeft);
                    if (target !== strip.scrollLeft) strip.scrollTo({ left: target, behavior: 'smooth' });
                }
            }
            updateStripFade(strip);
            strip.addEventListener('scroll', () => updateStripFade(strip), { passive: true });
        });
    }

    function render() {
        if (!state.stands.length) return;
        if (state.activeIdx >= state.stands.length) state.activeIdx = state.stands.length - 1;
        const st = state.stands[state.activeIdx];

        const lockBtn = document.getElementById('lock-btn');
        document.getElementById('lock-icon').setAttribute('data-lucide', state.isLocked ? 'lock' : 'unlock');
        document.getElementById('lock-label').textContent = state.isLocked ? 'Locked' : 'Lock';
        lockBtn.setAttribute('aria-pressed', state.isLocked ? 'true' : 'false');
        lockBtn.setAttribute('aria-label', state.isLocked ? 'Unlock scores' : 'Lock scores');
        lockBtn.title = state.isLocked ? 'Unlock scores' : 'Lock scores';
        lockBtn.classList.toggle('lock-on', !!state.isLocked);
        const lockBanner = document.getElementById('lock-banner');
        lockBanner.classList.toggle('hidden', !state.isLocked);
        lockBanner.classList.toggle('flex', !!state.isLocked);
        document.getElementById('scoring-card').classList.toggle('is-locked', !!state.isLocked);
        document.getElementById('undo-btn').style.display = history ? 'inline-flex' : 'none';

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
        const totalTargets = scheduledRoundTargets() + (OPTION ? 1 : 0);
        if (D.editable.standCount) {
            document.getElementById('field-stand-count').value = state.stands.length;
        } else {
            document.getElementById('field-format').innerText = `${state.stands.length} ${ROUND_LABEL.toLowerCase()}s · ${totalTargets} targets`;
        }
        const anyShot = sTotalShot > 0;
        const setupPanel = document.getElementById('setup-panel');
        if (anyShot !== lastAnyShot) {
            setupPanel.open = !anyShot;
            const presentationPanel = document.getElementById('presentation-panel');
            if (presentationPanel) presentationPanel.open = !anyShot;
            lastAnyShot = anyShot;
        }
        const nameParts = [(state.ground || '').trim(), (state.event || '').trim()].filter(Boolean);
        document.getElementById('setup-summary').textContent = [
            nameParts.length ? nameParts.join(' · ') : 'Unnamed round',
            getUKDate(state.date),
            `${state.shooters.length} shooter${state.shooters.length !== 1 ? 's' : ''}`,
            `${totalTargets} targets`
        ].join(' · ');

        // Squad
        document.getElementById('squad-count').textContent = `(${state.shooters.length}/${MAX_SHOOTERS})`;
        document.getElementById('add-shooter-btn').disabled = state.shooters.length >= MAX_SHOOTERS;
        const list = document.getElementById('squad-list'); list.innerHTML = '';
        state.shooters.forEach((s, i) => {
            const div = document.createElement('div');
            div.className = 'bg-slate-50 p-2 rounded-xl border border-slate-300 squad-grid-item';
            div.innerHTML = `<span class="text-xs font-bold text-slate-700 text-center">${i + 1}</span>
                <input type="text" value="${escapeHtml(s.name)}" maxlength="20" placeholder="Name" aria-label="Shooter ${i + 1} name" onchange="updateShooter(${i}, 'name', this.value)" class="bg-white border border-slate-400 rounded-md px-2 py-1.5 text-sm font-semibold w-full min-w-0">
                <input type="text" value="${escapeHtml(s.cpsa)}" maxlength="8" placeholder="CPSA no." aria-label="Shooter ${i + 1} CPSA number" onchange="updateShooter(${i}, 'cpsa', this.value)" class="bg-white border border-slate-400 rounded-md px-2 py-1.5 text-sm w-full min-w-0">
                <select onchange="updateShooter(${i}, 'class', this.value)" aria-label="Shooter ${i + 1} class" class="bg-white border border-slate-400 rounded-md px-1 py-1.5 text-sm font-semibold w-full">${CLASSES.map(c => `<option ${s.class === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
                <button onclick="removeShooter(${s.id})" ${state.shooters.length <= 1 ? 'disabled' : ''} class="text-red-500 flex justify-center items-center h-8 disabled:opacity-20" aria-label="Remove ${escapeHtml(s.name)}" title="Remove shooter"><i data-lucide="x" class="w-5 h-5"></i></button>`;
            list.appendChild(div);
        });

        // Stand nav — each button shows whether the squad has finished that stand.
        const navDiv = document.getElementById('stand-nav'); navDiv.innerHTML = '';
        state.stands.forEach((s, i) => {
            const progress = standProgress(s);
            const isActive = state.activeIdx === i;
            const btn = document.createElement('button');
            btn.className = `stand-nav-btn flex-shrink-0 w-12 h-12 rounded-xl font-black text-sm border-2 transition-all ${isActive ? 'bg-orange-500 border-orange-500 text-white shadow-lg' : (progress === 'done' ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-white border-slate-400 text-slate-800')}`;
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            btn.setAttribute('aria-label', `${ROUND_LABEL} ${s.id}, ${progress === 'done' ? 'complete' : (progress === 'partial' ? 'in progress' : 'not started')}`);
            btn.innerHTML = `${HAS_PRESENTATION_MAP ? `R${s.id}` : s.id}${progress !== 'empty' ? `<span class="stand-nav-mark stand-nav-${progress}"></span>` : ''}`;
            btn.onclick = () => { if (!state.isLocked) { state.activeIdx = i; render(); save(); } };
            navDiv.appendChild(btn);
            // Scroll only the nav strip (not the page) so the active stand stays visible.
            if (isActive) requestAnimationFrame(() => {
                const left = btn.offsetLeft - navDiv.offsetLeft;
                if (left < navDiv.scrollLeft || left + btn.offsetWidth > navDiv.scrollLeft + navDiv.clientWidth) {
                    navDiv.scrollLeft = left - (navDiv.clientWidth - btn.offsetWidth) / 2;
                }
            });
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
                    ? `used on ${ROUND_LABEL.toLowerCase()} ${opt.standId}`
                    : (available ? `due on ${ROUND_LABEL.toLowerCase()} ${optStandId}` : 'not yet');
                const cls = used
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : (available ? 'bg-orange-50 border-orange-300 text-orange-800' : 'bg-slate-50 border-slate-200 text-slate-600');
                const dot = used ? 'bg-emerald-500' : (available ? 'bg-orange-500' : 'bg-slate-300');
                return `<div class="min-w-0 flex items-center gap-1.5 rounded-lg border px-2 py-1 ${cls}">
                    <span class="w-2 h-2 rounded-full flex-shrink-0 ${dot}"></span>
                    <span class="truncate font-bold">${escapeHtml(sh.name)}</span>
                    <span class="flex-shrink-0">${text}</span>
                </div>`;
            }).join('');
            optionStatus.innerHTML = `<div class="flex items-center gap-2">
                <div class="flex-shrink-0 ${SECTION_HEAD}" title="Option target: first miss is re-shot; if straight, taken on ${ROUND_LABEL.toLowerCase()} ${OPTION.fallbackStandId || ''}">${escapeHtml(optLabel)}</div>
                <div class="flex-1 min-w-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1 text-xs">${chips}</div>
            </div>`;
        }

        // Active header
        document.getElementById('active-stand-title').innerText = `${ROUND_LABEL} ${st.id}`;
        const total = standTargets(st);
        const optionAvailableHere = OPTION && state.shooters.some(sh => getOptionStandId(sh.id) === st.id);
        document.getElementById('active-stand-targets').innerText = `${total} target${total !== 1 ? 's' : ''}${st.extraClay ? ' incl. +1' : ''}${optionAvailableHere ? ` + ${OPTION.label || 'OPT'}` : ''}`;
        const presentationRound = document.getElementById('presentation-round');
        if (presentationRound) presentationRound.textContent = `· ${ROUND_LABEL.toLowerCase()} ${st.id}`;
        const clayMetaEl = document.getElementById('clay-meta-controls');
        if (clayMetaEl) clayMetaEl.innerHTML = renderClayMetaControls(st);
        const fixedPresentationEl = document.getElementById('fixed-presentation-controls');
        if (fixedPresentationEl) fixedPresentationEl.innerHTML = renderClayMetaControls(st);
        renderScoringControls();
        renderStandFormatControls();

        // Scoring rows. Sporting rotates first-up; Compak/Sportrap keep shooter order fixed.
        const n = state.shooters.length;
        const leadIdx = ROTATE ? (state.activeIdx % n) : 0;
        const sArea = document.getElementById('scoring-area');
        const prevStripScroll = {};
        if (lastStripStandId === st.id) {
            sArea.querySelectorAll('[data-score-strip]').forEach(el => { prevStripScroll[el.dataset.scoreStrip] = el.scrollLeft; });
        }
        sArea.innerHTML = '';
        const visibleShooters = Array.from({ length: n }, (_, i) => state.shooters[(i + leadIdx) % n]);
        // "Shooting" = first shooter in order who hasn't finished this stand; none once everyone's done.
        const activeShooterId = visibleShooters.find(sh => !shooterStandStats(sh.id, st).completed)?.id ?? null;

        for (let i = 0; i < n; i++) {
            const s = visibleShooters[i];
            const hits = state.hits[s.id]?.[st.id] || Array(total).fill(null);
            const optionStandId = getOptionStandId(s.id);
            const optionOnThisStand = OPTION && optionStandId === st.id;
            const optionHit = optionOnThisStand ? getOptionHit(s.id) : null;
            const count = hits.filter(h => h === true).length + (optionHit === true ? 1 : 0);
            const possible = total + (optionOnThisStand ? 1 : 0);
            const isShooting = s.id === activeShooterId;
            const row = document.createElement('div');
            row.className = `p-2.5 space-y-1.5 ${isShooting ? 'first-up-highlight' : ''} ${state.isLocked ? 'pointer-events-none' : ''}`;

            const selectedStandId = HAS_PRESENTATION_MAP ? getShooterRoundStand(s.id, st.id) : st.id;
            const setupStand = HAS_PRESENTATION_MAP ? (state.stands.find(stand => stand.id === selectedStandId) || st) : st;
            const standFormatMap = HAS_PRESENTATION_MAP ? getStandFormatMap(setupStand) : [];
            const standPresentationMap = HAS_PRESENTATION_MAP ? getStandPresentationMap(setupStand) : [];
            const shooterStandSelect = HAS_PRESENTATION_MAP
                ? `<select onchange="updateShooterRoundStand(${s.id},${st.id},this.value)" aria-label="${escapeHtml(s.name)} starts on stand" class="h-7 bg-slate-50 border border-slate-200 rounded-md px-1 text-xs font-semibold text-slate-700">
                    ${state.stands.map(setup => `<option value="${setup.id}" ${selectedStandId === setup.id ? 'selected' : ''}>${PHYSICAL_STAND_LABEL} ${setup.id}</option>`).join('')}
                </select>`
                : '';
            const formatCaption = { single: 'Single', report: 'On report', sim: 'Sim pair' };
            let pairNo = 0;
            const groups = shotGroups(st, standFormatMap);
            const gridHtml = groups.map(shotIdxs => {
                const isExtra = st.extraClay && shotIdxs.includes(total - 1);
                if (shotIdxs.length === 2) pairNo++;
                // Caption above each stack says what's being thrown: a pair number, the +1, or the STR/CSP format.
                const caption = HAS_PRESENTATION_MAP
                    ? formatCaption[standFormatMap[shotIdxs[0]] || 'single']
                    : (isExtra ? '+1 single' : (st.labels ? '' : `Pair ${pairNo}`));
                const scoreBtn = (idx, val) => {
                    const selected = hits[idx] === val;
                    return `<button onclick="toggleHit(${s.id},${st.id},${idx},${val})" aria-pressed="${selected}" aria-label="${escapeHtml(s.name)}, target ${idx + 1}, ${val ? 'hit' : 'miss'}" class="${scoreBtnClass(selected, val)}">${val ? 'H' : 'M'}</button>`;
                };
                const presentationBadges = shotIdxs.map(idx => {
                    const value = standPresentationMap[idx];
                    return `<div class="flex-1 min-w-0 h-6 rounded-md bg-slate-100 border border-slate-200 px-1 text-[11px] font-bold text-slate-700 flex items-center justify-center">${value ? presentationLabel(value - 1) : '–'}</div>`;
                }).join('');
                const labels = shotIdxs.map(idx => st.labels?.[idx] ?? '');
                const groupDone = shotIdxs.every(idx => hits[idx] !== null && hits[idx] !== undefined);
                return `<div class="${isExtra ? 'pair-stack pair-extra' : 'pair-stack'}" data-shots="${shotIdxs.length}" data-first="${shotIdxs[0]}" data-last="${shotIdxs[shotIdxs.length - 1]}" ${groupDone ? 'data-done' : ''} style="flex:${shotIdxs.length} 1 0; min-width:${shotIdxs.length * 40 + 8}px; --shots:${shotIdxs.length};">
                    ${caption ? `<div class="text-[11px] font-bold text-slate-700 text-center leading-none pt-0.5">${caption}</div>` : ''}
                    <div class="flex gap-1">${shotIdxs.map(idx => scoreBtn(idx, true)).join('')}</div>
                    <div class="flex gap-1">${shotIdxs.map(idx => scoreBtn(idx, false)).join('')}</div>
                    ${HAS_PRESENTATION_MAP ? `<div class="flex gap-1">${presentationBadges}</div>` : ''}
                    ${labels.some(Boolean) ? `<div class="flex gap-1 text-xs font-bold text-slate-600 text-center">${labels.map(l => `<div class="flex-1">${escapeHtml(l)}</div>`).join('')}</div>` : ''}
                </div>`;
            }).join('');
            const optionHtml = optionOnThisStand ? (() => {
                const optLabel = OPTION.label || 'OPT';
                const optBtn = (val) => `<button onclick="toggleOptionHit(${s.id},${st.id},${val})" aria-pressed="${optionHit === val}" aria-label="${escapeHtml(s.name)}, option target, ${val ? 'hit' : 'miss'}" class="${scoreBtnClass(optionHit === val, val)}">${val ? 'H' : 'M'}</button>`;
                return `<div class="pair-stack pair-extra" data-shots="1" ${optionHit !== null ? 'data-done' : ''} style="flex:1 1 0; min-width:48px; --shots:1;">
                    <div class="flex gap-1">${optBtn(true)}</div>
                    <div class="flex gap-1">${optBtn(false)}</div>
                    <div class="flex gap-1 text-xs font-bold text-orange-700 text-center"><div class="flex-1">${escapeHtml(optLabel)}</div></div>
                </div>`;
            })() : '';

            row.innerHTML = `<div class="flex justify-between items-center gap-2 px-1">
                <div class="flex items-center gap-1.5 min-w-0 flex-wrap">
                    <span class="text-sm font-black uppercase truncate max-w-[160px] tracking-tight">${escapeHtml(s.name)}</span>
                    ${isShooting ? '<span class="bg-orange-500 text-white text-[11px] px-1.5 py-0.5 rounded-full font-bold leading-none">Shooting</span>' : ''}
                    ${i === 0 && ROTATE ? '<span class="border border-slate-300 text-slate-600 text-[11px] px-1.5 py-0.5 rounded-full font-semibold leading-none">First up</span>' : ''}
                    ${shooterStandSelect}
                </div>
                <div class="text-xl font-black italic text-slate-900 flex-shrink-0">${count}<span class="text-slate-600 text-xs not-italic font-bold ml-0.5">/${possible}</span></div>
            </div>
            <div ${SCROLL_SCORE_ROWS ? `data-score-strip="${s.id}" class="score-strip scrollbar-hide flex flex-wrap gap-1 w-full"` : 'class="flex flex-wrap gap-1 w-full"'}>${gridHtml}${optionHtml}</div>`;
            sArea.appendChild(row);
        }
        if (SCROLL_SCORE_ROWS) positionScoreStrips(sArea, st, prevStripScroll);

        // Leaderboard
        const lbHeader = document.getElementById('lb-header');
        lbHeader.innerHTML = `<th class="p-2 border-b text-left w-14 text-slate-800">${ROUND_LABEL}</th>`;
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
            lbHeader.innerHTML += `<th class="p-1.5 border-b border-l border-slate-200 text-center align-bottom"><div class="break-words leading-tight min-w-[56px]">${sh.isStraight ? '&#128293;<br>' : ''}${escapeHtml(sh.name)}</div></th>`;
        });

        const lbBody = document.getElementById('lb-body'); lbBody.innerHTML = '';
        const completedDifficulties = state.stands.map(completedStandDifficulty).filter(Boolean);
        const hardId = completedDifficulties.slice().sort((a, b) => a.avg - b.avg)[0]?.id;

        state.stands.forEach((stand, idx) => {
            let row = `<td class="p-2 font-semibold border-b border-slate-200 text-slate-800 whitespace-nowrap">${stand.id}${stand.extraClay ? '+1' : ''} ${stand.id === hardId ? '&#10071;' : ''}</td>`;
            perf.forEach(sh => {
                const base = state.hits[sh.id]?.[stand.id]?.filter(h => h === true).length || 0;
                const opt = getOptionHitForStand(sh.id, stand.id) === true ? 1 : 0;
                row += `<td class="p-2 text-center border-b border-l border-slate-200 font-black text-sm">${base + opt}</td>`;
            });
            const tr = document.createElement('tr');
            tr.className = state.activeIdx === idx ? 'bg-orange-50' : '';
            tr.innerHTML = row;
            lbBody.appendChild(tr);
        });

        const f = document.getElementById('lb-footer');
        const scheduledClays = scheduledRoundTargets() + (OPTION ? 1 : 0);
        let fRow = `<tr class="bg-slate-600 text-white font-black"><td class="p-2 text-xs">Total<br><span class="text-[11px] text-slate-100 font-semibold">of ${scheduledClays}</span></td>`;
        perf.forEach(sh => {
            const pctHtml = sh.pct === null ? '' : `<div class="text-xs text-slate-100 font-semibold leading-none mt-0.5">${sh.pct}%</div>`;
            fRow += `<td class="p-2 text-center text-lg border-l border-slate-500">${sh.t}${pctHtml}</td>`;
        });
        f.innerHTML = fRow + '</tr>';

        document.getElementById('nav-prev').disabled = state.isLocked || state.activeIdx === 0;
        document.getElementById('nav-next').disabled = state.isLocked || state.activeIdx === state.stands.length - 1;

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
        // The stand nav sticks just under the header. Observe rather than measure once: the Tailwind
        // CDN styles the header after this runs, so its first measured height is unstyled.
        const header = document.getElementById('app-header');
        const syncHeaderHeight = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
        syncHeaderHeight();
        if (window.ResizeObserver) new ResizeObserver(syncHeaderHeight).observe(header);
        else window.addEventListener('resize', syncHeaderHeight);
        // Only show the offline pill when there's actually no connection — scoring works either way.
        const syncOnlineStatus = () => {
            const el = document.getElementById('offline-status');
            if (!el) return;
            el.classList.toggle('hidden', navigator.onLine);
            el.classList.toggle('inline-flex', !navigator.onLine);
        };
        syncOnlineStatus();
        window.addEventListener('online', syncOnlineStatus);
        window.addEventListener('offline', syncOnlineStatus);
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
