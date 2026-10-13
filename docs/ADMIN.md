# Super Admin — эксплуатация

Панель платформы: студии, записи, оплаты, приостановка/архив, журнал. Скрыта под
`VITE_ADMIN_PATH` (например `/control/<secret>`), вход — Supabase Auth +
таблица `platform_admins`. Путь — только obscurity: настоящая авторизация
проверяется `admin-api` на каждый запрос; неизвестным возвращается generic 404.

## 1. Первый администратор (без публичной регистрации)

1. В Supabase Auth создайте пользователя (email+password, signup выключен —
   создавайте через Dashboard/CLI).
2. Узнайте UUID в Auth → Users и выполните service-role/SQL:
   ```sql
   insert into public.platform_admins (user_id, label)
   values ('<auth-user-uuid>', 'ops')
   on conflict (user_id) do update set label = excluded.label;
   ```
3. Самоповышение невозможно: `tenant_memberships`, профиль, payload и
   client-state не дают прав; проверяется только `platform_admins`.

## 2. Скрытый путь: генерация, настройка, ротация

```sh
node scripts/generate-admin-path.mjs   # печатает VITE_ADMIN_PATH=/control/<32hex>
```
- Локально: впишите в `.env.local`. В Vercel: Environment Variables →
  `VITE_ADMIN_PATH` (Production + Preview). Пересоберите и redeploy.
- Путь обязан начинаться с `/control/` — так применяются rewrite и `no-store`
  из `vercel.json` (`/control/:path* → /index.html`).
- Ротация: новое значение + rebuild + redeploy; исходники менять не нужно.
  Реальное закрытие доступа — удалить строку из `platform_admins` и отозвать
  сессии, а не переименованием URL.
- Не коммитьте реальный путь, не печатайте в публичные логи, не добавляйте в
  аналитику/навигацию/sitemap. В бандле `VITE_ADMIN_PATH` виден по дизайну
  (static SPA не умеет server-only секреты) — это принято и задокументировано.

Восстановление при ошибочной ротации: старое значение лежит в истории
переменных Vercel — верните его и redeploy; либо сгенерируйте новое и
сообщите оператору лично.

## 3. Миграции и функции

```sh
pnpm dlx supabase@latest db push
pnpm dlx supabase@latest functions deploy admin-api   # verify_jwt=true, БЕЗ --no-verify-jwt
```
Секреты функции — те же, что у `owner-api`: `APP_ANON_KEY`,
`APP_SERVICE_ROLE_KEY`, `APP_ALLOWED_ORIGINS` (+ стандартный `SUPABASE_URL`).
Новых секретов не требуется. Миграции:
- `202610130001_admin.sql` — таблицы, колонки, RPC, RLS (содержит неисправный
  FK, чинится следующей).
- `202610130002_admin_fixes.sql` — исправление FK `appointment_id → appointments(id)`,
  порядок индекса, уникальный `request_id`, `REVOKE FROM public`, guard
  `owner_metrics_for_edge`. Применять обе по порядку; идемпотентны.
- `202610130003_containment.sql` — member-SELECT политики требуют
  `status IN (preview,live)` (приостановленные владельцы теряют прямой доступ
  к записям/оплатам/PII; админка через service_role не затронута) + триггер
  неизменяемости `admin_audit_log`.

## 4. Проверка production

1. Откройте `<домен><VITE_ADMIN_PATH>/login`, войдите — редирект в dashboard.
2. `POST /functions/v1/admin-api {action:'status'}` с JWT админа → `{admin:true}`;
   с JWT владельца/без JWT → generic 404.
3. Приостановите тестовую студию с причиной → публичный `/s/<slug>/` показывает
   нейтральную «временно недоступна» (без внутренних причин), новая запись и
   owner-мутации отклоняются, история сохраняется; возобновление требует явный
   `targetStatus` (`preview`|`live`, demo нельзя в `live`).
4. Архив — двухшаговый: `archive` оставляет `paused`, `unarchive` тоже оставляет
   `paused` до явного `reactivate`. Permanent DELETE нет — так задумано
   (карта FK/файлов/платежей не закрыта); используйте suspend/archive.
5. Проверьте журнал: успешные мутации и отклонённые попытки (`success:false`)
   видны в `/audit` и карточке студии; пароли/токены/ключи не пишутся.

## 5. Бэкап перед деструктивными действиями

Перед `suspend/archive` сделайте бэкап БД (Supabase Dashboard → Backups / `pg_dump`),
зафиксируйте `requestId` операции и причину из журнала. Повтор с тем же
`requestId` безопасен (`{deduped:true}`).

## 6. Переменные окружения

Vercel (frontend, публичные): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_VAPID_PUBLIC_KEY` (optional), `VITE_ADMIN_PATH` (obscurity).
Supabase (server-only): `APP_ANON_KEY`, `APP_SERVICE_ROLE_KEY`,
`BOOKING_TOKEN_SECRET`, `APP_ALLOWED_ORIGINS`, `APP_PUBLIC_URL`,
`NOTIFICATION_CRON_SECRET`, LLM/VAPID — как в `.env.example`.
Никогда не ставьте `*_SERVICE_ROLE_*`/`BOOKING_TOKEN_SECRET` в `VITE_*`.

## 7. Сброс пароля

В панели и кабинете владельца есть ссылка «Забыли пароль?» (`/reset-password`
→ письмо → `/update-password`). Добавьте в Supabase Dashboard → Authentication
→ URL Configuration → Redirect URLs адрес `https://<домен>/update-password`,
иначе письмо со ссылкой будет отклонено.

## 8. Ограничения

- Постоянное удаление не реализовано (только suspend/archive + аудит).
- Дашборд показывает только вычисляемое: счётчики статусов, upcoming-7d,
  recorded gross/refund/net за 30 дней, последние аудит-события.
- Live-DB/E2E тесты требуют linked Supabase + браузеры; см. финальный отчёт.
