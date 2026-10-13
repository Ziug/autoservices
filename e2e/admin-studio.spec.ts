import {expect, test} from '@playwright/test';

// Unauthenticated visits to the new studio-creation routes must hit the
// admin guard (redirect to login), never a public 404 or leaked content.
test('create-studio route is guarded by admin login', async ({page}) => {
  await page.goto('/control/admin/tenants/new');
  await expect(page.getByRole('heading', {name: 'Панель управления'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Войти'})).toBeVisible();
});

test('studio setup route is guarded by admin login', async ({page}) => {
  await page.goto('/control/admin/tenants/some-id/setup');
  await expect(page.getByRole('heading', {name: 'Панель управления'})).toBeVisible();
});
