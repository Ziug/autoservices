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
  adminSetupTabLabel,
  compatibleResources,
  deriveResourceDraft,
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
  suggestServiceResourceTypes,
  updateAdminTenantProfile,
  validateTenant,
  validationFindingTarget,
  type AdminApiError,
  type AdminDateOverrideRow,
  type AdminResourceRow,
  type AdminServiceRow,
  type AdminSetupTab,
  type AdminTenantDetail,
  type ValidationItem,
  type ValidationReport,
} from '@/lib/admin-api';
import {normalizeSlugInput, SLUG_FORMAT_HINT, suggestSlug, validateSlug} from '@/lib/suggest-slug';
import {money} from '@/lib/format';

const TABS: Array<{value: AdminSetupTab; label: string}> = [
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

type Notice = {kind: 'success' | 'error' | 'warning'; text: string};

function FindingList({title, items, tone, onFix}: {title: string; items: ValidationItem[]; tone: 'error' | 'warning' | 'info'; onFix?: (tab: AdminSetupTab) => void}) {
  if (items.length === 0) return null;
  return (
    <section className="admin-findings" data-tone={tone} aria-label={title}>
      <Heading level={3}>{title} ({items.length})</Heading>
      <ul className="admin-findings-list">
        {items.map((item) => {
          const target = validationFindingTarget(item.code);
          return (
            <li key={item.code + item.message}>
              <Text type="supporting"><strong>{item.code}</strong> — {item.message}</Text>
              {onFix && tone === 'error' ? (
                <Button label={`Исправить: ${adminSetupTabLabel(target)}`} size="sm" variant="ghost" onClick={() => onFix(target)} />
              ) : null}
            </li>
          );
        })}
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

function resourceTableColumns(): Array<TableColumn<AdminResourceRow>> {
  return [
    {key: 'name', header: 'Пост', width: proportional(1, {minWidth: 120})},
    {key: 'resourceType', header: 'Тип', width: proportional(1, {minWidth: 90})},
    {key: 'location', header: 'Место', width: proportional(1, {minWidth: 100}), renderCell: (row) => <Text type="supporting">{row.location || '—'}</Text>},
    {key: 'active', header: 'Статус', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.active ? 'Активен' : 'Отключён'}</Text>},
  ];
}

const OVERRIDE_COLUMNS: Array<TableColumn<AdminDateOverrideRow>> = [
  {key: 'localDate', header: 'Дата', width: proportional(1, {minWidth: 100})},
  {key: 'isClosed', header: 'Режим', width: proportional(1, {minWidth: 100}), renderCell: (row) => <Text type="supporting">{row.isClosed ? 'Выходной' : `${row.opensAt ?? ''}–${row.closesAt ?? ''}`}</Text>},
  {key: 'label', header: 'Подпись', width: proportional(1, {minWidth: 120}), renderCell: (row) => <Text type="supporting">{row.label || '—'}</Text>},
];

type SetupStep = {id: string; title: string; required: boolean; done: boolean; hint: string; tab: AdminSetupTab};

const STEP_COLUMNS: Array<TableColumn<SetupStep>> = [
  {
    key: 'title',
    header: 'Шаг',
    width: proportional(2, {minWidth: 160}),
    renderCell: (row) => (
      <Text type="supporting"><strong>{row.title}</strong> {row.required ? '(обязательно)' : '(необязательно)'}</Text>
    ),
  },
  {
    key: 'id',
    header: 'Готовность',
    width: proportional(2, {minWidth: 160}),
    renderCell: (row) => (
      <Text type="supporting">
        {row.done ? <CheckCircle aria-hidden="true" /> : <WarningCircle aria-hidden="true" />} {row.hint}
      </Text>
    ),
  },
];

function setupStepColumns(onOpen: (tab: AdminSetupTab) => void): Array<TableColumn<SetupStep>> {
  return [
    ...STEP_COLUMNS,
    {
      key: 'tab',
      header: '',
      width: proportional(1, {minWidth: 110}),
      renderCell: (row) => (row.done ? <Text type="supporting">—</Text> : <Button label="Открыть" size="sm" variant="ghost" onClick={() => onOpen(row.tab)} />),
    },
  ];
}

export function StudioSetupPage() {
  const {tenantId = ''} = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AdminSetupTab>('overview');
  const [notice, setNotice] = useState<Notice | null>(null);
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
  // All catalog queries stay enabled on every tab: panels below stay mounted
  // (hidden, not unmounted), so form drafts survive tab switches.
  const servicesQuery = useQuery({queryKey: ['admin-tenant-services', tenantId], queryFn: () => listServices(tenantId), enabled: Boolean(tenantId), staleTime: 15_000});
  const resourcesQuery = useQuery({queryKey: ['admin-tenant-resources', tenantId], queryFn: () => listResources(tenantId), enabled: Boolean(tenantId), staleTime: 15_000});
  const overridesQuery = useQuery({queryKey: ['admin-tenant-overrides', tenantId], queryFn: () => listAdminOverrides(tenantId), enabled: Boolean(tenantId), staleTime: 15_000});

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
  const services = servicesQuery.data ?? [];
  const resources = resourcesQuery.data ?? [];
  const activeServices = services.filter((service) => service.active);
  const activeResources = resources.filter((resource) => resource.active);
  const servicesWithoutPost = activeServices.filter((service) => compatibleResources(service.resourceTypes, resources).length === 0);

  const missingContact = [
    {field: 'Название', filled: config.name.trim().length >= 2},
    {field: 'Город', filled: config.city.trim().length > 0},
    {field: 'Адрес', filled: config.address.trim().length > 0},
    {field: 'Телефон', filled: config.phone.trim().length > 0},
  ].filter((item) => !item.filled);

  const steps: SetupStep[] = [
    {
      id: 'profile',
      title: 'Профиль и контакты',
      required: true,
      done: missingContact.length === 0,
      hint: missingContact.length === 0 ? 'Заполнены' : `Не хватает: ${missingContact.map((item) => item.field).join(', ')}`,
      tab: 'branding',
    },
    {
      id: 'services',
      title: 'Услуги',
      required: true,
      done: activeServices.length > 0 && servicesWithoutPost.length === 0,
      hint: activeServices.length === 0
        ? 'Нет активных услуг'
        : servicesWithoutPost.length > 0
          ? `Без подходящего поста: ${servicesWithoutPost.length}`
          : `Активных: ${activeServices.length}`,
      tab: 'services',
    },
    {
      id: 'resources',
      title: 'Посты и график',
      required: true,
      done: activeResources.length > 0 && config.openingHours.length > 0,
      hint: activeResources.length === 0
        ? 'Нет активных постов'
        : config.openingHours.length === 0
          ? 'Не заданы дни работы'
          : `Постов: ${activeResources.length}, дней: ${config.openingHours.length}`,
      tab: 'resources',
    },
    {
      id: 'content',
      title: 'Фото и тексты',
      required: false,
      done: validation.warnings.length === 0,
      hint: validation.warnings.length === 0 ? 'Готовы' : `Замечаний: ${validation.warnings.length}`,
      tab: 'branding',
    },
  ];

  const bannerStatus = notice?.kind === 'warning' ? 'warning' : notice?.kind ?? 'info';

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

      {notice ? <Banner status={bannerStatus} title={notice.kind === 'error' ? 'Не удалось сохранить' : 'Готово'} description={notice.text} isDismissable onDismiss={() => setNotice(null)} /> : null}
      {detail.tenant.visibility === 'suspended' ? (
        <Banner
          status="warning"
          title="Студия приостановлена"
          description="Запись остановлена, но правки сохраняются. После исправлений возобновите работу из карточки студии."
        />
      ) : null}
      {detail.tenant.visibility === 'archived' ? (
        <Banner
          status="error"
          title="Студия в архиве"
          description="Правки сохраняются, но страница недоступна клиентам. Верните студию из архива и возобновите работу из карточки студии."
        />
      ) : null}

      <section className="admin-tab-scroll">
        <TabList value={tab} onChange={(value) => setTab(value as AdminSetupTab)} hasDivider>
          {TABS.map((item) => (
            <Tab key={item.value} value={item.value} label={item.label} />
          ))}
        </TabList>
      </section>

      <section className="admin-tab-panel" role="tabpanel" aria-label="Обзор настройки" hidden={tab !== 'overview'}>
        <VStack gap={3}>
          <Heading level={2}>Готовность</Heading>
          <Text type="supporting" color="secondary">Сначала обязательное, потом остальное. Черновики форм не теряются при переходе между вкладками.</Text>
          {validationQuery.isError ? <Banner status="error" title="Не удалось проверить конфигурацию" description={validationQuery.error instanceof Error ? validationQuery.error.message : 'Попробуйте позже.'} /> : null}
          <HStack gap={2}>
            <Text type="supporting"><WarningCircle aria-hidden="true" /> Блокирующих ошибок: {validation.errors.length}</Text>
            <Text type="supporting"><CheckCircle aria-hidden="true" /> Предупреждений: {validation.warnings.length}</Text>
          </HStack>
          <Table<SetupStep> data={steps} columns={setupStepColumns(setTab)} idKey="id" density="compact" hasHover />
          <section className="admin-definition-list">
            <DefinitionRow label="Услуги / посты / записи" value={`${detail.counts.services} / ${detail.counts.resources} / ${detail.counts.appointments}`} />
            <DefinitionRow label="Открытых дней в неделю" value={String(config.openingHours.length)} />
            <DefinitionRow label="Публичная страница" value={bookable ? publicUrl : 'недоступна до публикации (черновик)'} />
          </section>
          <FindingList title="Блокирующие ошибки" items={validation.errors} tone="error" onFix={setTab} />
          <FindingList title="Предупреждения" items={validation.warnings} tone="warning" />
          <FindingList title="Справка" items={validation.info} tone="info" />
        </VStack>
      </section>

      <BrandingSection
        tenantId={tenantId}
        config={config}
        onSaved={refresh}
        onNotice={setNotice}
        hidden={tab !== 'branding'}
      />

      <ServicesSection
        tenantId={tenantId}
        currency={config.currency}
        services={services}
        resources={resources}
        catalogReady={!servicesQuery.isLoading && !resourcesQuery.isLoading}
        isError={servicesQuery.isError || resourcesQuery.isError}
        error={servicesQuery.error ?? resourcesQuery.error}
        onSaved={refresh}
        onNotice={setNotice}
        hidden={tab !== 'services'}
      />

      <ResourcesSection
        tenantId={tenantId}
        resources={resources}
        overrides={overridesQuery.data ?? []}
        isLoading={resourcesQuery.isLoading || overridesQuery.isLoading}
        onSaved={refresh}
        onNotice={setNotice}
        hidden={tab !== 'resources'}
      />

      <PublicationSection
        tenantId={tenantId}
        config={config}
        detail={detail}
        validation={validation}
        publicUrl={publicUrl}
        bookable={bookable}
        lifecyclePending={lifecycleMutation.isPending}
        onPublish={() => lifecycleMutation.mutate({kind: 'publish', id: newRequestId()})}
        onAskActivate={() => { setActivateRequestId(newRequestId()); setActivateOpen(true); }}
        onDownload={() => void downloadExport()}
        onNotice={setNotice}
        onSaved={refresh}
        onGoTab={setTab}
        hidden={tab !== 'publication'}
      />

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

function useProfileSaver(tenantId: string, onSaved: () => Promise<void>, onNotice: (notice: Notice) => void) {
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

function BrandingSection({config, tenantId, onSaved, onNotice, hidden}: {
  config: BusinessJson;
  tenantId: string;
  onSaved: () => Promise<void>;
  onNotice: (notice: Notice) => void;
  hidden: boolean;
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
  const requiredMissing = [
    name.trim().length < 2 ? 'название' : null,
    !city.trim() ? 'город' : null,
    !address.trim() ? 'адрес' : null,
    !phone.trim() ? 'телефон' : null,
  ].filter(Boolean);

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Оформление и профиль" hidden={hidden}>
      <VStack gap={4}>
        <section>
          <Heading level={2}>Обязательное для запуска</Heading>
          <Text type="supporting" color="secondary">
            {requiredMissing.length === 0 ? <CheckCircle aria-hidden="true" /> : <WarningCircle aria-hidden="true" />}{' '}
            {requiredMissing.length === 0 ? 'Всё обязательное заполнено.' : `Осталось: ${requiredMissing.join(', ')}.`}
          </Text>
          <section className="field-grid two-column">
            <label className="field"><small>Название</small><input value={name} onChange={(event) => { setName(event.currentTarget.value); touch(); }} required minLength={2} /></label>
            <label className="field"><small>Город</small><input value={city} onChange={(event) => { setCity(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Адрес</small><input value={address} onChange={(event) => { setAddress(event.currentTarget.value); touch(); }} /></label>
            <label className="field"><small>Телефон</small><input value={phone} onChange={(event) => { setPhone(event.currentTarget.value); touch(); }} /></label>
          </section>
        </section>

        <section>
          <Heading level={3}>Дополнительно</Heading>
          <Text type="supporting" color="secondary">Можно заполнить позже — публикации не мешают, но нужны до выхода в эфир.</Text>
          <section className="field-grid two-column">
            <label className="field"><small>Короткий заголовок</small><input value={tagline} onChange={(event) => { setTagline(event.currentTarget.value); touch(); }} /></label>
            <label className="field two-column-span"><small>Описание</small><textarea value={description} onChange={(event) => { setDescription(event.currentTarget.value); touch(); }} /></label>
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
          <Heading level={3}>Еженедельный график (обязательно: хотя бы один день)</Heading>
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
          <Heading level={3}>Галерея (необязательно)</Heading>
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

function emptyService(): {slug: string; name: string; description: string; category: string; price: string; duration: string; before: string; after: string; resourceTypes: string; active: boolean} {
  return {slug: '', name: '', description: '', category: 'Услуга', price: '', duration: '60', before: '0', after: '0', resourceTypes: 'any', active: true};
}

function parseTypes(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function ServicesSection({tenantId, currency, services, resources, catalogReady, isError, error, onSaved, onNotice, hidden}: {
  tenantId: string;
  currency: string;
  services: AdminServiceRow[];
  resources: AdminResourceRow[];
  catalogReady: boolean;
  isError: boolean;
  error: unknown;
  onSaved: () => Promise<void>;
  onNotice: (notice: Notice) => void;
  hidden: boolean;
}) {
  const [form, setForm] = useState(emptyService());
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [typesTouched, setTypesTouched] = useState(false);
  const mutation = useMutation({
    mutationFn: (service: Record<string, unknown>) => saveAdminService(tenantId, service),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Услуга сохранена. Исторические цены записей не меняются.'});
      setForm(emptyService());
      setEditingSlug(null);
      setTypesTouched(false);
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить услугу.'}),
  });
  const createPostMutation = useMutation({
    mutationFn: (types: string[]) => {
      const draft = deriveResourceDraft(types, resources.map((resource) => resource.slug));
      return saveAdminResource(tenantId, {slug: draft.slug, name: draft.name, resourceType: draft.resourceType, active: true}).then(() => draft);
    },
    onSuccess: async (draft) => {
      onNotice({kind: 'success', text: `Пост «${draft.name}» создан и подходит услуге. Сохраните услугу.`});
      await onSaved();
    },
    onError: (caught) => onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось создать пост.'}),
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
      resourceTypes: parseTypes(form.resourceTypes),
      active: form.active,
    });
  };

  const startEdit = (row: AdminServiceRow) => {
    setEditingSlug(row.slug);
    setTypesTouched(true);
    setForm({
      slug: row.slug, name: row.name, description: row.description, category: row.category,
      price: String(row.priceMinor / 100), duration: String(row.durationMinutes),
      before: String(row.bufferBeforeMinutes), after: String(row.bufferAfterMinutes),
      resourceTypes: row.resourceTypes.join(', '), active: row.active,
    });
  };
  const cancelEdit = () => {
    setEditingSlug(null);
    setTypesTouched(false);
    setForm(emptyService());
  };

  const types = parseTypes(form.resourceTypes);
  const pristine = editingSlug === null && !typesTouched && form.name === '' && form.slug === '' && form.description === '';
  // Preselect: a fresh form on a studio with exactly one compatible post (or
  // an 'any' post, which matches the default) points at it right away.
  if (pristine && catalogReady && resources.length > 0 && form.resourceTypes === 'any') {
    const {suggestion} = suggestServiceResourceTypes(['any'], resources);
    if (suggestion && suggestion.join(', ') !== 'any') {
      setForm({...form, resourceTypes: suggestion.join(', ')});
    }
  }
  const compat = catalogReady ? suggestServiceResourceTypes(types.length > 0 ? types : ['any'], resources) : {compatible: [] as AdminResourceRow[], suggestion: null as string[] | null};
  const noCompatiblePost = catalogReady && types.length > 0 && compat.compatible.length === 0;

  const slugError = form.slug.trim() ? validateSlug(form.slug) : null;
  const valid = form.slug.trim().length > 0 && !slugError && form.name.trim().length > 0 && types.length > 0;

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Услуги студии" hidden={hidden}>
      <VStack gap={3}>
        <Heading level={2}>Услуги</Heading>
        <Text type="supporting" color="secondary">Цены в {currency}. Изменение услуги не переписывает цены уже созданных записей.</Text>
        {isError ? <Banner status="error" title="Не удалось загрузить каталог" description={error instanceof Error ? error.message : 'Попробуйте позже.'} /> : null}
        {!catalogReady ? <Text type="supporting" color="secondary" role="status">Загружаем услуги…</Text> : null}
        {catalogReady && services.length === 0 ? <EmptyState title="Услуг нет" description="Добавьте первую услугу — без неё публикация заблокирована." /> : null}
        {services.length > 0 ? <Table<AdminServiceRow> data={services} columns={serviceEditColumns(startEdit)} idKey="id" density="compact" hasHover /> : null}
        <section className="form-panel">
          <Heading level={3}>{editingSlug ? `Изменить: ${editingSlug}` : 'Новая услуга'}</Heading>
          <section className="field-grid two-column">
            <label className="field"><small>Название</small><input value={form.name} onChange={(event) => setForm({...form, name: event.currentTarget.value})} required /></label>
            <label className="field">
              <small>Slug услуги</small>
              <input
                value={form.slug}
                onChange={(event) => setForm({...form, slug: normalizeSlugInput(event.currentTarget.value)})}
                required
                disabled={editingSlug !== null}
                aria-describedby="service-slug-hint"
              />
            </label>
            <Text type="supporting" color="secondary" id="service-slug-hint">{SLUG_FORMAT_HINT}{editingSlug !== null ? ' Slug услуги нельзя изменить.' : ''}</Text>
            {slugError ? <p className="form-error" role="alert">{slugError}</p> : null}
            <label className="field"><small>Описание</small><input value={form.description} onChange={(event) => setForm({...form, description: event.currentTarget.value})} /></label>
            <label className="field"><small>Категория</small><input value={form.category} onChange={(event) => setForm({...form, category: event.currentTarget.value})} /></label>
            <label className="field"><small>Цена ({currency})</small><input value={form.price} onChange={(event) => setForm({...form, price: event.currentTarget.value})} type="number" min="0" step="0.01" /></label>
            <label className="field"><small>Длительность, минут</small><input value={form.duration} onChange={(event) => setForm({...form, duration: event.currentTarget.value})} type="number" min="1" /></label>
            <label className="field"><small>Буфер до, минут</small><input value={form.before} onChange={(event) => setForm({...form, before: event.currentTarget.value})} type="number" min="0" /></label>
            <label className="field"><small>Буфер после, минут</small><input value={form.after} onChange={(event) => setForm({...form, after: event.currentTarget.value})} type="number" min="0" /></label>
            <label className="field"><small>Типы постов через запятую</small><input value={form.resourceTypes} onChange={(event) => setForm({...form, resourceTypes: event.currentTarget.value})} onBlur={() => setTypesTouched(true)} /></label>
            <label className="field checkbox-field"><input checked={form.active} onChange={(event) => setForm({...form, active: event.currentTarget.checked})} type="checkbox" /><small>Доступна для записи</small></label>
          </section>

          <section className="admin-compat" aria-live="polite">
            <Text type="supporting" color="secondary">
              Пост подходит услуге, когда его тип совпадает с одним из типов услуги. Тип «any» с любой стороны означает «работает со всеми».
            </Text>
            {catalogReady && types.length > 0 && compat.compatible.length > 0 ? (
              <Text type="supporting"><CheckCircle aria-hidden="true" /> Эту услугу смогут выполнять: {compat.compatible.map((resource) => resource.name).join(', ')}.</Text>
            ) : null}
            {noCompatiblePost ? (
              <Banner
                status="warning"
                title="Нет подходящего поста"
                description={`Ни один активный пост не подходит типам «${types.join(', ')}». Создайте подходящий пост в один клик — или измените типы.`}
              />
            ) : null}
            {noCompatiblePost ? (
              <Button
                label="Создать подходящий пост"
                variant="secondary"
                size="sm"
                isLoading={createPostMutation.isPending}
                onClick={() => createPostMutation.mutate(types)}
              />
            ) : null}
          </section>

          <HStack gap={2}>
            <Button label={editingSlug ? 'Сохранить услугу' : 'Добавить услугу'} variant="primary" size="sm" isLoading={mutation.isPending} isDisabled={!valid} onClick={submit} />
            {editingSlug ? <Button label="Отмена" variant="ghost" size="sm" onClick={cancelEdit} /> : null}
          </HStack>
        </section>
      </VStack>
    </section>
  );
}

function ResourcesSection({tenantId, resources, overrides, isLoading, onSaved, onNotice, hidden}: {
  tenantId: string;
  resources: AdminResourceRow[];
  overrides: AdminDateOverrideRow[];
  isLoading: boolean;
  onSaved: () => Promise<void>;
  onNotice: (notice: Notice) => void;
  hidden: boolean;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [resourceType, setResourceType] = useState('any');
  const [location, setLocation] = useState('');
  const [active, setActive] = useState(true);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [localDate, setLocalDate] = useState('');
  const [isClosed, setIsClosed] = useState(true);
  const [opensAt, setOpensAt] = useState('09:00');
  const [closesAt, setClosesAt] = useState('19:00');
  const [label, setLabel] = useState('');

  const resetResourceForm = () => {
    setName(''); setSlug(''); setSlugTouched(false); setResourceType('any'); setLocation(''); setActive(true); setEditingSlug(null);
  };
  const startEdit = (row: AdminResourceRow) => {
    setEditingSlug(row.slug);
    setName(row.name);
    setSlug(row.slug);
    setSlugTouched(true);
    setResourceType(row.resourceType || 'any');
    setLocation(row.location ?? '');
    setActive(row.active);
  };

  const resourceMutation = useMutation({
    mutationFn: (resource: Record<string, unknown>) => saveAdminResource(tenantId, resource),
    onSuccess: async () => {
      onNotice({kind: 'success', text: 'Пост сохранён.'});
      resetResourceForm();
      await onSaved();
    },
    onError: async (caught) => {
      // The post itself was saved; only the new `location` field was dropped
      // by an older server. Refresh so the list shows the truth, and warn.
      const body = caught instanceof Error && 'body' in caught ? (caught as AdminApiError).body : null;
      if (body && typeof body === 'object' && (body as {locationDropped?: boolean}).locationDropped === true) {
        onNotice({kind: 'warning', text: caught instanceof Error ? caught.message : 'Пост сохранён без места.'});
        resetResourceForm();
        await onSaved();
        return;
      }
      onNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить пост.'});
    },
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

  const onNameChange = (value: string) => {
    setName(value);
    if (!slugTouched && editingSlug === null) setSlug(suggestSlug(value));
  };
  const slugError = slug.trim() ? validateSlug(slug) : null;
  const locationError = location.trim().length > 120 ? 'Место — не длиннее 120 символов.' : null;
  const canSaveResource = name.trim().length > 0 && slug.trim().length > 0 && !slugError && !locationError && resourceType.trim().length > 0;

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Ресурсы и часы" hidden={hidden}>
      <VStack gap={4}>
        <section>
          <Heading level={2}>Рабочие посты</Heading>
          <Text type="supporting" color="secondary">У каждой bookable-услуги должен быть хотя бы один совместимый активный пост: совпадение типа или any с любой стороны.</Text>
          {isLoading ? <Text type="supporting" color="secondary" role="status">Загружаем…</Text> : null}
          {resources.length > 0 ? (
            <VStack gap={2}>
              <Table<AdminResourceRow> data={resources} columns={resourceTableColumns()} idKey="id" density="compact" hasHover />
              <HStack gap={2}>
                {resources.map((resource) => (
                  <Button key={resource.id} label={`Править: ${resource.name}`} size="sm" variant="ghost" onClick={() => startEdit(resource)} />
                ))}
              </HStack>
            </VStack>
          ) : <EmptyState title="Постов нет" description="Добавьте первый пост — без него услуги нельзя опубликовать." />}
          <section className="form-panel">
            <Heading level={3}>{editingSlug ? `Изменить: ${editingSlug}` : 'Новый пост'}</Heading>
            <section className="field-grid two-column">
              <label className="field">
                <small>Название поста</small>
                <input value={name} onChange={(event) => onNameChange(event.currentTarget.value)} required placeholder="Например, Пост детейлинга" />
              </label>
              <label className="field">
                <small>Slug поста</small>
                <input
                  value={slug}
                  onChange={(event) => { setSlugTouched(true); setSlug(normalizeSlugInput(event.currentTarget.value)); }}
                  required
                  disabled={editingSlug !== null}
                  aria-describedby="resource-slug-hint"
                />
              </label>
              <Text type="supporting" color="secondary" id="resource-slug-hint">{SLUG_FORMAT_HINT}{editingSlug !== null ? ' Slug поста нельзя изменить.' : ' Подставим из названия, можно исправить.'}</Text>
              {slugError ? <p className="form-error" role="alert">{slugError}</p> : null}
              <label className="field"><small>Тип поста</small><input value={resourceType} onChange={(event) => setResourceType(event.currentTarget.value)} required placeholder="any" /></label>
              <label className="field">
                <small>Место (необязательно)</small>
                <input value={location} onChange={(event) => setLocation(event.currentTarget.value)} maxLength={120} placeholder="Например, Пост № 2" />
              </label>
              {locationError ? <p className="form-error" role="alert">{locationError}</p> : null}
              <label className="field checkbox-field"><input checked={active} onChange={(event) => setActive(event.currentTarget.checked)} type="checkbox" /><small>Активен и принимает записи</small></label>
            </section>
            <HStack gap={2}>
              <Button
                label={editingSlug ? 'Сохранить пост' : 'Добавить пост'}
                variant="secondary"
                size="sm"
                isLoading={resourceMutation.isPending}
                isDisabled={!canSaveResource}
                onClick={() => resourceMutation.mutate({slug: slug.trim().toLowerCase(), name: name.trim(), resourceType: resourceType.trim(), location: location.trim(), active})}
              />
              {editingSlug ? <Button label="Отмена" variant="ghost" size="sm" onClick={resetResourceForm} /> : null}
            </HStack>
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

type ChecklistRow = {id: string; done: boolean; label: string; actionLabel: string | null; action: (() => void) | null};

const CHECKLIST_COLUMNS: Array<TableColumn<ChecklistRow>> = [
  {
    key: 'id',
    header: 'Готовность',
    width: proportional(1, {minWidth: 110}),
    renderCell: (row) => (
      <Text type="supporting">{row.done ? <CheckCircle aria-hidden="true" /> : <WarningCircle aria-hidden="true" />} {row.done ? 'Готово' : 'Нужно'}</Text>
    ),
  },
  {key: 'label', header: 'Требование', width: proportional(2, {minWidth: 170})},
];

function checklistColumns(): Array<TableColumn<ChecklistRow>> {
  return [
    ...CHECKLIST_COLUMNS,
    {
      key: 'actionLabel',
      header: '',
      width: proportional(1, {minWidth: 130}),
      renderCell: (row) => (row.action && row.actionLabel ? <Button label={row.actionLabel} size="sm" variant="ghost" onClick={row.action} /> : <Text type="supporting">—</Text>),
    },
  ];
}

function PublicationSection({tenantId, config, detail, validation, publicUrl, bookable, lifecyclePending, onPublish, onAskActivate, onDownload, onNotice, onSaved, onGoTab, hidden}: {
  tenantId: string;
  config: BusinessJson;
  detail: AdminTenantDetail;
  validation: ValidationReport;
  publicUrl: string;
  bookable: boolean;
  lifecyclePending: boolean;
  onPublish: () => void;
  onAskActivate: () => void;
  onDownload: () => void;
  onNotice: (notice: Notice) => void;
  onSaved: () => Promise<void>;
  onGoTab: (tab: AdminSetupTab) => void;
  hidden: boolean;
}) {
  const save = useProfileSaver(tenantId, onSaved, onNotice);
  const status = config.status;
  const missingContact = [
    {field: 'название', filled: config.name.trim().length >= 2},
    {field: 'город', filled: config.city.trim().length > 0},
    {field: 'адрес', filled: config.address.trim().length > 0},
    {field: 'телефон', filled: config.phone.trim().length > 0},
  ].filter((item) => !item.filled);

  const rows: ChecklistRow[] = [
    {
      id: 'status',
      done: status === 'preview' || status === 'live',
      label: status === 'live' ? 'Студия уже в эфире.' : status === 'preview' ? 'Предпросмотр пройден — можно готовиться к эфиру.' : 'Сначала опубликуйте черновик в предпросмотр.',
      actionLabel: status === 'draft' && validation.errors.length === 0 ? 'Опубликовать' : null,
      action: status === 'draft' && validation.errors.length === 0 ? onPublish : null,
    },
    {
      id: 'demo',
      done: !config.demo,
      label: config.demo ? 'Демо-режим включён: уведомления отключены, в эфир с ним нельзя.' : 'Демо-режим выключен.',
      actionLabel: config.demo ? 'Выключить демо' : null,
      action: config.demo ? () => save.mutate({isDemo: false}) : null,
    },
    {
      id: 'contacts',
      done: missingContact.length === 0,
      label: missingContact.length === 0 ? 'Контакты заполнены: название, город, адрес, телефон.' : `Заполните контакты: ${missingContact.map((item) => item.field).join(', ')}.`,
      actionLabel: missingContact.length === 0 ? null : 'Заполнить',
      action: missingContact.length === 0 ? null : () => onGoTab('branding'),
    },
    {
      id: 'validation',
      done: validation.errors.length === 0,
      label: validation.errors.length === 0 ? 'Блокирующих ошибок проверки нет.' : `Блокирующих ошибок: ${validation.errors.length} — исправьте каждую.`,
      actionLabel: validation.errors.length === 0 ? null : 'К ошибкам',
      action: validation.errors.length === 0 ? null : () => onGoTab('overview'),
    },
  ];

  return (
    <section className="admin-tab-panel" role="tabpanel" aria-label="Публикация студии" hidden={hidden}>
      <VStack gap={3}>
        <Heading level={2}>Публикация</Heading>
        <section className="admin-definition-list">
          <DefinitionRow label="Статус" value={visibilityLabel(detail.tenant.visibility)} />
          <DefinitionRow label="Страница студии" value={bookable ? publicUrl : 'появится после публикации'} />
          <DefinitionRow label="Демо-режим" value={config.demo ? 'Включён (уведомления отключены; в live нельзя)' : 'Выключен'} />
        </section>

        <Heading level={3}>Подготовить к активации</Heading>
        <Text type="supporting" color="secondary">Каждый пункт решается прямо здесь — без тихой активации: кнопка «Активировать» ниже всегда спрашивает подтверждение, а сервер проверяет всё заново.</Text>
        <Table<ChecklistRow> data={rows} columns={checklistColumns()} idKey="id" density="compact" hasHover />
        <FindingList title="Блокирующие ошибки" items={validation.errors} tone="error" onFix={onGoTab} />
        <FindingList title="Предупреждения" items={validation.warnings} tone="warning" />

        <HStack gap={2}>
          <Button
            label="Опубликовать (в предпросмотр)"
            variant="primary"
            icon={<RocketLaunch aria-hidden="true" />}
            isDisabled={status !== 'draft' || lifecyclePending}
            isLoading={lifecyclePending}
            onClick={onPublish}
          />
          <Button
            label="Активировать (в эфир)"
            variant="secondary"
            isDisabled={status !== 'preview' || lifecyclePending}
            isLoading={lifecyclePending}
            onClick={onAskActivate}
          />
          <Button label="Скачать business.json" variant="ghost" icon={<DownloadSimple aria-hidden="true" />} onClick={onDownload} />
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
  );
}
