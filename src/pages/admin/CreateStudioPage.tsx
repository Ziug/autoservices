import {useState, type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useMutation} from '@tanstack/react-query';
import {ArrowRight} from '@phosphor-icons/react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {createTenant, listTenants, newRequestId} from '@/lib/admin-api';
import {normalizeSlugInput, suggestSlug, validateSlug} from '@/lib/suggest-slug';

const COMMON_TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Yakutsk',
  'Asia/Vladivostok',
  'Asia/Magadan',
  'Asia/Kamchatka',
];

const COMMON_CURRENCIES = ['RUB', 'USD', 'EUR', 'KZT', 'BYN', 'UZS', 'GEL', 'AMD'];

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', {timeZone: value});
    return true;
  } catch {
    return false;
  }
}

/**
 * Priority-one entry: create a draft studio with the genuinely mandatory
 * fields only (name + slug; timezone/currency defaulted). Everything else
 * gets safe defaults and is configured in the setup workspace.
 * Drafts are never publicly bookable.
 */
export function CreateStudioPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [currency, setCurrency] = useState('RUB');

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(suggestSlug(value));
  };

  const nameError = name.trim() && name.trim().length < 2 ? 'Название не короче 2 символов.' : null;
  const slugError = slug.trim() ? validateSlug(slug) : null;
  const timezoneError = timezone.trim() && !isValidTimezone(timezone.trim()) ? 'Укажите существующую IANA-зону (например, Europe/Moscow).' : null;
  const currencyError = currency.trim() && !/^[A-Z]{3}$/.test(currency.trim().toUpperCase()) ? 'Код из 3 заглавных латинских букв (например, RUB).' : null;
  const canSubmit = name.trim().length >= 2 && !slugError && !timezoneError && !currencyError && slug.trim().length > 0;

  const mutation = useMutation({
    mutationFn: async () => {
      // Client-side duplicate pre-check (server ILIKE search, exact compare here).
      const {tenants} = await listTenants({search: slug.trim().toLowerCase(), status: 'all', limit: 10, offset: 0});
      if (tenants.some((row) => row.slug === slug.trim().toLowerCase())) {
        throw new Error('Этот адрес уже занят другой студией.');
      }
      const result = await createTenant({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        timezone: timezone.trim() || 'Europe/Moscow',
        currency: currency.trim().toUpperCase() || 'RUB',
        requestId: newRequestId(),
      });
      const tenant = result.tenant as {id?: string} | undefined;
      if (!tenant?.id) throw new Error('Студия создана, но идентификатор не вернулся. Обновите список студий.');
      return tenant.id;
    },
    onSuccess: (tenantId) => navigate(adminUrl('tenants', tenantId, 'setup'), {replace: true}),
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate();
  };

  return (
    <VStack gap={4} className="admin-page">
      <AdminAreaHeading title="Новая студия" description="Только обязательное для черновика. Остальное — с умолчаниями, настроите дальше." />

      <Card className="admin-form-card">
        <form className="admin-login-form" onSubmit={submit}>
          <label className="admin-field">
            <small>Название студии</small>
            <input
              autoComplete="off"
              placeholder="Например, Графит Детейлинг"
              value={name}
              onChange={(event) => onNameChange(event.currentTarget.value)}
              required
              minLength={2}
              maxLength={100}
              aria-label="Название студии"
            />
          </label>
          {nameError ? <Text type="supporting" color="secondary">{nameError}</Text> : null}

          <label className="admin-field">
            <small>Адрес страницы (slug)</small>
            <input
              autoComplete="off"
              placeholder="grafit-deteyling"
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(normalizeSlugInput(event.currentTarget.value));
              }}
              required
              aria-label="Адрес страницы студии"
              aria-describedby="slug-hint"
            />
          </label>
          <Text type="supporting" color="secondary" id="slug-hint">
            {slug.trim() ? `Страница: /s/${slug.trim().toLowerCase()}/ — проверяется на занятость при создании.` : 'Предложим автоматически из названия, можно исправить.'}
          </Text>
          {slugError ? <p className="form-error" role="alert">{slugError}</p> : null}

          <label className="admin-field">
            <small>Часовой пояс</small>
            <input
              autoComplete="off"
              list="admin-timezones"
              value={timezone}
              onChange={(event) => setTimezone(event.currentTarget.value)}
              required
              aria-label="Часовой пояс"
            />
            <datalist id="admin-timezones">
              {COMMON_TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </label>
          {timezoneError ? <p className="form-error" role="alert">{timezoneError}</p> : null}

          <label className="admin-field admin-field-select">
            <small>Валюта цен</small>
            <select value={currency} onChange={(event) => setCurrency(event.currentTarget.value)} aria-label="Валюта цен">
              {COMMON_CURRENCIES.map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </label>
          {currencyError ? <p className="form-error" role="alert">{currencyError}</p> : null}

          {mutation.isError ? (
            <Banner
              status="error"
              title="Не удалось создать черновик"
              description={mutation.error instanceof Error ? mutation.error.message : 'Попробуйте ещё раз.'}
            />
          ) : null}

          <Button
            label="Создать черновик"
            type="submit"
            variant="primary"
            icon={<ArrowRight aria-hidden="true" />}
            isLoading={mutation.isPending}
            isDisabled={!canSubmit}
          />
        </form>
      </Card>

      <Text type="supporting" color="secondary">
        Черновик не виден клиентам и недоступен для записи. Тема, шаг расписания, галерея и остальные настройки получат значения по умолчанию — их можно изменить в настройке.
      </Text>
    </VStack>
  );
}
