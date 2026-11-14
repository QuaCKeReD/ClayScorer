/* ClayScorer — weather for a round (Round notes › Weather).
 *
 * Weather entries are stored with the round as state.weather = { place?, entries: [...] }
 * (only once something is added, so older rounds keep their shape for sync). Each entry is
 * { id, time 'HH:MM', conditions, tempC, windKmh, windDir, gustKmh, source 'auto'|'manual' }.
 *
 * "Get weather" uses Open-Meteo (free, no key, CORS-enabled): the forecast API for recent and
 * upcoming dates, the archive API for older ones, and its geocoding API to search for a place
 * by name. Location comes from the device (navigator.geolocation) or a place search. Units are
 * metric: °C and km/h. Talks to the scorer only through window.ClayScorerWeatherHost.
 */
(function () {
    'use strict';

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const CONDITIONS = ['Sunny', 'Clear', 'Mainly clear', 'Partly cloudy', 'Overcast', 'Fog', 'Drizzle', 'Light rain', 'Rain', 'Heavy rain', 'Showers', 'Sleet', 'Snow', 'Thunderstorm'];
    const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

    // WMO weather codes (as returned by Open-Meteo) → the conditions list above.
    function conditionsFromCode(code, isDay = 1) {
        if (code === 0) return isDay === 0 ? 'Clear' : 'Sunny';
        if (code === 1) return 'Mainly clear';
        if (code === 2) return 'Partly cloudy';
        if (code === 3) return 'Overcast';
        if (code === 45 || code === 48) return 'Fog';
        if ([51, 53, 55].includes(code)) return 'Drizzle';
        if ([56, 57, 66, 67].includes(code)) return 'Sleet';
        if (code === 61) return 'Light rain';
        if (code === 63) return 'Rain';
        if (code === 65) return 'Heavy rain';
        if ([80, 81, 82].includes(code)) return 'Showers';
        if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
        if ([95, 96, 99].includes(code)) return 'Thunderstorm';
        return '';
    }
    const compass = (deg) => (Number.isFinite(deg) ? COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16] : '');
    const round = (v) => (Number.isFinite(v) ? Math.round(v) : null);

    // "10:30 · Partly cloudy · 12 °C · wind 18 km/h SW, gusts 30 km/h"
    function describe(e) {
        const parts = [];
        if (e.time) parts.push(e.time);
        if (e.conditions) parts.push(e.conditions);
        if (Number.isFinite(e.tempC)) parts.push(`${e.tempC} °C`);
        let wind = '';
        if (Number.isFinite(e.windKmh)) wind = `wind ${e.windKmh} km/h${e.windDir ? ` ${e.windDir}` : ''}`;
        else if (e.windDir) wind = `wind from ${e.windDir}`;
        if (Number.isFinite(e.gustKmh)) wind += `${wind ? ', ' : 'wind '}gusts ${e.gustKmh} km/h`;
        if (wind) parts.push(wind);
        return parts.join(' · ');
    }
    const sortedEntries = (w) => (w?.entries || []).slice().sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
    // One line for print/CSV/presentation, e.g. "Wergs — 10:30 · Sunny · 12 °C … | 14:00 · …"
    function summary(w) {
        const list = sortedEntries(w);
        if (!list.length) return '';
        return `${w.place?.name ? `${w.place.name} — ` : ''}${list.map(describe).join(' | ')}`;
    }

    // ---------------------------------------------------------------- Open-Meteo

    const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const daysBetween = (a, b) => Math.round((new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / 86400000);

    async function getJson(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Weather service error (${res.status})`);
        return res.json();
    }

    async function searchPlaces(name) {
        const q = String(name || '').trim();
        if (!q) return [];
        const data = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`);
        return (data.results || []).map(r => ({
            name: [r.name, r.admin2 || r.admin1, r.country_code].filter(Boolean).join(', '),
            lat: r.latitude, lon: r.longitude
        }));
    }

    // Weather at a place on a date (YYYY-MM-DD) and local time (HH:MM). Recent and upcoming
    // dates use the forecast API (it also serves the last ~3 months); older ones the archive.
    async function fetchWeather(place, date, time) {
        const day = date || todayIso();
        const age = daysBetween(todayIso(), day);
        if (age < -15) throw new Error('Weather is only available up to about two weeks ahead.');
        const vars = 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
        // Within ~45 minutes of now on today's date: use the live "current" conditions.
        const [th, tm] = String(time || '').split(':').map(Number);
        const now = new Date();
        if (age === 0 && Number.isFinite(th) && Math.abs((th * 60 + (tm || 0)) - (now.getHours() * 60 + now.getMinutes())) <= 45) {
            const cur = (await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat.toFixed(4)}&longitude=${place.lon.toFixed(4)}&current=${vars}&timezone=auto&wind_speed_unit=kmh`)).current;
            if (cur) return {
                conditions: conditionsFromCode(cur.weather_code, cur.is_day), tempC: round(cur.temperature_2m), windKmh: round(cur.wind_speed_10m),
                windDir: compass(cur.wind_direction_10m), gustKmh: round(cur.wind_gusts_10m), hour: String(cur.time || '').slice(11, 16) || 'now'
            };
        }
        const base = age > 85 ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
        const data = await getJson(`${base}?latitude=${place.lat.toFixed(4)}&longitude=${place.lon.toFixed(4)}&hourly=${vars}&start_date=${day}&end_date=${day}&timezone=auto&wind_speed_unit=kmh`);
        const h = data.hourly;
        if (!h || !h.time || !h.time.length) throw new Error('No weather found for that date.');
        const [hh, mm] = String(time || '12:00').split(':').map(Number);
        const want = Math.min(23, hh + (mm >= 30 ? 1 : 0));
        let idx = h.time.findIndex(t => Number(t.slice(11, 13)) === want);
        if (idx < 0) idx = 0;
        const code = h.weather_code?.[idx];
        const temp = round(h.temperature_2m?.[idx]);
        if (temp === null && code == null) throw new Error('No weather recorded for that time yet.');
        return {
            conditions: conditionsFromCode(code, h.is_day?.[idx]),
            tempC: temp,
            windKmh: round(h.wind_speed_10m?.[idx]),
            windDir: compass(h.wind_direction_10m?.[idx]),
            gustKmh: round(h.wind_gusts_10m?.[idx]),
            hour: h.time[idx].slice(11, 16)
        };
    }

    function myLocation() {
        return new Promise((resolve, reject) => {
            if (!window.isSecureContext) return reject(new Error('Your location can only be used when the app is opened over https. Search for a place instead.'));
            if (!navigator.geolocation) return reject(new Error('This device can’t share its location. Search for a place instead.'));
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ name: `My location (${pos.coords.latitude.toFixed(2)}, ${pos.coords.longitude.toFixed(2)})`, lat: pos.coords.latitude, lon: pos.coords.longitude }),
                (err) => reject(new Error(err.code === 1 ? 'Location permission was refused. Allow it in your browser settings, or search for a place instead.' : 'Couldn’t get your location. Search for a place instead.')),
                { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 }
            );
        });
    }

    // ---------------------------------------------------------------- notes section

    const host = () => window.ClayScorerWeatherHost;

    function sectionHtml(w) {
        const list = sortedEntries(w);
        return `<div class="flex items-center justify-between gap-2 mb-1.5">
                <div class="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1">Weather${w?.place?.name ? ` <span class="normal-case font-semibold text-slate-500 truncate">· ${esc(w.place.name)}</span>` : ''}</div>
                <button type="button" onclick="ClayWeather.open()" class="text-xs font-bold px-3 py-1.5 rounded-lg border bg-slate-900 text-white border-slate-900 flex-shrink-0">+ Add weather</button>
            </div>
            ${list.length ? `<ul class="space-y-1.5 mb-3">${list.map(e => `<li class="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-2 text-sm text-slate-800">
                    <span class="flex-1 min-w-0">${esc(describe(e))}</span>
                    <button type="button" onclick="ClayWeather.open('${esc(e.id)}')" class="text-xs font-bold px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-700 flex-shrink-0" aria-label="Edit weather at ${esc(e.time || '')}">Edit</button>
                </li>`).join('')}</ul>`
                : `<p class="text-xs text-slate-600 mb-3">No weather yet. Add it from your location, a place search, or by hand.</p>`}`;
    }

    // ---------------------------------------------------------------- dialog

    let draft = null;   // { id?, place, time, conditions, tempC, windKmh, windDir, gustKmh, source }

    const nowHHMM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const numOrNull = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? Math.round(n) : null; };

    function open(entryId) {
        const h = host();
        if (!h) return;
        const w = h.get() || {};
        const round_ = h.round();
        const existing = entryId ? (w.entries || []).find(e => e.id === entryId) : null;
        draft = existing
            ? { ...existing, place: w.place || null }
            : { time: round_.date === todayIso() || !round_.date ? nowHHMM() : '10:00', conditions: '', tempC: null, windKmh: null, windDir: '', gustKmh: null, source: 'manual', place: w.place || null };
        let el = document.getElementById('weather-dialog');
        if (!el) { el = document.createElement('div'); el.id = 'weather-dialog'; el.className = 'no-print'; document.body.appendChild(el); }
        render(round_.ground || round_.event || '');
    }

    function close() {
        document.getElementById('weather-dialog')?.remove();
        draft = null;
    }

    function field(label, inner) {
        return `<label class="block space-y-1"><span class="block text-xs font-semibold text-slate-800">${label}</span>${inner}</label>`;
    }
    const INPUT = 'block w-full h-11 bg-white border border-slate-400 rounded-lg px-2 text-sm font-semibold text-slate-900';

    function render(searchDefault) {
        const el = document.getElementById('weather-dialog');
        if (!el || !draft) return;
        const editing = !!draft.id;
        el.innerHTML = `<div class="fixed inset-0 z-[60] bg-slate-900/60" data-wx="close" aria-hidden="true"></div>
            <div role="dialog" aria-modal="true" aria-label="Weather" class="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] w-[min(32rem,calc(100vw-1rem))] max-h-[88vh] overflow-y-auto rounded-xl border-4 border-orange-500 ring-4 ring-white/80 bg-white shadow-2xl">
                <div class="sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-2 bg-slate-100 border-b border-slate-300">
                    <span class="text-xs font-bold uppercase tracking-wider text-slate-700">${editing ? 'Edit weather' : 'Add weather'}</span>
                    <button type="button" data-wx="close" class="text-xs font-bold px-3 py-1.5 rounded-lg border bg-white text-slate-800 border-slate-300">Cancel</button>
                </div>
                <div class="p-3 space-y-3">
                    <div class="rounded-xl border border-slate-300 bg-slate-50 p-2.5 space-y-2">
                        <div class="text-xs font-semibold text-slate-800">Location</div>
                        <div class="text-sm font-semibold text-slate-900" data-wx-place>${draft.place ? esc(draft.place.name) : '<span class="text-slate-500 font-normal">Not set — only needed for “Get weather”</span>'}</div>
                        <div class="flex gap-2 flex-wrap">
                            <button type="button" data-wx="locate" class="text-xs font-bold px-3 py-2 rounded-lg border bg-white text-slate-800 border-slate-400">📍 Use my location</button>
                        </div>
                        <div class="flex gap-2">
                            <input type="search" data-wx-q value="${esc(searchDefault)}" placeholder="Search a place, e.g. town or ground" aria-label="Search a place" class="${INPUT} !h-10 flex-1 min-w-0">
                            <button type="button" data-wx="search" class="text-xs font-bold px-3 rounded-lg border bg-white text-slate-800 border-slate-400 flex-shrink-0">Search</button>
                        </div>
                        <div data-wx-results class="space-y-1"></div>
                    </div>
                    <div class="flex gap-2 items-end">
                        <div class="flex-1">${field('Time', `<input type="time" data-wx-f="time" value="${esc(draft.time || '')}" class="${INPUT}">`)}</div>
                        <button type="button" data-wx="fetch" class="h-11 px-3 rounded-lg bg-orange-500 text-white text-sm font-bold flex-shrink-0 disabled:opacity-50" ${draft.place ? '' : 'disabled'}>Get weather</button>
                    </div>
                    <div data-wx-status class="text-xs text-slate-600 min-h-[1rem]"></div>
                    ${field('Conditions', `<select data-wx-f="conditions" class="${INPUT}"><option value="">—</option>${CONDITIONS.map(c => `<option ${draft.conditions === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
                    <div class="grid grid-cols-2 gap-2">
                        ${field('Temperature (°C)', `<input type="number" inputmode="decimal" step="1" data-wx-f="tempC" value="${draft.tempC ?? ''}" class="${INPUT}">`)}
                        ${field('Wind (km/h)', `<input type="number" inputmode="numeric" step="1" min="0" data-wx-f="windKmh" value="${draft.windKmh ?? ''}" class="${INPUT}">`)}
                        ${field('Wind from', `<select data-wx-f="windDir" class="${INPUT}"><option value="">—</option>${COMPASS.map(c => `<option ${draft.windDir === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`)}
                        ${field('Gusts (km/h, optional)', `<input type="number" inputmode="numeric" step="1" min="0" data-wx-f="gustKmh" value="${draft.gustKmh ?? ''}" class="${INPUT}">`)}
                    </div>
                    <div class="flex gap-2 justify-between pt-1">
                        ${editing ? `<button type="button" data-wx="delete" class="text-sm font-bold px-3 py-2 rounded-lg border border-red-300 text-red-700 bg-white">Delete</button>` : '<span></span>'}
                        <button type="button" data-wx="save" class="text-sm font-bold px-4 py-2 rounded-lg bg-slate-900 text-white">Save</button>
                    </div>
                    <p class="text-[11px] text-slate-500">Weather data from Open-Meteo.com. Your location is only sent to look up the weather.</p>
                </div>
            </div>`;
        el.onclick = onClick;
        el.onchange = onChange;
        el.querySelector('[data-wx-q]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    }

    const status = (msg, tone = '') => {
        const s = document.querySelector('#weather-dialog [data-wx-status]');
        if (s) { s.textContent = msg; s.className = `text-xs min-h-[1rem] ${tone === 'error' ? 'text-red-700 font-semibold' : 'text-slate-600'}`; }
    };
    function setPlace(place) {
        draft.place = place;
        const el = document.querySelector('#weather-dialog [data-wx-place]');
        if (el) el.textContent = place.name;
        const btn = document.querySelector('#weather-dialog [data-wx="fetch"]');
        if (btn) btn.disabled = false;
        const res = document.querySelector('#weather-dialog [data-wx-results]');
        if (res) res.innerHTML = '';
    }

    function onChange(e) {
        const f = e.target.dataset.wxF;
        if (!f || !draft) return;
        const v = e.target.value;
        draft[f] = ['tempC', 'windKmh', 'gustKmh'].includes(f) ? numOrNull(v) : v;
        draft.source = 'manual';
    }

    async function doSearch() {
        const q = document.querySelector('#weather-dialog [data-wx-q]')?.value;
        const res = document.querySelector('#weather-dialog [data-wx-results]');
        if (!res) return;
        res.innerHTML = '<div class="text-xs text-slate-600">Searching…</div>';
        try {
            const places = await searchPlaces(q);
            res.innerHTML = places.length
                ? places.map((p, i) => `<button type="button" data-wx="pick" data-i="${i}" class="block w-full text-left text-sm px-2.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-orange-50">${esc(p.name)}</button>`).join('')
                : '<div class="text-xs text-slate-600">No places found. Try a nearby town.</div>';
            res._places = places;
        } catch (err) {
            res.innerHTML = `<div class="text-xs text-red-700 font-semibold">${esc(navigator.onLine ? err.message : 'You’re offline — enter the weather by hand.')}</div>`;
        }
    }

    async function onClick(e) {
        const btn = e.target.closest('[data-wx]');
        if (!btn || !draft) return;
        const act = btn.dataset.wx;
        if (act === 'close') return close();
        if (act === 'search') return doSearch();
        if (act === 'pick') {
            const places = document.querySelector('#weather-dialog [data-wx-results]')._places || [];
            const p = places[Number(btn.dataset.i)];
            if (p) setPlace(p);
            return;
        }
        if (act === 'locate') {
            status('Finding your location…');
            try { setPlace(await myLocation()); status(''); }
            catch (err) { status(err.message, 'error'); }
            return;
        }
        if (act === 'fetch') {
            if (!draft.place) return status('Set a location first.', 'error');
            const time = document.querySelector('#weather-dialog [data-wx-f="time"]').value || draft.time;
            draft.time = time;
            btn.disabled = true;
            status('Getting the weather…');
            try {
                const wx = await fetchWeather(draft.place, host().round().date, time);
                Object.assign(draft, { conditions: wx.conditions, tempC: wx.tempC, windKmh: wx.windKmh, windDir: wx.windDir, gustKmh: wx.gustKmh, source: 'auto' });
                const set = (f, v) => { const i = document.querySelector(`#weather-dialog [data-wx-f="${f}"]`); if (i) i.value = v ?? ''; };
                set('conditions', wx.conditions); set('tempC', wx.tempC); set('windKmh', wx.windKmh); set('windDir', wx.windDir); set('gustKmh', wx.gustKmh);
                status(`Weather for ${wx.hour} at ${draft.place.name}. Check it and press Save.`);
            } catch (err) {
                status(navigator.onLine ? err.message : 'You’re offline — enter the weather by hand.', 'error');
            } finally { btn.disabled = false; }
            return;
        }
        if (act === 'delete') {
            if (!confirm('Delete this weather entry?')) return;
            const w = host().get() || {};
            const entries = (w.entries || []).filter(x => x.id !== draft.id);
            host().set(entries.length || w.place ? { ...w, entries } : null);
            return close();
        }
        if (act === 'save') {
            const time = document.querySelector('#weather-dialog [data-wx-f="time"]').value || draft.time || '';
            const entry = {
                id: draft.id || `w${Date.now().toString(36)}`,
                time, conditions: draft.conditions || '',
                tempC: draft.tempC ?? null, windKmh: draft.windKmh ?? null, windDir: draft.windDir || '', gustKmh: draft.gustKmh ?? null,
                source: draft.source || 'manual'
            };
            if (!entry.conditions && entry.tempC === null && entry.windKmh === null && !entry.windDir) return status('Enter some weather, or press Get weather.', 'error');
            const w = host().get() || {};
            const entries = (w.entries || []).filter(x => x.id !== entry.id).concat(entry);
            const next = { entries };
            if (draft.place) next.place = { name: draft.place.name, lat: draft.place.lat, lon: draft.place.lon };
            host().set(next);
            return close();
        }
    }

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && draft) close(); });

    window.ClayWeather = { open, close, sectionHtml, describe, summary, searchPlaces, fetchWeather, conditionsFromCode, CONDITIONS };
})();
