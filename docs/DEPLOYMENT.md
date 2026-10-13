# Настройка Supabase и Vercel

## Локальный демонстрационный режим

`pnpm install && pnpm dev` запускает два демонстрационных профиля без внешних аккаунтов. Бронирования, оплаты и настройки демо остаются в `localStorage` этого браузера; это не рабочая база данных.

## Supabase

1. Создайте проект Supabase и скопируйте URL, anon key и service-role key. Service-role key нужен только серверным функциям и команде публикации — никогда не добавляйте его в переменные `VITE_*`.
2. Примените миграцию и seed через Supabase CLI:

   ```sh
   pnpm dlx supabase@latest login
   pnpm dlx supabase@latest link --project-ref <project-ref>
   pnpm dlx supabase@latest db push
   ```

   Для локальной базы Docker Desktop должен быть запущен: `pnpm supabase:start`, затем `pnpm supabase:reset`.

3. Скопируйте `.env.example` в `.env.local`, заполните `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`. Для панели администратора сгенерируйте `VITE_ADMIN_PATH` командой `node scripts/generate-admin-path.mjs` (значение вида `/control/<secret>`, в git не коммитить). При сборке Vercel добавьте те же frontend-переменные плюс `VITE_ADMIN_PATH`, а также `VITE_VAPID_PUBLIC_KEY`, если включаете web push.
4. Сгенерируйте два независимых случайных секрета длиной от 32 символов для `BOOKING_TOKEN_SECRET` и `NOTIFICATION_CRON_SECRET`. Добавьте в Supabase Edge Function Secrets `APP_ANON_KEY` (publishable-ключ), `APP_SERVICE_ROLE_KEY` (secret-ключ), `BOOKING_TOKEN_SECRET`, `APP_PUBLIC_URL`, `APP_ALLOWED_ORIGINS`. Имена собственных секретов не должны начинаться с `SUPABASE_` — префикс зарезервирован (`SUPABASE_URL` доступен функциям автоматически). Отправляйте запросы только с доменов из `APP_ALLOWED_ORIGINS`.
5. Необязательный помощник принимает OpenAI-совместимый `LLM_API_KEY`, `LLM_MODEL` и, при необходимости, `LLM_BASE_URL`. Для ограничения трат задайте `LLM_DAILY_COST_LIMIT_MICRO_USD` (микродоллары США на одну студию за локальный день), дневной предел вызовов/токенов и стоимость за 1000 входных/выходных токенов. Встроенные значения по умолчанию: $5 на студию в день, 40 вызовов, 300 000 токенов и консервативная оценка $0.02/$0.08 за 1000 токенов. Ставки должны быть не ниже действующей цены выбранной модели. Перед каждым запросом бюджет резервируется атомарно по максимальному размеру контекста и ответа; без ключа помощник отвечает по проверенным данным без вызова модели.
6. Для push-напоминаний создайте VAPID keys командой `pnpm dlx web-push generate-vapid-keys`; задайте public/private key, `VAPID_SUBJECT`, `VITE_VAPID_PUBLIC_KEY` и cron secret. Затем создайте расписание из SQL в `supabase/schedule-notifications.sql` в SQL Editor Supabase.
7. Разверните Edge Functions:

   ```sh
   pnpm dlx supabase@latest functions deploy get-slots --no-verify-jwt
   pnpm dlx supabase@latest functions deploy book-appointment --no-verify-jwt
   pnpm dlx supabase@latest functions deploy appointment-access --no-verify-jwt
   pnpm dlx supabase@latest functions deploy cancel-appointment --no-verify-jwt
   pnpm dlx supabase@latest functions deploy push-subscribe --no-verify-jwt
    pnpm dlx supabase@latest functions deploy owner-api
    pnpm dlx supabase@latest functions deploy admin-api
    pnpm dlx supabase@latest functions deploy assistant --no-verify-jwt
    pnpm dlx supabase@latest functions deploy notification-dispatch --no-verify-jwt
    ```

    `admin-api` разворачивается БЕЗ `--no-verify-jwt` (verify_jwt=true): каждый
    запрос проверяет членство в `platform_admins`. Полная инструкция по панели,
    первому администратору, скрытому пути и ротации — в [ADMIN.md](ADMIN.md).

   Настройте секреты: `pnpm dlx supabase@latest secrets set NAME=value ...`. Не вставляйте эту команду с реальными значениями в историю репозитория.

8. В Supabase Auth создайтевладельцу пользователя по почте и паролю. Узнайте его UUID в панели Auth и вставьте членство для конкретной студии:

   ```sql
   insert into public.tenant_memberships (tenant_id, user_id, role, username)
   select id, '<auth-user-uuid>', 'owner', '<username>'
   from public.tenants where slug = 'north-studio'
   on conflict (tenant_id, user_id) do update set role = excluded.role, username = excluded.username;
   ```

   Имя пользователя (username) должно быть уникальным и использоваться для входа вместо email.

   Создайте профиль студии через [короткую инструкцию](NEW-TENANT.md). `tenant:publish` загружает новую студию как preview; после публикации сайта `tenant:verify` проверяет публичный адрес, а `tenant:activate` переводит только проверенный non-demo профиль в live.

## Vercel

`vercel.json` настраивает SPA-переходы для студийных URL. Импортируйте проект в Vercel, задайте frontend-переменные окружения, затем выполните `pnpm build` и `pnpm dlx vercel --prod`. Не публикуйте `.env.local`. Для `APP_PUBLIC_URL` укажите итоговый HTTPS-домен и добавьте его в `APP_ALLOWED_ORIGINS`.

После выкладки проверьте страницу `/s/<slug>/`, тестовую запись, вход владельца, повторное занятие слота, помощника и установку PWA на мобильном устройстве. На iOS установка выполняется через «Поделиться → На экран Домой»; на поддерживаемых браузерах Android доступна кнопка установки.
