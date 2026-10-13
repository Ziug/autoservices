import {useState} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowSquareOut, CheckCircle, DownloadSimple, RocketLaunch, WarningCircle} from '@phosphor-icons/react';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {TabList, Tab} from '@astryxdesign/core/TabList';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {
  activateTenant,
  adminApiErrorReport,
  exportTenant,
  getTenantDetail,
  listAdminOverrides,
  listResources,
  listServices,
  newRequestId,
  publishTenant,
  saveAdminDateOverride,
  saveAdminResource,
  saveAdminService,
  updateAdminTenantProfile,
  validateTenant,
  type AdminDateOverrideRow,
  type AdminResourceRow,
  type AdminServiceRow,
  type AdminTenantDetail,
  type ValidationReport,
} from '@/lib/admin-api';
import {money} from '@/lib/format';

type SetupTab = 'overview' | 'branding' | 'services' | 'resources' | 'publication';

const TABS: Array<{value: SetupTab; label: string}> = [
  {value: 'overview', label: 'Обзор'},
  {value: 'branding', label: 'Оформление и профиль'},
  {value: 'services', label: 'Услуги'},
  {value: 'resources', label: 'Ресурсы и часы'},
  {value: 'publication', label: 'Публикация'},
];

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

type BusinessJson = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  city: string;
  address: string;
  phone: string;
  mapUrl: string;
  timezone: string;
  currency: string;
  locale: string;
  accentColor: string;
  heroImage: string;
  logoImage: string;
  demo: boolean;
  status: string;
  bookingStepMinutes: number;
  cancellationWindowHours: number;
  openingHours: Array<{weekday: number; opensAt: string; closesAt: string}>;
  services: Array<{
    slug: string; name: string; description: string; priceMinor: number; durationMinutes: number;
    bufferBeforeMinutes: number; bufferAfterMinutes: number; category: string; resourceTypes: string[];
  }>;
  resources: Array<{slug: string; name: string; resourceType: string}>;
  gallery: Array<{id: string; image: string; caption: string; position: number}>;
  infoCards: Array<{id: string; title: string; body: string}>;
  assistantPrompts: string[];
};

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

function normalizeBusinessJson(raw: Record<string, unknown>): BusinessJson {
  const list = <T,>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    slug: str(raw.slug),
    name: str(raw.name, '—'),
    tagline: str(raw.tagline),
    description: str(raw.description),
    city: str(raw.city),
    address: str(raw.address),
    phone: str(raw.phone),
    mapUrl: str(raw.mapUrl),
    timezone: str(raw.timezone, 'Europe/Moscow'),
    currency: str(raw.currency, 'RUB'),
    locale: str(raw.locale, 'ru-RU'),
    accentColor: str(raw.accentColor, '#4690FF'),
    heroImage: str(raw.heroImage),
    logoImage: str(raw.logoImage),
    demo: Boolean(raw.demo ?? true),
    status: str(raw.status, 'draft'),
    bookingStepMinutes: num(raw.bookingStepMinutes, 30),
    cancellationWindowHours: num(raw.cancellationWindowHours, 12),
    openingHours: list<{weekday: number; opensAt: string; closesAt: string}>(raw.openingHours),
    services: list<BusinessJson['services'][number]>(raw.services),
    resources: list<BusinessJson['resources'][number]>(raw.resources),
    gallery: list<BusinessJson['gallery'][number]>(raw.gallery),
    infoCards: list<BusinessJson['infoCards'][number]>(raw.infoCards),
    assistantPrompts: list<string>(raw.assistantPrompts),
  };
}

function visibilityBadgeVariant(visibility: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  if (visibility === 'live') return 'success';
  if (visibility === 'preview') return 'info';
  if (visibility === 'suspended') return 'warning';
  if (visibility === 'archived') return 'error';
  return 'neutral';
}

function visibilityLabel(visibility: string): string {
  if (visibility === 'live') return 'Live';
  if (visibility === 'preview') return 'Preview';
  if (visibility === 'suspended') return 'Приостановлена';
  if (visibility === 'archived') return 'В архиве';
  return 'Черновик';
}

