import {spawn} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {chromium} from '@playwright/test';

const OUT = '/tmp/app-audit';
mkdirSync(OUT, {recursive: true});

const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', '4178', '--host', '127.0.0.1'], {
  cwd: '/Users/sexyboy/Desktop/autoservices',
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server timeout')), 30000);
  const onData = (chunk) => {
    if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(); }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('error', reject);
});
const results = {};
try {
  const browser = await chromium.launch();
  for (const tenant of ['graphite-detailing', 'ceramica-garage']) {
    results[tenant] = {};
    for (const width of [320, 375, 390, 430, 1440]) {
      const height = width < 768 ? 844 : 900;
      const page = await browser.newPage({viewport: {width, height}});
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:4178/s/${tenant}/`, {waitUntil: 'networkidle'});
      await page.locator('.sf-hero-cta').waitFor({timeout: 15000});
      await page.waitForTimeout(400);
      await page.screenshot({path: `${OUT}/${tenant}-${width}-home.png`});
      const home = await page.evaluate(() => ({
        heroH: Math.round(document.querySelector('.sf-hero-media')?.getBoundingClientRect().height ?? 0),
        stats: document.querySelectorAll('.sf-stat').length,
        entries: document.querySelectorAll('.sf-entry-row').length,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      // entry block -> catalog
      await page.locator('.sf-entry-row').click();
      await page.locator('.svc-row').first().waitFor({timeout: 15000});
      const catalog = await page.evaluate(() => ({
        url: location.pathname + location.search,
        rows: document.querySelectorAll('.svc-row').length,
        firstRow: document.querySelector('.svc-row')?.getAttribute('aria-label'),
        activeNav: document.querySelector(".mobile-nav-link[aria-current]")?.textContent?.trim() ?? null,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      }));
      await page.screenshot({path: `${OUT}/${tenant}-${width}-catalog.png`});
      // bottom nav -> same catalog
      await page.goto(`http://127.0.0.1:4178/s/${tenant}/`, {waitUntil: 'networkidle'});
      await page.locator('.sf-hero-cta').waitFor({timeout: 15000});
      if (width < 768) {
        await page.getByRole('navigation', {name: 'Нижняя навигация'}).getByText('Услуги').click();
        await page.locator('.svc-row').first().waitFor({timeout: 15000});
      }
      const viaNav = await page.evaluate(() => ({url: location.pathname + location.search}));
      // catalog row -> booking preselect (no submission)
      await page.locator('.svc-row').nth(1).click();
      await page.getByText('Дата и время').waitFor({timeout: 15000});
      const booking = await page.evaluate(() => ({
        url: location.pathname + location.search,
        sheet: Boolean(document.querySelector('.booking-bottom-sheet')),
        sheetH: Math.round(document.querySelector('.booking-bottom-sheet')?.getBoundingClientRect().height ?? 0),
        summary: document.querySelector('.booking-schedule-service strong')?.textContent?.trim() ?? null,
      }));
      await page.screenshot({path: `${OUT}/${tenant}-${width}-booking.png`});
      results[tenant][width] = {errors, home, catalog, viaNav, booking};
      await page.close();
    }
  }
  await browser.close();
} finally {
  server.kill();
}
console.log(JSON.stringify(results, null, 2));
