# Локальный запуск и публикация

## Локальная демо-версия

Нужны Node.js 22.13 или новее и pnpm 11.

```sh
pnpm install
pnpm dev
```

Откройте `/s/graphite-detailing/` или `/s/ceramica-garage/`. Это отмеченные демо-студии: записи, оплаты и настройки остаются в хранилище браузера, реальные уведомления не отправляются. Для проверки service worker и установки PWA соберите production-версию и откройте её через `pnpm preview`.

## Локальная база и проверки

Для локальной базы нужен запущенный Docker Desktop.

```sh
pnpm supabase:start
pnpm supabase:reset
pnpm test:db
pnpm test:concurrency
```

`test:db` запускает pgTAP проверки схемы, бронирования, двух ресурсов, блокировок, переноса, многодневной занятости, платежей, RLS и outbox. `test:concurrency` создаёт временную студию и проверяет две одновременные заявки на один ресурс; локальный URL безопасен по умолчанию. Для удалённого Supabase потребуется отдельное явное разрешение `SUPABASE_INTEGRATION_ALLOW_MUTATIONS=true`; скрипт удаляет созданные им записи после проверки.

Проверки без Supabase:

```sh
pnpm typecheck
pnpm test
pnpm test:assistant-router
pnpm tenant:validate
pnpm build
pnpm test:e2e
```

## Подключение Supabase

1. Создайте проект Supabase и свяжите его с CLI:

   ```sh
   pnpm dlx supabase@latest login
   pnpm dlx supabase@latest link --project-ref <project-ref>
   pnpm dlx supabase@latest db push
   ```

2. Скопируйте `.env.example` в `.env.local`. Для браузера укажите `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` и, если нужен push, публичный VAPID-ключ. Для команд `tenant:publish`, `tenant:verify` и `tenant:activate` также задайте `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` и `PUBLIC_BASE_URL`; CLI читает эти локальные значения из `.env.local`.

3. В Supabase Edge Function Secrets задайте `APP_ANON_KEY` (publishable-ключ), `APP_SERVICE_ROLE_KEY` (secret-ключ), `BOOKING_TOKEN_SECRET`, `APP_PUBLIC_URL` и `APP_ALLOWED_ORIGINS`. Имена собственных секретов не должны начинаться с `SUPABASE_` — этот префикс зарезервирован платформой (`SUPABASE_URL` при этом доступен функциям автоматически). Для планировщика также задайте `NOTIFICATION_CRON_SECRET`. Ключ service role, секрет доступа к записи и ключ модели не должны иметь префикс `VITE_`.

4. Разверните функции:

   ```sh
   pnpm dlx supabase@latest functions deploy get-slots --no-verify-jwt
   pnpm dlx supabase@latest functions deploy book-appointment --no-verify-jwt
   pnpm dlx supabase@latest functions deploy appointment-access --no-verify-jwt
   pnpm dlx supabase@latest functions deploy cancel-appointment --no-verify-jwt
   pnpm dlx supabase@latest functions deploy push-subscribe --no-verify-jwt
   pnpm dlx supabase@latest functions deploy owner-api
   pnpm dlx supabase@latest functions deploy assistant --no-verify-jwt
   pnpm dlx supabase@latest functions deploy notification-dispatch --no-verify-jwt
   ```

   Функция владельца сохраняет JWT-проверку. Публичные функции проверяют origin, формат запроса и серверные лимиты; доступ владельца к tenant подтверждается членством на сервере.

5. Чтобы включить помощника с LLM, задайте `LLM_API_KEY`, `LLM_MODEL` и при необходимости `LLM_BASE_URL`. Настройте дневные лимиты вызовов, токенов и стоимости. Указанные ставки должны быть не ниже актуальной цены выбранной модели. Без ключа модель не вызывается; помощник отвечает детерминированно по проверенным данным.

6. Чтобы включить push, создайте VAPID-ключи (`pnpm dlx web-push generate-vapid-keys`), задайте VAPID secrets, а публичный ключ добавьте в `VITE_VAPID_PUBLIC_KEY`. Затем выполните SQL из `supabase/schedule-notifications.sql` в Supabase SQL Editor; файл создаёт расписание через pg_cron, pg_net и Vault.

7. Доступ владельца создайте в панели администратора (карточка студии → «Владельцы»): только логин и пароль, почта необязательна и нужна лишь для связи. Публичная регистрация выключена. Подробности — в документации развёртывания [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Новая студия

```sh
pnpm tenant:new north-studio
```

Измените `tenants/north-studio/business.json` и файлы в `tenants/north-studio/images/`, затем выполните `pnpm tenant:validate north-studio`. Все клиентские данные профиля находятся в этом JSON; расписание, записи и оплаты после публикации берутся из Supabase.

Для preview оставьте `demo: true`. Для настоящего бизнеса замените контакты и изображения, задайте `demo: false` и `status: "live"`. Синхронизируйте профиль в Supabase; новый профиль останется в безопасном статусе preview:

```sh
pnpm tenant:publish north-studio
```

После публикации сайта укажите `PUBLIC_BASE_URL` в `.env.local`, проверьте запись в Supabase и доступность готовой ссылки, затем активируйте профиль:

```sh
pnpm tenant:verify north-studio
pnpm tenant:activate north-studio
```

`tenant:activate` требует непустые настройки проекта, проверяет preview-профиль и опубликованные услуги/ресурсы, затем переводит студию в live. Повторная публикация существующей live-студии сохраняет её live-статус и загруженные владельцем фотографии.

## Публикация

### Vercel

Импортируйте проект в Vercel, добавьте `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` и публичный VAPID-ключ, если push включён. Команда сборки — `pnpm build`, папка вывода — `dist`. В проекте есть `vercel.json` с переходами SPA для `/s/<slug>/` и заголовками для worker, manifest и кабинета владельца.

### Cloudflare Pages

Команда сборки — `pnpm build`, папка вывода — `dist`. В `public/_redirects` и `public/_headers` настроены SPA fallback, область service worker и приватный кеш кабинета.

В `APP_PUBLIC_URL` и `APP_ALLOWED_ORIGINS` используйте опубликованный HTTPS-домен. После выкладки выполните шаги verify/activate выше. Установка standalone и показ системного диалога добавления проверяются на реальном устройстве; локальный браузер не подтверждает это поведение.
