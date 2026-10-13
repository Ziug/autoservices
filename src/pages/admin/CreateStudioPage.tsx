import {useState, type FormEvent} from 'react';
import {useNavigate} from 'react-router-dom';
import {useMutation} from '@tanstack/react-query';
import {ArrowRight, Package, Tray} from '@phosphor-icons/react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {createTenant, DETAILING_TEMPLATE_CONTENTS, listTenants, newRequestId, type StudioTemplate} from '@/lib/admin-api';
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

const TEMPLATE_OPTIONS: Array<{value: StudioTemplate; title: string; description: string}> = [
  {
    value: 'detailing',
    title: 'Автодетейлинг — с готовым наполнением',
    description: 'Студия откроется почти заполненной: останется проверить контакты и опубликовать.',
  },
  {
    value: 'empty',
    title: 'Пустая студия',
    description: 'Только черновик без услуг и постов — всё заполните вручную в настройке.',
  },
];

/**
 * Simplified entry: mandatory fields only (name + slug; timezone/currency
 * defaulted) plus one template choice. The starter template is preselected,
 * so creation is still a single step: fill the name, confirm, done. The
 * setup workspace then opens on a mostly-populated studio.
 * Drafts are never publicly bookable.
 */
export function CreateStudioPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState('Europe/Moscow');
  const [currency, setCurrency] = useState('RUB');
  const [template, setTemplate] = useState<StudioTemplate>('detailing');

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
        throw new Error('Этот slug уже занят другой студией.');
      }
      const result = await createTenant({
        name: name.trim(),
        slug: slug.trim().toLowerCase(),
        timezone: timezone.trim() || 'Europe/Moscow',
        currency: currency.trim().toUpperCase() || 'RUB',
        template,
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
      <AdminAreaHeading title="Новая студия" description="Название, ссылка и шаблон — остальное уже будет внутри или настроите дальше." />

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
            <small>Slug страницы</small>
            <input
              autoComplete="off"
              placeholder="grafit-deteyling"
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(normalizeSlugInput(event.currentTarget.value));
              }}
              required
              aria-label="Slug страницы студии"
              aria-describedby="slug-hint"
            />
          </label>
          <Text type="supporting" color="secondary" id="slug-hint">
            {slug.trim() ? `Страница: /s/${slug.trim().toLowerCase()}/ — проверяется на занятость при создании.` : 'Предложим автоматически из названия, можно исправить.'}
          </Text>
          {slugError ? <p className="form-error" role="alert">{slugError}</p> : null}

          <section className="admin-template-group" aria-label="Шаблон студии">
            <Heading level={3}>Что создать</Heading>
            {TEMPLATE_OPTIONS.map((option) => {
              const selected = template === option.value;
              return (
                <label key={option.value} className="admin-template-option" data-selected={selected}>
                  <input
                    type="radio"
                    name="studio-template"
                    value={option.value}
                    checked={selected}
                    onChange={() => setTemplate(option.value)}
                    aria-label={option.title}
                  />
                  <section className="admin-template-copy">
                    <HStack gap={2}>
                      {option.value === 'detailing' ? <Package aria-hidden="true" /> : <Tray aria-hidden="true" />}
                      <strong>{option.title}</strong>
                    </HStack>
                    <Text type="supporting" color="secondary">{option.description}</Text>
                    {option.value === 'detailing' ? (
                      <ul className="admin-template-contents">
                        {DETAILING_TEMPLATE_CONTENTS.map((item) => (
                          <li key={item}>
                            <Text type="supporting">{item}</Text>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </section>
                </label>
              );
            })}
          </section>

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
              title="Не удалось создать студию"
              description={mutation.error instanceof Error ? mutation.error.message : 'Попробуйте ещё раз.'}
            />
          ) : null}

          <Button
            label={template === 'detailing' ? 'Создать студию с наполнением' : 'Создать пустую студию'}
            type="submit"
            variant="primary"
            icon={<ArrowRight aria-hidden="true" />}
            isLoading={mutation.isPending}
            isDisabled={!canSubmit}
          />
        </form>
      </Card>

      <Text type="supporting" color="secondary">
        Черновик не виден клиентам и недоступен для записи. Со стартовым шаблоном настройка сводится к проверке контактов и публикации.
      </Text>
    </VStack>
  );
}
