import {spawn} from 'node:child_process';
import {chromium} from '@playwright/test';

const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', '4182', '--host', '127.0.0.1'], {
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
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  await page.goto('http://127.0.0.1:4182/s/graphite-detailing/owner/settings', {waitUntil: 'networkidle'});
  await page.getByRole('heading', {name: 'Настройки'}).waitFor({timeout: 15000});
  await page.waitForTimeout(500);
  await page.locator('#set-profile input[name="name"]').fill('Persistence Studio');
  console.log('save buttons:', await page.getByRole('button', {name: 'Сохранить данные студии'}).count());
  await page.getByRole('button', {name: 'Сохранить данные студии'}).click();
  await page.waitForTimeout(3000);
  console.log('status count:', await page.locator('#set-profile p[role="status"]').count());
  console.log('status text:', await page.locator('#set-profile p[role="status"]').first().textContent().catch(() => null));
  console.log('service value kept:', await page.locator('#set-services details.set-service input[name="name"]').first().inputValue());
  console.log('profile value:', await page.locator('#set-profile input[name="name"]').inputValue());
  console.log('stored profile:', (await page.evaluate(() => localStorage.getItem('autoservices-preview:graphite-detailing:settings')))?.slice(0, 120));
  await browser.close();
} finally {
  server.kill();
}