function FindingList({title, items, tone}: {title: string; items: Array<{code: string; message: string}>; tone: 'error' | 'warning' | 'info'}) {
  if (items.length === 0) return null;
  return (
    <section className="admin-findings" data-tone={tone} aria-label={title}>
      <Heading level={3}>{title} ({items.length})</Heading>
      <ul className="admin-findings-list">
        {items.map((item) => (
          <li key={item.code + item.message}>
            <Text type="supporting"><strong>{item.code}</strong> — {item.message}</Text>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SERVICE_COLUMNS: Array<TableColumn<AdminServiceRow>> = [
  {key: 'name', header: 'Название', width: proportional(2, {minWidth: 140})},
  {key: 'category', header: 'Категория', width: proportional(1, {minWidth: 90})},
  {key: 'priceMinor', header: 'Цена', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{money(row.priceMinor, 'RUB')}</Text>},
  {key: 'durationMinutes', header: 'Мин.', width: proportional(1, {minWidth: 70}), renderCell: (row) => <Text type="supporting">{row.durationMinutes}</Text>},
  {key: 'active', header: 'Статус', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.active ? 'Активна' : 'Скрыта'}</Text>},
];

function serviceEditColumns(onEdit: (row: AdminServiceRow) => void): Array<TableColumn<AdminServiceRow>> {
  return [
    ...SERVICE_COLUMNS,
    {key: 'id', header: '', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Button label="Править" size="sm" variant="ghost" onClick={() => onEdit(row)} />},
  ];
}

const RESOURCE_COLUMNS: Array<TableColumn<AdminResourceRow>> = [
  {key: 'name', header: 'Пост', width: proportional(1, {minWidth: 120})},
  {key: 'resourceType', header: 'Тип', width: proportional(1, {minWidth: 90})},
  {key: 'active', header: 'Статус', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.active ? 'Активен' : 'Отключён'}</Text>},
];

const OVERRIDE_COLUMNS: Array<TableColumn<AdminDateOverrideRow>> = [
  {key: 'localDate', header: 'Дата', width: proportional(1, {minWidth: 100})},
  {key: 'isClosed', header: 'Режим', width: proportional(1, {minWidth: 100}), renderCell: (row) => <Text type="supporting">{row.isClosed ? 'Выходной' : `${row.opensAt ?? ''}–${row.closesAt ?? ''}`}</Text>},
  {key: 'label', header: 'Подпись', width: proportional(1, {minWidth: 120}), renderCell: (row) => <Text type="supporting">{row.label || '—'}</Text>},
];

export function StudioSetupPage() {
  const {tenantId = ''} = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<SetupTab>('overview');
  const [notice, setNotice] = useState<{kind: 'success' | 'error'; text: string} | null>(null);
  const [activateOpen, setActivateOpen] = useState(false);
  const [activateRequestId, setActivateRequestId] = useState('');

  const detailQuery = useQuery({queryKey: ['admin-tenant', tenantId], queryFn: () => getTenantDetail(tenantId), enabled: Boolean(tenantId), staleTime: 15_000});
  const configQuery = useQuery({
    queryKey: ['admin-studio-config', tenantId],
    queryFn: async () => normalizeBusinessJson(await exportTenant(tenantId)),
    enabled: Boolean(tenantId),
    staleTime: 15_000,
  });
  const validationQuery = useQuery({
    queryKey: ['admin-studio-validation', tenantId],
    queryFn: () => validateTenant(tenantId),
    enabled: Boolean(tenantId),
    staleTime: 15_000,
  });
  const servicesQuery = useQuery({queryKey: ['admin-tenant-services', tenantId], queryFn: () => listServices(tenantId), enabled: Boolean(tenantId) && tab === 'services', staleTime: 15_000});
  const resourcesQuery = useQuery({queryKey: ['admin-tenant-resources', tenantId], queryFn: () => listResources(tenantId), enabled: Boolean(tenantId) && tab === 'resources', staleTime: 15_000});
  const overridesQuery = useQuery({queryKey: ['admin-tenant-overrides', tenantId], queryFn: () => listAdminOverrides(tenantId), enabled: Boolean(tenantId) && tab === 'resources', staleTime: 15_000});

  const refresh = async () => {
    await queryClient.invalidateQueries({queryKey: ['admin-studio-config', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-studio-validation', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-tenant', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-tenants']});
    await queryClient.invalidateQueries({queryKey: ['admin-tenant-services', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-tenant-resources', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-tenant-overrides', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-dashboard']});
    await queryClient.invalidateQueries({queryKey: ['admin-audit']});
  };

  const lifecycleMutation = useMutation({
    mutationFn: async ({kind, id}: {kind: 'publish' | 'activate'; id: string}) => {
      if (kind === 'publish') return publishTenant(tenantId, id);
      return activateTenant(tenantId, id);
    },
    onSuccess: async () => {
      setNotice({kind: 'success', text: 'Статус студии обновлён.'});
      setActivateOpen(false);
      await refresh();
    },
    onError: (caught) => {
      const report = adminApiErrorReport(caught);
      setNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось обновить статус.'});
      if (report && (report.errors.length > 0 || report.warnings.length > 0)) {
        void queryClient.setQueryData(['admin-studio-validation', tenantId], (old: unknown) => ({...(old as object ?? {}), ...report}));
      }
    },
  });

  if (detailQuery.isLoading || configQuery.isLoading) {
    return (
      <VStack gap={3} className="admin-page" aria-busy="true" aria-label="Загружаем настройку студии">
        <AdminAreaHeading title="Настройка студии" description="Загружаем конфигурацию." />
      </VStack>
    );
  }

  if (detailQuery.isError || configQuery.isError || !detailQuery.data || !configQuery.data) {
    const error = detailQuery.error ?? configQuery.error;
    return (
      <VStack gap={4} className="admin-page">
        <AdminAreaHeading title="Настройка студии" description="Рабочее место студии." />
        <Banner status="error" title="Не удалось загрузить студию" description={error instanceof Error ? error.message : 'Попробуйте обновить страницу.'} />
        <HStack gap={2}>
          <Button label="Повторить" variant="secondary" onClick={() => { void detailQuery.refetch(); void configQuery.refetch(); }} />
          <Button label="К списку студий" variant="ghost" href={adminUrl('tenants')} />
        </HStack>
      </VStack>
    );
  }

  const detail: AdminTenantDetail = detailQuery.data;
  const config = configQuery.data;
  const validation: ValidationReport = validationQuery.data ?? {errors: [], warnings: [], info: []};
  const status = config.status;
  const publicUrl = `/s/${config.slug}/`;
  const bookable = status === 'preview' || status === 'live';

  const downloadExport = async () => {
    try {
      const raw = await exportTenant(tenantId);
      const blob = new Blob([`${JSON.stringify(raw, null, 2)}\n`], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${config.slug}-business.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось выгрузить business.json.'});
    }
  };

  return (
    <VStack gap={4} className="admin-page">
      <header className="admin-page-head">
        <section className="admin-page-head-copy">
          <Heading level={1}>{config.name}</Heading>
          <Text color="secondary">{config.slug} · {config.city || 'город не указан'} · {config.timezone} · {config.currency}</Text>
          <HStack gap={2}>
            <Badge variant={visibilityBadgeVariant(detail.tenant.visibility)} label={visibilityLabel(detail.tenant.visibility)} />
            {config.demo ? <Badge variant="neutral" label="Демо" /> : null}
          </HStack>
        </section>
        <section className="admin-actions" aria-label="Действия настройки">
          <Button label="Предпросмотр" variant="secondary" icon={<ArrowSquareOut aria-hidden="true" />} href={adminUrl('tenants', tenantId, 'preview')} />
          <Button label="Карточка студии" variant="ghost" href={adminUrl('tenants', tenantId)} />
        </section>
      </header>

      {notice ? <Banner status={notice.kind} title={notice.kind === 'success' ? 'Готово' : 'Не удалось сохранить'} description={notice.text} isDismissable onDismiss={() => setNotice(null)} /> : null}

      <section className="admin-tab-scroll">
        <TabList value={tab} onChange={(value) => setTab(value as SetupTab)} hasDivider>
          {TABS.map((item) => (
            <Tab key={item.value} value={item.value} label={item.label} />
          ))}
        </TabList>
      </section>

      {tab === 'overview' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Обзор настройки">
          <VStack gap={3}>
            <Heading level={2}>Готовность</Heading>
            {validationQuery.isError ? <Banner status="error" title="Не удалось проверить конфигурацию" description={validationQuery.error instanceof Error ? validationQuery.error.message : 'Попробуйте позже.'} /> : null}
            <HStack gap={2}>
              <Text type="supporting"><WarningCircle aria-hidden="true" /> Блокирующих ошибок: {validation.errors.length}</Text>
              <Text type="supporting"><CheckCircle aria-hidden="true" /> Предупреждений: {validation.warnings.length}</Text>
            </HStack>
            <section className="admin-definition-list">
              <DefinitionRow label="Услуги / посты / записи" value={`${detail.counts.services} / ${detail.counts.resources} / ${detail.counts.appointments}`} />
              <DefinitionRow label="Открытых дней в неделю" value={String(config.openingHours.length)} />
              <DefinitionRow label="Публичная страница" value={bookable ? publicUrl : 'недоступна до публикации (черновик)'} />
            </section>
            <FindingList title="Блокирующие ошибки" items={validation.errors} tone="error" />
            <FindingList title="Предупреждения" items={validation.warnings} tone="warning" />
            <FindingList title="Справка" items={validation.info} tone="info" />
            <HStack gap={2}>
              <Button label="Перейти к публикации" variant="primary" onClick={() => setTab('publication')} />
              <Button label="Редактировать услуги" variant="secondary" onClick={() => setTab('services')} />
            </HStack>
          </VStack>
        </section>
      ) : null}

      {tab === 'branding' ? (
        <BrandingSection
          key={`branding-${tenantId}-${configQuery.dataUpdatedAt}`}
          config={config}
          tenantId={tenantId}
          onSaved={refresh}
          onNotice={setNotice}
        />
      ) : null}

      {tab === 'services' ? (
        <ServicesSection
          tenantId={tenantId}
          currency={config.currency}
          services={servicesQuery.data ?? []}
          isLoading={servicesQuery.isLoading}
          isError={servicesQuery.isError}
          error={servicesQuery.error}
          onSaved={refresh}
          onNotice={setNotice}
        />
      ) : null}

      {tab === 'resources' ? (
        <ResourcesSection
          tenantId={tenantId}
          resources={resourcesQuery.data ?? []}
          overrides={overridesQuery.data ?? []}
          isLoading={resourcesQuery.isLoading || overridesQuery.isLoading}
          onSaved={refresh}
          onNotice={setNotice}
        />
      ) : null}

      {tab === 'publication' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Публикация студии">
          <VStack gap={3}>
            <Heading level={2}>Публикация</Heading>
            <section className="admin-definition-list">
              <DefinitionRow label="Статус" value={visibilityLabel(detail.tenant.visibility)} />
              <DefinitionRow label="Страница студии" value={bookable ? publicUrl : 'появится после публикации'} />
              <DefinitionRow label="Демо-режим" value={config.demo ? 'Включён (уведомления отключены; в live нельзя)' : 'Выключен'} />
            </section>
            <FindingList title="Блокирующие ошибки" items={validation.errors} tone="error" />
            <FindingList title="Предупреждения" items={validation.warnings} tone="warning" />
            <HStack gap={2}>
              <Button
                label="Опубликовать (в предпросмотр)"
                variant="primary"
                icon={<RocketLaunch aria-hidden="true" />}
                isDisabled={status !== 'draft' || lifecycleMutation.isPending}
                isLoading={lifecycleMutation.isPending}
                onClick={() => lifecycleMutation.mutate({kind: 'publish', id: newRequestId()})}
              />
              <Button
                label="Активировать (в эфир)"
                variant="secondary"
                isDisabled={status !== 'preview' || lifecycleMutation.isPending}
                isLoading={lifecycleMutation.isPending}
                onClick={() => { setActivateRequestId(newRequestId()); setActivateOpen(true); }}
              />
              <Button label="Скачать business.json" variant="ghost" icon={<DownloadSimple aria-hidden="true" />} onClick={() => void downloadExport()} />
            </HStack>
            {status === 'preview' ? (
              <Text type="supporting" color="secondary">
                Проверьте страницу {publicUrl} и записи, затем активируйте. Проверка CLI: положите скачанный файл в tenants/{config.slug}/business.json и выполните tenant:verify.
              </Text>
            ) : null}
            {status === 'draft' ? (
              <Text type="supporting" color="secondary">
                Публикация переводит черновик в предпросмотр той же базы: записи, цены, оплаты и доступы сохраняются. Отдельного «ненастоящего» переключателя нет — кнопка выше выполняет реальную публикацию.
              </Text>
            ) : null}
          </VStack>
        </section>
      ) : null}

      <Link className="admin-link" to={adminUrl('tenants')}>К списку студий</Link>

      <AlertDialog
        isOpen={activateOpen}
        onOpenChange={setActivateOpen}
        title="Активировать студию?"
        description="Студия станет публично доступна для записи. Демо-студии и студии с незаполненными контактами активировать нельзя — сервер проверит это снова."
        actionLabel="Активировать"
        actionVariant="primary"
        cancelLabel="Отмена"
        isActionLoading={lifecycleMutation.isPending}
        onAction={() => lifecycleMutation.mutate({kind: 'activate', id: activateRequestId || newRequestId()})}
      />
    </VStack>
  );
}

function DefinitionRow({label, value}: {label: string; value: string}) {
  return (
    <section className="admin-definition-row">
      <small>{label}</small>
      <p>{value}</p>
    </section>
  );
}

function useProfileSaver(tenantId: string, onSaved: () => Promise<void>, onNotice: (notice: {kind: 'success' | 'error'; text: string}) => void) {
  const save = useMutation({
    mutationFn: (profile: Record<string, unknown>) => updateAdminTenantProfile(tenantId, profile),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Сохранено.'});
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить.'}),
  });
  return save;
}

function BrandingSection({config, tenantId, onSaved, onNotice}: {
  config: BusinessJson;
  tenantId: string;
  onSaved: () => Promise<void>;
  onNotice: (notice: {kind: 'success' | 'error'; text: string}) => void;
}) {
  const save = useProfileSaver(tenantId, onSaved, onNotice);
  const [name, setName] = useState(config.name);
  const [tagline, setTagline] = useState(config.tagline);
  const [description, setDescription] = useState(config.description);
  const [city, setCity] = useState(config.city);
  const [address, setAddress] = useState(config.address);
  const [phone, setPhone] = useState(config.phone);
  const [mapUrl, setMapUrl] = useState(config.mapUrl);
  const [timezone, setTimezone] = useState(config.timezone);
  const [currency, setCurrency] = useState(config.currency);
  const [accentColor, setAccentColor] = useState(/^#[0-9a-f]{6}$/i.test(config.accentColor) ? config.accentColor : '#4690FF');
  const [heroImage, setHeroImage] = useState(config.heroImage);
  const [logoImage, setLogoImage] = useState(config.logoImage);
  const [bookingStep, setBookingStep] = useState(String(config.bookingStepMinutes));
  const [cancelWindow, setCancelWindow] = useState(String(config.cancellationWindowHours));
  const [isDemo, setIsDemo] = useState(config.demo);
  const [hours, setHours] = useState(() => WEEKDAYS.map((_, weekday) => {
    const row = config.openingHours.find((item) => item.weekday === weekday);
    return {weekday, open: Boolean(row), opensAt: row?.opensAt ?? '09:00', closesAt: row?.closesAt ?? '19:00'};
  }));
  const [gallery, setGallery] = useState(config.gallery.map((item) => ({...item})));
  const [cards, setCards] = useState(() => [0, 1, 2].map((index) => ({
    id: config.infoCards[index]?.id ?? `card-${index + 1}`,
    title: config.infoCards[index]?.title ?? '',
    body: config.infoCards[index]?.body ?? '',
  })));
  const [prompts, setPrompts] = useState(config.assistantPrompts.join('\n'));
  const [dirty, setDirty] = useState(false);
  const touch = () => setDirty(true);

  const submitProfile = () => {
    save.mutate({
      name: name.trim(), tagline: tagline.trim(), description: description.trim(), city: city.trim(),
      address: address.trim(), phone: phone.trim(), mapUrl: mapUrl.trim(), timezone: timezone.trim(),
      currency: currency.trim().toUpperCase(), accentColor, heroImage: heroImage.trim(), logoImage: logoImage.trim(),
      bookingStepMinutes: Number(bookingStep), cancellationWindowHours: Number(cancelWindow), isDemo,
      openingHours: hours.filter((row) => row.open).map((row) => ({weekday: row.weekday, opensAt: row.opensAt, closesAt: row.closesAt})),
      gallery: gallery.map((item, index) => ({id: item.id, image: item.image.trim(), caption: item.caption.trim(), position: index})),
      infoCards: cards.map((card) => ({id: card.id, title: card.title.trim(), body: card.body.trim()})),
      assistantPrompts: prompts.split('\n').map((line) => line.trim()).filter(Boolean),
    }, {onSuccess: () => setDirty(false)});
  };

  const cardsValid = cards.every((card) => card.title.trim().length > 0 && card.body.trim().length > 0);
  const promptsValid = prompts.split('\n').map((line) => line.trim()).filter(Boolean).length >= 1;
  const galleryValid = gallery.every((item) => item.image.trim().length > 0 && item.caption.trim().length > 0);

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Оформление и профиль">
      <VStack gap={4}>
        <section>
          <Heading level={2}>Профиль</Heading>
          <section className="field-grid two-column">
            <label className="field"><small>Название</small><input value={name} onChange={(event) => { setName(event.currentTarget.value); touch(); }} required minLength={2} /></label>
            <label className="field"><small>Короткий заголовок</small><input value={tagline} onChange={(event) => { setTagline(event.currentTarget.value); touch(); }} /></label>
            <label className="field two-column-span"><small>Описание</small><textarea value={description} onChange={(event) => { setDescription(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Город</small><input value={city} onChange={(event) => { setCity(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Адрес</small><input value={address} onChange={(event) => { setAddress(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Телефон</small><input value={phone} onChange={(event) => { setPhone(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Ссылка на карту</small><input value={mapUrl} onChange={(event) => { setMapUrl(event.currentTarget.value); touch(); }} type="url" /></label>
            <label className="field"><small>Часовой пояс IANA</small><input value={timezone} onChange={(event) => { setTimezone(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Валюта ISO</small><input value={currency} onChange={(event) => { setCurrency(event.currentTarget.value.toUpperCase()); touch(); }} maxLength={3} /></label>
            <label className="field"><small>Акцентный цвет</small><input value={accentColor} onChange={(event) => { setAccentColor(event.currentTarget.value); touch(); }} type="color" /></label>
            <label className="field"><small>Фото на главной (URL)</small><input value={heroImage} onChange={(event) => { setHeroImage(event.currentTarget.value); touch(); }} type="url" /></label>
            <label className="field"><small>Логотип (URL)</small><input value={logoImage} onChange={(event) => { setLogoImage(event.currentTarget.value); touch(); }} type="url" /></label>
            <label className="field"><small>Шаг расписания, минут (5–120)</small><input value={bookingStep} onChange={(event) => { setBookingStep(event.currentTarget.value); touch(); }} type="number" min={5} max={120} /></label>
            <label className="field"><small>Отмена не позднее, часов</small><input value={cancelWindow} onChange={(event) => { setCancelWindow(event.currentTarget.value); touch(); }} type="number" min={0} /></label>
            <label className="field checkbox-field"><input checked={isDemo} onChange={(event) => { setIsDemo(event.currentTarget.checked); touch(); }} type="checkbox" /><small>Демо-режим (без уведомлений; в live нельзя)</small></label>
          </section>
          <Text type="supporting" color="secondary">Загрузка файлов доступна в кабинете владельца; здесь вставляются URL уже размещённых изображений.</Text>
        </section>

        <section>
          <Heading level={3}>Еженедельный график</Heading>
          {hours.map((row) => (
            <section className="hours-editor-row" key={row.weekday}>
              <label className="checkbox-field">
                <input checked={row.open} onChange={(event) => { setHours(hours.map((item) => item.weekday === row.weekday ? {...item, open: event.currentTarget.checked} : item)); touch(); }} type="checkbox" />
                <small>{WEEKDAYS[row.weekday]}</small>
              </label>
              <label className="field"><small>Открытие</small><input value={row.opensAt} disabled={!row.open} onChange={(event) => { setHours(hours.map((item) => item.weekday === row.weekday ? {...item, opensAt: event.currentTarget.value} : item)); touch(); }} type="time" /></label>
              <label className="field"><small>Закрытие</small><input value={row.closesAt} disabled={!row.open} onChange={(event) => { setHours(hours.map((item) => item.weekday === row.weekday ? {...item, closesAt: event.currentTarget.value} : item)); touch(); }} type="time" /></label>
            </section>
          ))}
        </section>

        <section>
          <Heading level={3}>Галерея</Heading>
          {gallery.length === 0 ? <Text type="supporting" color="secondary">Фотографий пока нет — добавьте по URL.</Text> : null}
          {gallery.map((item, index) => (
            <section className="gallery-admin-row" key={item.id}>
              <label className="field"><small>URL фото</small><input value={item.image} onChange={(event) => { setGallery(gallery.map((photo, position) => position === index ? {...photo, image: event.currentTarget.value} : photo)); touch(); }} type="url" /></label>
              <label className="field"><small>Подпись</small><input value={item.caption} onChange={(event) => { setGallery(gallery.map((photo, position) => position === index ? {...photo, caption: event.currentTarget.value} : photo)); touch(); }} /></label>
              <Button label="Убрать" size="sm" variant="ghost" onClick={() => { setGallery(gallery.filter((_, position) => position !== index)); touch(); }} />
            </section>
          ))}
          <Button
            label="Добавить фото"
            size="sm"
            variant="secondary"
            onClick={() => { setGallery([...gallery, {id: `photo-${Date.now().toString(36)}`, image: '', caption: '', position: gallery.length}]); touch(); }}
          />
        </section>

        <section>
          <Heading level={3}>Информационные карточки (ровно 3)</Heading>
          {cards.map((card, index) => (
            <section className="form-panel" key={card.id}>
              <label className="field"><small>Заголовок {index + 1}</small><input value={card.title} onChange={(event) => { setCards(cards.map((item, position) => position === index ? {...item, title: event.currentTarget.value} : item)); touch(); }} required /></label>
              <label className="field"><small>Текст {index + 1}</small><textarea value={card.body} onChange={(event) => { setCards(cards.map((item, position) => position === index ? {...item, body: event.currentTarget.value} : item)); touch(); }} required /></label>
            </section>
          ))}
        </section>

        <section>
          <Heading level={3}>Подсказки помощника (по одной на строку)</Heading>
          <label className="field"><small>Подсказки</small><textarea value={prompts} onChange={(event) => { setPrompts(event.currentTarget.value); touch(); }} rows={4} /></label>
        </section>

        {dirty ? <Text type="supporting" color="secondary">Есть несохранённые изменения.</Text> : null}
        <HStack gap={2}>
          <Button
            label="Сохранить оформление"
            variant="primary"
            isLoading={save.isPending}
            isDisabled={!cardsValid || !promptsValid || !galleryValid || name.trim().length < 2}
            onClick={submitProfile}
          />
        </HStack>
        {!cardsValid || !promptsValid ? <Text type="supporting" color="secondary">Заполните все 3 карточки и хотя бы одну подсказку — иначе сервер отклонит сохранение.</Text> : null}
      </VStack>
    </section>
  );
}

function emptyService(currency: string): {slug: string; name: string; description: string; category: string; price: string; duration: string; before: string; after: string; resourceTypes: string; active: boolean} {
  void currency;
  return {slug: '', name: '', description: '', category: 'Услуга', price: '', duration: '60', before: '0', after: '0', resourceTypes: 'any', active: true};
}

function ServicesSection({tenantId, currency, services, isLoading, isError, error, onSaved, onNotice}: {
  tenantId: string;
  currency: string;
  services: AdminServiceRow[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onSaved: () => Promise<void>;
  onNotice: (notice: {kind: 'success' | 'error'; text: string}) => void;
}) {
  const [form, setForm] = useState(emptyService(currency));
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (service: Record<string, unknown>) => saveAdminService(tenantId, service),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Услуга сохранена. Исторические цены записей не меняются.'});
      setForm(emptyService(currency));
      setEditingSlug(null);
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить услугу.'}),
  });

  const submit = () => {
    const priceMinor = Math.round(Number(form.price) * 100);
    mutation.mutate({
      slug: form.slug.trim().toLowerCase().replaceAll(' ', '-'),
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category.trim() || 'Услуга',
      priceMinor: Number.isFinite(priceMinor) && priceMinor >= 0 ? priceMinor : 0,
      durationMinutes: Math.max(1, Number(form.duration) || 60),
      bufferBeforeMinutes: Math.max(0, Number(form.before) || 0),
      bufferAfterMinutes: Math.max(0, Number(form.after) || 0),
      resourceTypes: form.resourceTypes.split(',').map((value) => value.trim()).filter(Boolean),
      active: form.active,
    });
  };

  const startEdit = (row: AdminServiceRow) => {
    setEditingSlug(row.slug);
    setForm({
      slug: row.slug, name: row.name, description: row.description, category: row.category,
      price: String(row.priceMinor / 100), duration: String(row.durationMinutes),
      before: String(row.bufferBeforeMinutes), after: String(row.bufferAfterMinutes),
      resourceTypes: row.resourceTypes.join(', '), active: row.active,
    });
  };

  const valid = form.slug.trim().length > 0 && form.name.trim().length > 0 && form.resourceTypes.split(',').map((value) => value.trim()).filter(Boolean).length > 0;

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Услуги студии">
      <VStack gap={3}>
        <Heading level={2}>Услуги</Heading>
        <Text type="supporting" color="secondary">Цены в {currency}. Изменение услуги не переписывает цены уже созданных записей.</Text>
        {isError ? <Banner status="error" title="Не удалось загрузить услуги" description={error instanceof Error ? error.message : 'Попробуйте позже.'} /> : null}
        {isLoading ? <Text type="supporting" color="secondary" role="status">Загружаем услуги…</Text> : null}
        {!isLoading && services.length === 0 ? <EmptyState title="Услуг нет" description="Добавьте первую услугу — без неё публикация заблокирована." /> : null}
        {services.length > 0 ? <Table<AdminServiceRow> data={services} columns={serviceEditColumns(startEdit)} idKey="id" density="compact" hasHover /> : null}
        <section className="form-panel">
          <Heading level={3}>{editingSlug ? `Изменить: ${editingSlug}` : 'Новая услуга'}</Heading>
          <section className="field-grid two-column">
            <label className="field"><small>Название</small><input value={form.name} onChange={(event) => setForm({...form, name: event.currentTarget.value})} required /></label>
            <label className="field"><small>Адрес услуги (slug)</small><input value={form.slug} onChange={(event) => setForm({...form, slug: event.currentTarget.value.toLowerCase().replaceAll(' ', '-')})} required disabled={editingSlug !== null} /></label>
            <label className="field"><small>Описание</small><input value={form.description} onChange={(event) => setForm({...form, description: event.currentTarget.value})} /></label>
            <label className="field"><small>Категория</small><input value={form.category} onChange={(event) => setForm({...form, category: event.currentTarget.value})} /></label>
            <label className="field"><small>Цена ({currency})</small><input value={form.price} onChange={(event) => setForm({...form, price: event.currentTarget.value})} type="number" min="0" step="0.01" /></label>
            <label className="field"><small>Длительность, минут</small><input value={form.duration} onChange={(event) => setForm({...form, duration: event.currentTarget.value})} type="number" min="1" /></label>
            <label className="field"><small>Буфер до, минут</small><input value={form.before} onChange={(event) => setForm({...form, before: event.currentTarget.value})} type="number" min="0" /></label>
            <label className="field"><small>Буфер после, минут</small><input value={form.after} onChange={(event) => setForm({...form, after: event.currentTarget.value})} type="number" min="0" /></label>
            <label className="field"><small>Типы постов через запятую</small><input value={form.resourceTypes} onChange={(event) => setForm({...form, resourceTypes: event.currentTarget.value})} /></label>
            <label className="field checkbox-field"><input checked={form.active} onChange={(event) => setForm({...form, active: event.currentTarget.checked})} type="checkbox" /><small>Доступна для записи</small></label>
          </section>
          <HStack gap={2}>
            <Button label={editingSlug ? 'Сохранить услугу' : 'Добавить услугу'} variant="primary" size="sm" isLoading={mutation.isPending} isDisabled={!valid} onClick={submit} />
            {editingSlug ? <Button label="Отмена" variant="ghost" size="sm" onClick={() => { setEditingSlug(null); setForm(emptyService(currency)); }} /> : null}
          </HStack>
        </section>
      </VStack>
    </section>
  );
}

function ResourcesSection({tenantId, resources, overrides, isLoading, onSaved, onNotice}: {
  tenantId: string;
  resources: AdminResourceRow[];
  overrides: AdminDateOverrideRow[];
  isLoading: boolean;
  onSaved: () => Promise<void>;
  onNotice: (notice: {kind: 'success' | 'error'; text: string}) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [resourceType, setResourceType] = useState('any');
  const [localDate, setLocalDate] = useState('');
  const [isClosed, setIsClosed] = useState(true);
  const [opensAt, setOpensAt] = useState('09:00');
  const [closesAt, setClosesAt] = useState('19:00');
  const [label, setLabel] = useState('');

  const resourceMutation = useMutation({
    mutationFn: (resource: Record<string, unknown>) => saveAdminResource(tenantId, resource),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Пост сохранён.'});
      setName(''); setSlug(''); setResourceType('any');
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить пост.'}),
  });
  const overrideMutation = useMutation({
    mutationFn: (override: Record<string, unknown>) => saveAdminDateOverride(tenantId, override),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Исключение в графике сохранено.'});
      setLocalDate(''); setLabel(''); setIsClosed(true);
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить дату.'}),
  });

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Ресурсы и часы">
      <VStack gap={4}>
        <section>
          <Heading level={2}>Рабочие посты</Heading>
          <Text type="supporting" color="secondary">У каждой bookable-услуги должен быть хотя бы один совместимый активный пост: совпадение типа или any с любой стороны.</Text>
          {isLoading ? <Text type="supporting" color="secondary" role="status">Загружаем…</Text> : null}
          {resources.length > 0 ? <Table<AdminResourceRow> data={resources} columns={RESOURCE_COLUMNS} idKey="id" density="compact" hasHover /> : <EmptyState title="Постов нет" description="Добавьте первый пост — без него услуги нельзя опубликовать." />}
          <section className="inline-form">
            <label className="field"><small>Название</small><input value={name} onChange={(event) => setName(event.currentTarget.value)} required /></label>
            <label className="field"><small>Адрес</small><input value={slug} onChange={(event) => setSlug(event.currentTarget.value.toLowerCase().replaceAll(' ', '-'))} required /></label>
            <label className="field"><small>Тип</small><input value={resourceType} onChange={(event) => setResourceType(event.currentTarget.value)} required /></label>
            <Button label="Добавить или изменить пост" variant="secondary" size="sm" isLoading={resourceMutation.isPending} isDisabled={!name.trim() || !slug.trim() || !resourceType.trim()} onClick={() => resourceMutation.mutate({slug: slug.trim(), name: name.trim(), resourceType: resourceType.trim(), active: true})} />
          </section>
        </section>

        <section>
          <Heading level={2}>Исключения календаря</Heading>
          {overrides.length > 0 ? <Table<AdminDateOverrideRow> data={overrides} columns={OVERRIDE_COLUMNS} idKey="id" density="compact" hasHover /> : <Text type="supporting" color="secondary">Исключений пока нет.</Text>}
          <section className="inline-form">
            <label className="field"><small>Дата</small><input value={localDate} onChange={(event) => setLocalDate(event.currentTarget.value)} type="date" required /></label>
            <label className="field"><small>Открытие</small><input value={opensAt} disabled={isClosed} onChange={(event) => setOpensAt(event.currentTarget.value)} type="time" /></label>
            <label className="field"><small>Закрытие</small><input value={closesAt} disabled={isClosed} onChange={(event) => setClosesAt(event.currentTarget.value)} type="time" /></label>
            <label className="field"><small>Подпись</small><input value={label} onChange={(event) => setLabel(event.currentTarget.value)} placeholder="Например, праздник" /></label>
            <label className="checkbox-field"><input checked={isClosed} onChange={(event) => setIsClosed(event.currentTarget.checked)} type="checkbox" /><small>Выходной</small></label>
            <Button label="Сохранить дату" variant="secondary" size="sm" isLoading={overrideMutation.isPending} isDisabled={!localDate} onClick={() => overrideMutation.mutate({localDate, isClosed, opensAt: isClosed ? null : opensAt, closesAt: isClosed ? null : closesAt, label})} />
          </section>
        </section>
      </VStack>
    </section>
  );
}
