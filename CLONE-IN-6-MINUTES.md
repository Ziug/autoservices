# Новая студия за шесть минут

Эти шаги подготавливают preview студии. Публикация работающей записи требует уже подключённого Supabase и сайта.

## 1. Создайте профиль

```sh
pnpm tenant:new north-studio
```

## 2. Замените данные

Отредактируйте `tenants/north-studio/business.json`: название, описание, город, адрес, телефон, часовой пояс, график, цены, длительность услуг, боксы и три карточки главной страницы. Измените `slug`, только если вы выбрали другой адрес студии.

## 3. Добавьте оригинальные фотографии

Положите главное фото в `tenants/north-studio/images/hero.jpg`, знак — в `tenants/north-studio/images/mark.svg`, замените изображения и подписи галереи. Укажите пути к своим фотографиям в JSON. Не оставляйте демонстрационные контакты и изображения.

## 4. Проверьте профиль и откройте preview

```sh
pnpm tenant:validate north-studio
pnpm dev
```

Откройте `/s/north-studio/`. Пока `demo: true`, все действия остаются демо-данными в браузере.

## 5. Подключите настоящий бизнес

В `.env.local` задайте URL и ключи Supabase. В Supabase создайте студию и её владельца:

```sh
pnpm tenant:publish north-studio
pnpm tenant:verify north-studio
```

После проверки замените `demo` на `false` и `status` на `live` в `business.json`, выполните `pnpm tenant:validate north-studio` и затем:

```sh
pnpm tenant:publish north-studio
pnpm tenant:verify north-studio
pnpm tenant:activate north-studio
```

Новая студия остаётся в preview до явной активации. Владелец входит через заранее созданный аккаунт Supabase Auth; добавьте UUID пользователя в `tenant_memberships` для этой студии.

## 6. Опубликуйте общий сайт

Разверните один Vercel или Cloudflare Pages сайт из `dist`, добавьте публичные переменные Supabase, задайте HTTPS `PUBLIC_BASE_URL` и origin для функций. Проверьте ссылку и запись до отправки её владельцу.

Подробные команды, secrets и расписание push находятся в [SETUP.md](SETUP.md). `tenant:publish` обновляет профиль, услуги и ресурсы в Supabase; существующие записи и фотографии, загруженные владельцем, сохраняются.
