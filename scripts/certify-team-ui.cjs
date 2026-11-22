// Drives the "Équipe IA" view in Chromium (no direct API call for the mission itself).
// Usage: NODE_PATH=$(npm root -g) node scripts/certify-team-ui.cjs <step> [dir]
// steps: register | create | approve-mission | approve-architecture | approve-completion | wait-review (completion pending) | screenshot
// Expects <dir>/occ.log (connector log with the pairing URL), <dir>/repo, <dir>/objective.txt, <dir>/acceptance.test.js.
const { chromium } = require('playwright');
const fs = require('fs');
const step = process.argv[2];
const dir = process.argv[3] || '/tmp/cert';
const run = process.env.CORTEX_TEAM_RUN || `${dir}/run`;
(async () => {
  const url = fs.readFileSync(`${run}/occ.log`, 'utf8').match(/(http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+)/)[1];
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1500 }, deviceScaleFactor: 1 });
  const problems = []; page.on('pageerror', (e) => problems.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  await page.goto(url); await page.waitForSelector('.rail');
  const confirm = async () => { await page.getByRole('button', { name: 'Confirmer cette action' }).click(); };
  const openTeam = async () => {
    await page.locator('select[aria-label="Projet actif"]').selectOption({ label: 'cert-target' });
    await page.getByRole('button', { name: 'Équipe IA' }).first().click();
    await page.waitForSelector('text=CTO IA · agent superviseur');
  };
  const openMission = async () => { await page.locator('.memory-item').first().click(); await page.waitForSelector('.team-detail'); };
  if (step === 'open-project') {
    await page.getByRole('button', { name: 'Projets' }).first().click();
    await page.waitForTimeout(500);
    const text = await page.locator('main').innerText(); console.log(text.slice(0, 200).replace(/\n/g, ' | '));
  }
  if (step === 'register') { await openTeam(); await page.getByRole('button', { name: /Enregistrer le CTO IA/ }).click(); await confirm(); await page.waitForSelector('text=ENREGISTRÉ'); console.log('registered via UI'); }
  if (step === 'create') {
    await openTeam();
    await page.getByLabel(/Dépôt \(propriétaire\/nom\)/).fill('AiWorkPay-SASU/cert-target');
    await page.getByLabel('Objectif').fill(fs.readFileSync(`${dir}/objective.txt`, 'utf8').trim());
    await page.getByLabel(/Périmètre autorisé/).fill('src test');
    await page.getByLabel(/Budget plafond/).fill(process.env.BUDGET || '2.5');
    await page.getByLabel('Contenu des tests d\'acceptation').fill(fs.readFileSync(`${dir}/acceptance.test.js`, 'utf8'));
    await page.getByRole('button', { name: /Transmettre au CTO IA/ }).click(); await confirm();
    await page.waitForSelector('.team-detail', { timeout: 20000 }); console.log('mission created via UI');
  }
  if (['approve-mission', 'approve-architecture', 'approve-completion'].includes(step)) {
    await openTeam(); await openMission();
    const label = { 'approve-mission': 'Lancement de la mission', 'approve-architecture': 'Plan de l’architecte', 'approve-completion': 'Livraison finale' }[step];
    await page.waitForSelector(`text=${label}`, { timeout: 20000 });
    await page.locator('.permission-card').getByRole('button', { name: 'Approuver' }).click(); await confirm();
    await page.waitForTimeout(1500); console.log(`${label}: approved via UI`);
  }
  if (step === 'wait-review') {
    await openTeam(); await openMission();
    await page.waitForSelector('text=Livraison finale', { timeout: 20 * 60000 });
    console.log((await page.locator('.team-detail').innerText()).split('\n').filter((l) => /Coût|Tests du projet|REVIEW/.test(l)).join(' | '));
  }
  if (step === 'screenshot') {
    await openTeam(); await openMission(); await page.waitForTimeout(1500);
    await page.locator('.page-scroll').evaluate((n) => { n.style.height = 'auto'; n.style.overflow = 'visible'; const a = document.querySelector('.app'); a.style.height = 'auto'; a.style.overflow = 'visible'; });
    await page.screenshot({ path: process.argv[4] || `${dir}/team.png`, fullPage: true });
  }
  if (problems.length) console.log('BROWSER ERRORS', JSON.stringify(problems));
  await browser.close();
})().catch((e) => { console.error('FAIL', step, e.message.split('\n')[0]); process.exit(1); });
