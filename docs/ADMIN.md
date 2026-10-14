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
- `202610140001_admin_studio_creation.sql` — действия аудита `admin.create`,
  `admin.publish`, `admin.activate`.
- `202610140002_admin_studio_update.sql` — действия аудита `admin.update`,
  `admin.save-service`, `admin.save-resource`, `admin.save-date-override`.
- `202610160001_owner_username_auth.sql` — колонка `tenant_memberships.username`
  (уникальный логин владельца).
- `202610170001_owner_accounts.sql` — необязательная `recovery_email` для связи
  + действия аудита `admin.create-owner`, `admin.update-owner`, `admin.delete-owner`.

## 4. Создание студий: черновик → настройка → публикация → активация

Маршруты (под скрытым `VITE_ADMIN_PATH`): `tenants/new` (мастер),
`tenants/:id/setup` (рабочее место), `tenants/:id/preview` (предпросмотр).

1. **Создать черновик** — кнопка «Создать студию» (dashboard и каталог).
   Обязательны только **название и slug** (slug предлагается из названия,
   проверяется на занятость); часовой пояс (умолчание `Europe/Moscow`) и
   валюта (умолчание `RUB`) подтверждаются. Остальное — безопасные умолчания.
   Черновик (`draft`) не виден клиентам и недоступен для записи; чужую студию
   создать/перезаписать нельзя (занятый slug → 409).
2. **Настроить** — рабочее место с табом «Обзор» (счётчик готовности),
   «Оформление и профиль» (контакты, тема, график, галерея, 3 инфо-карточки,
   подсказки помощника, демо-флаг), «Услуги» (добавление/правка/скрытие; цены
   только/recorded, история записей не переписывается), «Ресурсы и часы»
   (посты + исключения календаря; проверка совместимости услуги↔пост),
   «Публикация». Все кнопки сохранения выполняют реальные серверные действия
   (`update-tenant`, `save-service`, `save-resource`, `save-date-override`)
   с теми же валидациями, что у владельца; загрузка файлов — в кабинете
   владельца (здесь — URL уже размещённых изображений).
3. **Проверить и предпросмотреть** — отчёт `validate-tenant` делит находки на
   блокирующие ошибки / предупреждения / справку. Предпросмотр строится из той
   же конфигурации, запись в нём отключена (уведомления не отправляются,
   брони не создаются).
4. **Опубликовать** (`draft→preview`, только без блокирующих ошибок, одним
   обновлением статуса — записи/цены/оплаты/доступы сохраняются), затем
   **активировать** (`preview→live`, только не-демо с реальными контактами).
5. **Экспорт** — кнопка «Скачать business.json» сохраняет конфигурацию в формате
   provisioning-входа: положите файл в `tenants/<slug>/business.json` и дальше
   работают `tenant:validate`, `tenant:publish`, `tenant:verify` из CLI.

Что обязательно / блокирует / опционально:
- Черновик: название (≥2), уникальный URL-safe slug. Часовой пояс и валюта
  имеют умолчания, но проверяются (IANA; `[A-Z]{3}`).
- Блокируют публикацию/активацию: ≥1 активная услуга; у каждой — совместимый
  активный пост; ≥1 строка графика с `opensAt<closesAt` и уникальными днями;
  корректные шаг записи (5–120) и окно отмены (≥0); валидные slug/имя/зона/валюта.
- Блокируют только активацию: `is_demo=false`, реальные город/адрес/телефон/
  название (без плейсхолдеров `tenant:new`).
- Опционально (предупреждения): tagline, описание, карта, фото, логотип,
  галерея, 3 карточки, подсказки помощника. AI/уведомления для обычной записи
  не требуются; секреты (LLM, service-role) в панели отсутствуют.
- Ручные шаги вне панели: `tenant:verify` публичного URL (CLI), VAPID/LLM
  секреты, cron напоминаний — см. DEPLOYMENT.md.

## 5. Проверка production

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

## 6. Бэкап перед деструктивными действиями

Перед `suspend/archive` сделайте бэкап БД (Supabase Dashboard → Backups / `pg_dump`),
зафиксируйте `requestId` операции и причину из журнала. Повтор с тем же
`requestId` безопасен (`{deduped:true}`).

## 7. Переменные окружения

Vercel (frontend, публичные): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
`VITE_VAPID_PUBLIC_KEY` (optional), `VITE_ADMIN_PATH` (obscurity).
Supabase (server-only): `APP_ANON_KEY`, `APP_SERVICE_ROLE_KEY`,
`BOOKING_TOKEN_SECRET`, `APP_ALLOWED_ORIGINS`, `APP_PUBLIC_URL`,
`NOTIFICATION_CRON_SECRET`, LLM/VAPID — как в `.env.example`.
Никогда не ставьте `*_SERVICE_ROLE_*`/`BOOKING_TOKEN_SECRET` в `VITE_*`.

## 8. Доступы владельцев и сброс пароля

Доступ владельца создаётся только в панели: карточка студии → вкладка
«Владельцы». Обязательны только **логин** (3–32: `a-z 0–9 . _ -`) и **пароль**
(≥8 символов); **почта необязательна** и служит лишь контактом для связи.
Для входа почта не используется: auth идёт на внутренний адрес
`<логин>@owners.local`. Сброс пароля — кнопка «Новый пароль» у доступа;
передайте новый пароль владельцу лично (или на оставленную почту).
Страница `/reset-password` → письмо → `/update-password` относится только к
администраторам с реальной почтой. Добавьте в Supabase Dashboard →
Authentication → URL Configuration → Redirect URLs адрес
`https://<домен>/update-password`, иначе письмо со ссылкой будет отклонено.

## 9. Ограничения

- Постоянное удаление не реализовано (только suspend/archive + аудит).
- Дашборд показывает только вычисляемое: счётчики статусов, upcoming-7d,
  recorded gross/refund/net за 30 дней, последние аудит-события.
- Live-DB/E2E тесты требуют linked Supabase + браузеры; см. финальный отчёт.
