import {expect, test} from '@playwright/test';

test('client can complete an appointment from a phone or desktop browser', async ({page}) => {
  await page.goto('/s/graphite-detailing/');
  await expect(page.getByRole('heading', {name: 'Запись в студию'})).toHaveCount(0);
  await expect(page.getByRole('heading', {name: 'Услуги и стоимость'})).toBeVisible();

  if (page.viewportSize()!.width < 700) {
    await expect(page.getByRole('navigation', {name: 'Нижняя навигация'})).toBeVisible();
    await expect(page.getByRole('navigation', {name: 'Нижняя навигация'}).getByText('Главная')).toBeVisible();
  }

  await page.getByRole('link', {name: 'Записаться в студию'}).click();
  await expect(page.getByRole('heading', {name: 'Запись в студию'})).toBeVisible();

  const days = page.locator('.choice-chip');
  const availableSlots = page.locator('.time-chip:not(:disabled)');
  let foundDate = false;
  let selectedDate = '';
  for (let index = 0; index < await days.count(); index += 1) {
    await days.nth(index).click();
    try {
      await expect(availableSlots.first()).toBeVisible({timeout: 1_000});
      foundDate = true;
      selectedDate = (await days.nth(index).getAttribute('data-date')) ?? '';
      break;
    } catch {
      continue;
    }
  }
  expect(foundDate).toBe(true);
  await availableSlots.first().click();
  await page.getByLabel('Ваше имя').fill('Александр Петров');
  await page.getByLabel('Телефон').fill('+7 900 000-00-00');
  await page.getByLabel('Автомобиль').fill('Volvo XC60');
  await page.getByRole('button', {name: 'Подтвердить запись'}).click();

  await expect(page.getByRole('heading', {name: 'Вы записаны'})).toBeVisible();
  await expect(page.getByText('Александр Петров')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Добавить в календарь'})).toBeVisible();

  await page.goto('/s/graphite-detailing/owner/');
  await expect(page.getByRole('heading', {name: 'Расписание'})).toBeVisible();
  await page.getByLabel('Дата расписания').fill(selectedDate);
  await expect(page.getByText('Александр Петров · Volvo XC60')).toBeVisible();
});

test('assistant answers from the selected studio services', async ({page}) => {
  await page.goto('/s/graphite-detailing/');
  await page.getByRole('button', {name: 'Задать вопрос студии'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', {name: 'Сколько стоит полировка?'}).click();
  await expect(page.getByText(/Полировка кузова:/)).toBeVisible();
});

test('owner demo calendar is available at both responsive sizes', async ({page}) => {
  await page.goto('/s/graphite-detailing/owner/');
  await expect(page.getByRole('heading', {name: 'Расписание'})).toBeVisible();
  await expect(page.getByText('Демо · изменения и оплаты хранятся только в этом браузере')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Неделя'})).toBeVisible();
});
