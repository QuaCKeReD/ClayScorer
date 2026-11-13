/* Builds docs/example-outputs.pdf: one fully scored example round per discipline, exported
 * through the app's own "Share scorecard image" and "Print / save as PDF" paths, plus a cover.
 * Sample data is fictitious and deterministic. Regenerate whenever the export layout changes.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
// Run via docs/tools/generate-examples.sh, which starts a throwaway app container and a
// Playwright container on a private Docker network and passes these in.
const B = process.env.BASE_URL || 'http://cstest-app:8080';
const OUT = process.env.OUT_DIR || '/out/doc';
const GENERATED = new Date().toLocaleDateString('en-GB');

// Fictitious sample data, deterministic so the document is reproducible.
const SHOOTERS = [
  { name: 'J. Carter', cpsa: '104233', class: 'AA', rate: 0.88 },
  { name: 'S. Patel', cpsa: '118902', class: 'A', rate: 0.78 },
  { name: 'R. Hughes', cpsa: '097751', class: 'B', rate: 0.66 },
  { name: 'M. Evans', cpsa: '121468', class: 'C', rate: 0.55 },
];
const DISCIPLINES = [
  { id: 'sporting', name: 'English Sporting', code: 'ESP', event: 'Autumn Sporting 50',
    setup: { standTargets: [6, 6, 8, 6, 4, 6, 8, 6, 6, 4], extra: [4, 8] } },
  { id: 'sportrap', name: 'Sportrap', code: 'STR', event: 'Club Sportrap 25' },
  { id: 'compak', name: 'Compak Sporting', code: 'CSP', event: 'Compak Winter League' },
  { id: 'skeet', name: 'English Skeet', code: 'ESK', event: 'Skeet Monthly 25' },
];

const META_POOL = [
  { presentation: 'Crosser', direction: ['LR'], distance: '20-30', starting: 'Mid', travelling: 'Level', clayFace: 'Belly', clayVisibility: 'Full' },
  { presentation: 'Teal', direction: ['Away'], distance: '10-15', starting: 'Low', travelling: 'Up', clayFace: 'Edge' },
  { presentation: 'Driven', direction: ['Towards'], distance: '30+', starting: 'High', travelling: 'Down', clayFace: 'Top', clayVisibility: 'Part' },
  { presentation: 'Rabbit', direction: ['RL'], distance: '15-20', starting: 'Low', travelling: 'Level', claySize: 'Std110', clayFace: 'Edge' },
  { presentation: 'Looper', direction: ['LR', 'Away'], distance: '20-30', starting: 'Mid', travelling: 'Down', claySize: 'Midi90', clayFace: 'Belly', clayVisibility: 'Part' },
  { presentation: 'Battue', direction: ['RL'], distance: '15-20', starting: 'High', travelling: 'Down', claySize: 'Std110', clayFace: 'Edge' },
  { presentation: 'Quartering', direction: ['RL', 'Towards'], distance: '10-15', starting: 'Low', travelling: 'Up', clayFace: 'Belly' },
  { presentation: 'Crow', direction: ['Away'], distance: '30+', starting: 'High', travelling: 'Level', claySize: 'Mini70', colour: 'Black', clayFace: 'Top', clayVisibility: 'Full' },
  { presentation: 'Crosser', direction: ['RL'], distance: '5-10', starting: 'Low', travelling: 'Up', claySize: 'Mini70', colour: 'Pink', clayFace: 'Belly', clayVisibility: 'Full' },
];

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const results = [];

  for (const d of DISCIPLINES) {
    await p.goto(`${B}/${d.id}.html`); await p.waitForTimeout(800);
    await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(800);
    const summary = await p.evaluate(({ d, SHOOTERS, META_POOL }) => {
      let seed = d.id.length * 7919;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const KEY = window.DISCIPLINE.storageKey;
      const st = () => JSON.parse(localStorage.getItem(KEY));
      commitField('ground', 'Example Shooting Ground'); commitField('event', d.event); commitField('date', '2026-11-08');
      // Squad
      while (st().shooters.length < SHOOTERS.length) addShooter();
      SHOOTERS.forEach((s, i) => { updateShooter(i, 'name', s.name); updateShooter(i, 'cpsa', s.cpsa); updateShooter(i, 'class', s.class); });
      // ESP layout
      if (d.setup) {
        updateStandCount(d.setup.standTargets.length);
        const goTo = (i) => { while (st().activeIdx > i) nav(-1); while (st().activeIdx < i) nav(1); };
        d.setup.standTargets.forEach((t, i) => { goTo(i); setBirds(t); if (d.setup.extra.includes(i + 1)) setExtraClay(); });
        goTo(0);
      }
      // Presentations: describe every clay on every stand (disciplines that have them)
      const stands = st().stands;
      const goTo = (i) => { while (st().activeIdx > i) nav(-1); while (st().activeIdx < i) nav(1); };
      let described = 0;
      if (window.DISCIPLINE.enableStandDescriptions !== false) {
        stands.forEach((stand, si) => {
          goTo(si);
          const n = (st().stands[si].clayMeta || []).length;
          for (let c = 0; c < n; c++) {
            const m = META_POOL[(si * 3 + c * 5) % META_POOL.length];
            // First tap stores the defaults, then each field is set explicitly.
            toggleClayMeta(c, 'presentation', m.presentation);
            const cur = () => st().stands[si].clayMeta[c];
            (m.direction || []).forEach(v => { if (!cur().direction.includes(v)) toggleClayMeta(c, 'direction', v); });
            ['distance', 'starting', 'travelling', 'claySize', 'colour', 'clayFace', 'clayVisibility'].forEach(k => {
              if (m[k] && cur()[k] !== m[k]) toggleClayMeta(c, k, m[k]);
            });
            described++;
          }
        });
        goTo(0);
      }
      // Scores: every target for every shooter
      const shooters = st().shooters;
      st().stands.forEach(stand => {
        const total = stand.targets + (stand.extraClay ? 1 : 0);
        shooters.forEach((sh, k) => {
          for (let i = 0; i < total; i++) toggleHit(sh.id, stand.id, i, rnd() < SHOOTERS[k].rate);
        });
      });
      // Skeet option target: taken on the station of the first miss
      if (window.DISCIPLINE.optionTarget) {
        const s2 = st();
        shooters.forEach((sh, k) => {
          const stand = s2.stands.find(x => (s2.hits[sh.id]?.[x.id] || []).includes(false)) || s2.stands[s2.stands.length - 1];
          toggleOptionHit(sh.id, stand.id, rnd() < SHOOTERS[k].rate);
        });
      }
      updateField('notes', 'Example round generated to illustrate the PDF and image outputs. Names and ground are fictitious.');
      const fin = st();
      return { stands: fin.stands.length, targets: fin.stands.reduce((a, s) => a + s.targets + (s.extraClay ? 1 : 0), 0), described };
    }, { d, SHOOTERS, META_POOL });

    // PDF output
    await p.evaluate(() => { window.print = () => {}; exportToPDF(); });
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: `${OUT}/${d.id}-print.pdf`, format: 'A4', landscape: true, printBackground: true });
    await p.emulateMedia({ media: 'screen' });
    // Image output
    const pngs = [];
    const handler = async dl => { const f = `${OUT}/${dl.suggestedFilename()}`; await dl.saveAs(f); pngs.push(f); };
    p.on('download', handler);
    await p.evaluate(() => { navigator.share = undefined; return shareAsImage(); });
    await p.waitForTimeout(3000);
    p.off('download', handler);
    pngs.sort((a, b) => a.length - b.length);
    results.push({ ...d, summary, pngs });
    console.log(d.code, JSON.stringify(summary), pngs.map(f => f.split('/').pop()));
  }

  // Build the document: cover + per discipline (image page(s) + print PDF pages)
  const page = await ctx.newPage();
  const css = `<style>
    @page { size: A4 landscape; margin: 12mm; }
    body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; }
    h1 { font-size: 26pt; margin: 0 0 4mm; } h2 { font-size: 18pt; margin: 0 0 2mm; }
    .code { color: #ea580c; font-weight: 800; letter-spacing: 0.1em; font-size: 10pt; }
    .muted { color: #475569; } .small { font-size: 9.5pt; }
    table.toc { border-collapse: collapse; margin-top: 6mm; width: 100%; font-size: 11pt; }
    table.toc th, table.toc td { text-align: left; padding: 2.5mm 3mm; border-bottom: 0.5pt solid #cbd5e1; }
    table.toc th { background: #f1f5f9; }
    .legend { display: flex; gap: 6mm; align-items: center; margin-top: 6mm; font-size: 11pt; }
    .sw { display: inline-block; width: 10mm; height: 5mm; vertical-align: middle; margin-right: 2mm; border: 0.5pt solid #64748b; }
    figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
    figure.newpage { break-before: page; page-break-before: always; }
    img { display: block; max-width: 100%; max-height: 150mm; width: auto; height: auto; margin: 0 auto; border: 0.75pt solid #94a3b8; }
    figure.newpage img { max-height: 170mm; }
    .imgcap { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin: 4mm 0 1.5mm; }
    .bar { border-top: 3pt solid #f97316; margin: 3mm 0 4mm; }
  </style>`;
  const toPdf = async (html, path) => { await page.setContent(css + html, { waitUntil: 'load' }); await page.pdf({ path, format: 'A4', landscape: true, printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } }); };

  for (const r of results) r.printPages = (await PDFDocument.load(fs.readFileSync(`${OUT}/${r.id}-print.pdf`))).getPageCount();
  const rows = results.map(r => `<tr><td><span class="code">${r.code}</span> ${r.name}</td><td>${r.summary.stands} ${r.id === 'skeet' ? 'stations' : r.id === 'sporting' ? 'stands' : 'rounds'} · ${r.summary.targets}${r.id === 'skeet' ? ' + option' : ''} targets</td><td>${SHOOTERS.length}</td><td>${r.summary.described || '—'}</td><td>${r.pngs.length} image${r.pngs.length > 1 ? 's' : ''} + ${r.printPages}-page PDF</td></tr>`).join('');
  await toPdf(`<div class="code">CLAYSCORER PRO</div><h1>Example outputs — all disciplines</h1>
    <div class="bar"></div>
    <p>This document shows the two outputs the app produces for a completed round, for every discipline, using one fully scored example round each:</p>
    <ul>
      <li><strong>Scorecard image</strong> — what <em>Export › Share scorecard image</em> sends and <em>Export › Show scorecard</em> displays in the app. A second image lists the clay presentations when any are described.</li>
      <li><strong>Print / save as PDF</strong> — the scorecard page, followed by a separate presentations page when any clays are described.</li>
    </ul>
    <table class="toc"><tr><th>Discipline</th><th>Layout</th><th>Shooters</th><th>Clays described</th><th>Outputs shown</th></tr>${rows}</table>
    <div class="legend"><span><span class="sw" style="background:#4ade80"></span>Hit</span><span><span class="sw" style="background:#f87171"></span>Miss</span><span class="muted small">Scores are shown by colour only. Shooters are sorted by total.</span></div>
    <p class="muted small" style="margin-top:8mm">Sample data: shooter names, CPSA numbers, ground and events are fictitious. English Skeet has no clay presentations, so it has a single image and a single PDF page. Long presentation lists continue onto further PDF pages, as they would when printed from the app. Generated ${GENERATED}.</p>`, `${OUT}/00-cover.pdf`);

  const parts = [`${OUT}/00-cover.pdf`];
  for (const [i, r] of results.entries()) {
    const imgs = r.pngs.map((f, k) => `<figure class="${k ? 'newpage' : ''}"><div class="imgcap">${k === 0 ? 'Scorecard image' : `${r.name} — presentations image`} — ${f.split('/').pop()}</div><img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}"></figure>`).join('');
    const path = `${OUT}/${String(i + 1).padStart(2, '0')}-${r.id}-images.pdf`;
    await toPdf(`<div class="code">${r.code}</div><h2>${r.name} — scorecard image output</h2>
      <div class="muted small">Example Shooting Ground · ${r.event} · ${r.summary.stands} ${r.id === 'sporting' ? 'stands' : r.id === 'skeet' ? 'stations' : 'rounds'}, ${r.summary.targets} targets · ${SHOOTERS.length} shooters. The print / PDF output (${r.printPages} page${r.printPages > 1 ? 's' : ''}) follows.</div>
      <div class="bar"></div>${imgs}`, path);
    parts.push(path, `${OUT}/${r.id}-print.pdf`);
  }

  const merged = await PDFDocument.create();
  for (const f of parts) {
    const src = await PDFDocument.load(fs.readFileSync(f));
    (await merged.copyPages(src, src.getPageIndices())).forEach(pg => merged.addPage(pg));
  }
  merged.setTitle('ClayScorer Pro — example outputs, all disciplines');
  fs.writeFileSync(`${OUT}/clayscorer-example-outputs.pdf`, await merged.save());
  console.log('pages:', merged.getPageCount(), 'errors:', JSON.stringify(errs));
  await b.close();
})();
