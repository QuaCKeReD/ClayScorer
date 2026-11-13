/* Builds the phone screenshots used by docs/USER_GUIDE.md (docs/guide/*.png).
 * Drives a throwaway app container (see generate-docs.sh) with fictitious sample data,
 * emulating an iPhone 13. Regenerate whenever the UI shown in the guide changes.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');

const B = process.env.BASE_URL || 'http://cstest-app:8080';
const OUT = process.env.OUT_DIR || '/out/guide';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'examples';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'examples-not-used';
fs.mkdirSync(OUT, { recursive: true });

const SQUAD = [
  { name: 'J. Carter', cpsa: '104233', class: 'AA' },
  { name: 'S. Patel', cpsa: '118902', class: 'A' },
  { name: 'R. Hughes', cpsa: '097751', class: 'B' },
];

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  // Answer "OK" to the app's confirm() prompts (e.g. "Start a new round?").
  p.on('dialog', d => d.accept());
  // Scroll so `sel` sits just below the sticky header + stand bar.
  const scrollTo = (sel, offset = 140) => p.evaluate(({ sel, offset }) => {
    const e = document.querySelector(sel); window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - offset);
  }, { sel, offset });
  const shot = async (name, opts = {}) => { await p.waitForTimeout(250); await p.screenshot({ path: `${OUT}/${name}.png`, ...opts }); console.log('  ', name); };
  const el = async (sel, name) => { await p.waitForTimeout(250); await p.locator(sel).first().screenshot({ path: `${OUT}/${name}.png` }); console.log('  ', name); };
  const fresh = async (page) => { await p.goto(`${B}/${page}`); await p.evaluate(() => localStorage.clear()); await p.reload(); await p.waitForTimeout(900); };
  const fillRound = (ground, event, date) => p.evaluate(({ ground, event, date, SQUAD }) => {
    commitField('ground', ground); commitField('event', event); commitField('date', date);
    const st = () => JSON.parse(localStorage.getItem(window.DISCIPLINE.storageKey));
    while (st().shooters.length < SQUAD.length) addShooter();
    SQUAD.forEach((s, i) => { updateShooter(i, 'name', s.name); updateShooter(i, 'cpsa', s.cpsa); updateShooter(i, 'class', s.class); });
  }, { ground, event, date, SQUAD });
  const scoreStand = (standId, patterns) => p.evaluate(({ standId, patterns }) => {
    const sh = JSON.parse(localStorage.getItem(window.DISCIPLINE.storageKey)).shooters;
    patterns.forEach((pat, k) => { [...pat].forEach((c, i) => { if (c !== '.') toggleHit(sh[k].id, standId, i, c === 'H'); }); });
  }, { standId, patterns });

  // 1. Landing page
  await fresh('index.html');
  await shot('home');

  // 2. Round setup (English Sporting)
  await fresh('sporting.html');
  await fillRound('Example Shooting Ground', 'Club Sporting', '2026-11-08');
  await p.evaluate(() => { document.getElementById('setup-panel').open = true; window.scrollTo(0, 0); });
  await shot('setup');

  // 3. Scoring a stand: pairs, +1, Shooting / First up
  await p.evaluate(() => { setExtraClay(); });
  await scoreStand(1, ['HHMHHHM', 'HM.', '']);
  await p.evaluate(() => { document.getElementById('clay-meta-panel').open = false; });
  await scrollTo('#scoring-controls', 130);
  await shot('scoring');

  // 4. Clay presentation section + dialog
  await p.evaluate(() => {
    document.getElementById('clay-meta-panel').open = true;
    toggleClayMeta(0, 'presentation', 'Crosser'); toggleClayMeta(0, 'direction', 'LR'); toggleClayMeta(0, 'distance', '20-30'); toggleClayMeta(0, 'clayFace', 'Belly');
    toggleClayMeta(1, 'presentation', 'Teal'); toggleClayMeta(1, 'direction', 'Away'); toggleClayMeta(1, 'travelling', 'Up');
  });
  await scrollTo('#scoring-card', 130);
  await shot('clay-presentation');
  await p.locator('[data-clay-meta-control][data-clay-idx="0"] summary').click();
  await shot('clay-dialog');
  await p.evaluate(() => closeClayMeta());

  // 5. History (needs a couple of named rounds)
  await p.evaluate(() => { newRound(); });
  await p.waitForTimeout(300);
  await fillRound('Another Ground', 'Winter League', '2026-10-25');
  await scoreStand(1, ['HHMHHH', 'HHHHMM', 'MHHHHH']);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.locator('#history-menu-btn').click();
  await shot('history');
  await p.evaluate(() => closeHeaderMenus());

  // 6. Export menu + in-app scorecard
  await p.locator('#export-menu-btn').click();
  await shot('export-menu');
  await p.locator('button:has-text("Show scorecard")').click();
  await p.waitForSelector('#scorecard-viewer-body img', { timeout: 20000 });
  await shot('scorecard-viewer');
  await p.evaluate(() => closeScorecard());

  // 7. Locked round
  await p.evaluate(() => { toggleLock(); });
  await scrollTo('#lock-banner', 130);
  await shot('locked');
  await p.evaluate(() => { toggleLock(); });

  // 8. Sportrap: rounds, stand per shooter, presentations panel
  await fresh('sportrap.html');
  await fillRound('Example Shooting Ground', 'Club Sportrap', '2026-11-08');
  await p.evaluate(() => {
    toggleClayMeta(0, 'presentation', 'Crosser'); toggleClayMeta(0, 'direction', 'RL');
    toggleClayMeta(1, 'presentation', 'Rabbit'); toggleClayMeta(1, 'direction', 'LR');
    [1, 2, 3, 4, 5].forEach((v, i) => updateStandShotPresentation(1, i, v));
  });
  await scoreStand(1, ['HHM..', 'H....', '']);
  await scrollTo('#scoring-card', 130);
  await shot('sportrap');
  // The Presentations panel auto-collapses once scoring starts; open it for its own shot.
  await p.evaluate(() => { document.getElementById('presentation-panel').open = true; });
  await scrollTo('#presentation-panel', 130);
  await shot('sportrap-presentations');
  await p.evaluate(() => { document.getElementById('setup-panel').open = true; const d = document.querySelector('#setup-panel details'); if (d) d.open = true; });
  await scrollTo('#setup-panel details', 80);
  await shot('stand-setup');

  // 9. English Skeet: labels + option target
  await fresh('skeet.html');
  await fillRound('Example Shooting Ground', 'Skeet Monthly', '2026-11-08');
  await scoreStand(1, ['HM.', 'HH', '']);
  await scrollTo('#option-status', 130);
  await shot('skeet');

  // 10. Sign-in panel (signed out)
  await fresh('sporting.html');
  await p.locator('#cloud-menu-btn').click();
  await shot('sign-in');
  await p.evaluate(() => closeHeaderMenus());

  // 11. Account & users page (signed in as the throwaway admin)
  await p.evaluate(async ({ u, pw }) => {
    await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-ClayScorer': '1' }, body: JSON.stringify({ username: u, password: pw }) });
  }, { u: ADMIN_USER, pw: ADMIN_PASS });
  await p.goto(`${B}/users.html`); await p.waitForTimeout(1200);
  await shot('account', { fullPage: true });

  console.log('screenshots done, errors:', JSON.stringify(errs));
  await b.close();
})();
