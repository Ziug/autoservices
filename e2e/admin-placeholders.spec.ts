import {expect, test} from '@playwright/test';

// The starter template and PWA fallback reference these same-origin assets;
// a missing file here would silently reintroduce empty-image / hotlink bugs.
const PLACEHOLDERS = [
  '/placeholders/detailing-hero.svg',
  '/placeholders/detailing-logo.svg',
  '/placeholders/detailing-work-1.svg',
  '/placeholders/detailing-work-2.svg',
  '/placeholders/detailing-work-3.svg',
];

for (const path of PLACEHOLDERS) {
  test(`placeholder asset resolves: ${path}`, async ({request}) => {
    const response = await request.get(path);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type'] ?? '').toContain('svg');
    const body = await response.text();
    expect(body).toContain('<svg');
    // No external image hotlinks (the xmlns namespace declaration is fine).
    expect(body).not.toMatch(/(href|xlink:href|src)=["']https?:\/\//);
  });
}
