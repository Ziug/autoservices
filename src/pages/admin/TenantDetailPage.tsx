import {useState} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Archive, ArrowCounterClockwise, ArrowSquareOut, PauseCircle, PlayCircle} from '@phosphor-icons/react';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Pagination} from '@astryxdesign/core/Pagination';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {TabList, Tab} from '@astryxdesign/core/TabList';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Layout, LayoutContent} from '@astryxdesign/core/Layout';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {
  archiveTenant,
  getTenantDetail,
  listAudit,
  listResources,
  listServices,
  listTenantAppointments,
  listTenantPayments,
  newRequestId,
  reactivateTenant,
  suspendTenant,
  unarchiveTenant,
  type AdminAppointmentRow,
  type AdminAuditEntry,
  type AdminPaymentRow,
  type AdminResourceRow,
  type AdminServiceRow,
  type AdminTenantDetail,
} from '@/lib/admin-api';
import {money} from '@/lib/format';

const TABS = [
  {value: 'overview', label: 'Обзор'},
  {value: 'appointments', label: 'Записи'},
  {value: 'services', label: 'Услуги'},
  {value: 'resources', label: 'Ресурсы и часы'},
  {value: 'payments', label: 'Оплаты'},
  {value: 'settings', label: 'Настройки'},
  {value: 'audit', label: 'Журнал'},
] as const;

type DetailTab = (typeof TABS)[number]['value'];
type ConfirmKind = 'archive' | 'unarchive';

const PAGE_SIZE = 15;
const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function formatDateTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function statusBadgeVariant(visibility: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
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

function appointmentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    confirmed: 'Ожидает',
    checked_in: 'Принят',
    in_progress: 'В работе',
    completed: 'Готово',
    cancelled: 'Отменена',
    no_show: 'Не приехал',
  };
  return labels[status] ?? status;
}

function appointmentStatusVariant(status: string): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'cancelled' || status === 'no_show') return 'error';
  if (status === 'in_progress') return 'warning';
  return 'info';
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'admin.login': 'Вход',
    'admin.suspend': 'Приостановка',
    'admin.reactivate': 'Возобновление',
    'admin.archive': 'В архив',
    'admin.unarchive': 'Из архива',
    'admin.view': 'Просмотр',
  };
  return labels[action] ?? action;
}

const APPOINTMENT_COLUMNS: Array<TableColumn<AdminAppointmentRow>> = [
  {key: 'startsAt', header: 'Начало', width: proportional(1, {minWidth: 110}), renderCell: (row) => <Text type="supporting">{formatDateTime(row.startsAt)}</Text>},
  {key: 'customerName', header: 'Клиент', width: proportional(1, {minWidth: 120})},
  {key: 'serviceName', header: 'Услуга', width: proportional(1, {minWidth: 120})},
  {
    key: 'status',
    header: 'Статус',
    width: proportional(1, {minWidth: 100}),
    renderCell: (row) => <Badge variant={appointmentStatusVariant(row.status)} label={appointmentStatusLabel(row.status)} />,
  },
  {key: 'priceMinor', header: 'Сумма', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{(row.priceMinor / 100).toLocaleString('ru-RU')}</Text>},
];

const SERVICE_COLUMNS: Array<TableColumn<AdminServiceRow>> = [
  {key: 'name', header: 'Название', width: proportional(2, {minWidth: 140})},
  {key: 'category', header: 'Категория', width: proportional(1, {minWidth: 100})},
  {key: 'priceMinor', header: 'Цена', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{money(row.priceMinor, 'RUB')}</Text>},
  {key: 'active', header: 'Статус', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.active ? 'Активна' : 'Скрыта'}</Text>},
];

const RESOURCE_COLUMNS: Array<TableColumn<AdminResourceRow>> = [
  {key: 'name', header: 'Пост', width: proportional(1, {minWidth: 120})},
  {key: 'resourceType', header: 'Тип', width: proportional(1, {minWidth: 90})},
  {key: 'active', header: 'Статус', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.active ? 'Активен' : 'Отключён'}</Text>},
];

const PAYMENT_COLUMNS: Array<TableColumn<AdminPaymentRow>> = [
  {key: 'receivedAt', header: 'Получен', width: proportional(1, {minWidth: 110}), renderCell: (row) => <Text type="supporting">{formatDateTime(row.receivedAt)}</Text>},
  {key: 'kind', header: 'Вид', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{row.kind === 'refund' ? 'Возврат' : 'Оплата'}</Text>},
  {key: 'amountMinor', header: 'Сумма', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{money(row.amountMinor, 'RUB')}</Text>},
  {key: 'method', header: 'Способ', width: proportional(1, {minWidth: 80})},
];

const AUDIT_COLUMNS: Array<TableColumn<AdminAuditEntry>> = [
  {key: 'createdAt', header: 'Время', width: proportional(1, {minWidth: 110}), renderCell: (row) => <Text type="supporting">{formatDateTime(row.createdAt)}</Text>},
  {key: 'action', header: 'Действие', width: proportional(1, {minWidth: 120}), renderCell: (row) => <Text type="supporting">{auditActionLabel(row.action)}</Text>},
  {key: 'reason', header: 'Причина', width: proportional(2, {minWidth: 140}), renderCell: (row) => <Text type="supporting">{row.reason || '—'}</Text>},
  {
    key: 'success',
    header: 'Итог',
    width: proportional(1, {minWidth: 90}),
    renderCell: (row) => <Badge variant={row.success ? 'success' : 'error'} label={row.success ? 'Успех' : 'Ошибка'} />,
  },
];

const CONFIRM_COPY: Record<ConfirmKind, {title: string; description: string; actionLabel: string; actionVariant: 'destructive' | 'primary'}> = {
  archive: {
    title: 'Отправить студию в архив?',
    description: 'Запись остановится, страница станет недоступна. Архив можно отменить позже.',
    actionLabel: 'В архив',
    actionVariant: 'destructive',
  },
  unarchive: {
    title: 'Вернуть студию из архива?',
    description: 'Студия вернётся в приостановленное состояние; затем её можно возобновить.',
    actionLabel: 'Вернуть из архива',
    actionVariant: 'primary',
  },
};

function DefinitionRow({label, value}: {label: string; value: string}) {
  return (
    <section className="admin-definition-row">
      <small>{label}</small>
      <p>{value}</p>
    </section>
  );
}

/** Tenant detail: tabbed overview, bookings, catalog, payments, read-only settings, audit + lifecycle actions. */
export function TenantDetailPage() {
  const {tenantId = ''} = useParams();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>('overview');
  const [appointmentsPage, setAppointmentsPage] = useState(1);
  const [paymentsPage, setPaymentsPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState('');
  const [reactivateOpen, setReactivateOpen] = useState(false);
  const [targetStatus, setTargetStatus] = useState<'preview' | 'live'>('preview');
  const [confirmKind, setConfirmKind] = useState<ConfirmKind | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [requestId, setRequestId] = useState('');
  const [notice, setNotice] = useState<{kind: 'success' | 'error'; text: string} | null>(null);

  const detailQuery = useQuery({queryKey: ['admin-tenant', tenantId], queryFn: () => getTenantDetail(tenantId), enabled: Boolean(tenantId), staleTime: 15_000});
  const servicesQuery = useQuery({
    queryKey: ['admin-tenant-services', tenantId],
    queryFn: () => listServices(tenantId),
    enabled: Boolean(tenantId) && (tab === 'services' || tab === 'appointments'),
    staleTime: 30_000,
  });
  const resourcesQuery = useQuery({
    queryKey: ['admin-tenant-resources', tenantId],
    queryFn: () => listResources(tenantId),
    enabled: Boolean(tenantId) && tab === 'resources',
    staleTime: 30_000,
  });
  const appointmentsQuery = useQuery({
    queryKey: ['admin-tenant-appointments', tenantId, appointmentsPage],
    queryFn: () => listTenantAppointments(tenantId, appointmentsPage, PAGE_SIZE),
    enabled: Boolean(tenantId) && tab === 'appointments',
    staleTime: 15_000,
  });
  const paymentsQuery = useQuery({
    queryKey: ['admin-tenant-payments', tenantId, paymentsPage],
    queryFn: () => listTenantPayments(tenantId, paymentsPage, PAGE_SIZE),
    enabled: Boolean(tenantId) && tab === 'payments',
    staleTime: 15_000,
  });
  const auditQuery = useQuery({
    queryKey: ['admin-tenant-audit', tenantId, auditPage],
    queryFn: () => listAudit({tenantId, page: auditPage, pageSize: PAGE_SIZE}),
    enabled: Boolean(tenantId) && tab === 'audit',
    staleTime: 15_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({queryKey: ['admin-tenant', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-tenants']});
    await queryClient.invalidateQueries({queryKey: ['admin-tenant-audit', tenantId]});
    await queryClient.invalidateQueries({queryKey: ['admin-audit']});
    await queryClient.invalidateQueries({queryKey: ['admin-dashboard']});
    await queryClient.invalidateQueries({predicate: (query) => String(query.queryKey[0]).startsWith('admin-tenant-')});
  };

  const lifecycleMutation = useMutation({
    mutationFn: async ({kind, reason, target, id}: {kind: 'suspend' | 'reactivate' | ConfirmKind; reason?: string; target?: 'preview' | 'live'; id: string}) => {
      if (kind === 'suspend') return suspendTenant(tenantId, reason ?? '', id);
      if (kind === 'reactivate') return reactivateTenant(tenantId, target ?? 'preview', id);
      if (kind === 'archive') return archiveTenant(tenantId, id, reason);
      return unarchiveTenant(tenantId, id);
    },
    onSuccess: async () => {
      setNotice({kind: 'success', text: 'Изменение сохранено и записано в журнал.'});
      setSuspendOpen(false);
      setReactivateOpen(false);
      setConfirmKind(null);
      setSuspendReason('');
      setArchiveReason('');
      await refresh();
    },
    onError: (caught) => setNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить изменение.'}),
  });

  const openSuspend = () => {
    setRequestId(newRequestId());
    setSuspendReason('');
    setNotice(null);
    setSuspendOpen(true);
  };

  const openReactivate = () => {
    setRequestId(newRequestId());
    setTargetStatus('preview');
    setNotice(null);
    setReactivateOpen(true);
  };

  const openConfirm = (kind: ConfirmKind) => {
    setRequestId(newRequestId());
    setArchiveReason('');
    setNotice(null);
    setConfirmKind(kind);
  };

  if (detailQuery.isLoading) {
    return (
      <VStack gap={3} className="admin-page" aria-busy="true" aria-label="Загружаем карточку студии">
        <AdminAreaHeading title="Карточка студии" description="Загружаем данные." />
        <TabList value={tab} onChange={(value) => setTab(value as DetailTab)}>
          {TABS.map((item) => (
            <Tab key={item.value} value={item.value} label={item.label} />
          ))}
        </TabList>
      </VStack>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <VStack gap={4} className="admin-page">
        <AdminAreaHeading title="Карточка студии" description="Данные студии." />
        <Banner
          status="error"
          title="Не удалось загрузить студию"
          description={detailQuery.error instanceof Error ? detailQuery.error.message : 'Попробуйте обновить страницу.'}
        />
        <HStack gap={2}>
          <Button label="Повторить" variant="secondary" onClick={() => void detailQuery.refetch()} />
          <Button label="К списку студий" variant="ghost" href={adminUrl('tenants')} />
        </HStack>
      </VStack>
    );
  }

  const detail: AdminTenantDetail = detailQuery.data;
  const {tenant} = detail;
  const confirmCopy = confirmKind ? CONFIRM_COPY[confirmKind] : null;
  const serviceNames = new Map((servicesQuery.data ?? []).map((service) => [service.id, service.name]));
  const appointments = (appointmentsQuery.data?.appointments ?? []).map((row) => ({
    ...row,
    serviceName: serviceNames.get(row.serviceId) ?? '—',
  }));

  return (
    <VStack gap={4} className="admin-page">
      <header className="admin-page-head">
        <section className="admin-page-head-copy">
          <Heading level={1}>{tenant.name}</Heading>
          <Text color="secondary">
            {tenant.city} · {tenant.slug}
          </Text>
          <HStack gap={2}>
            <Badge variant={statusBadgeVariant(tenant.visibility)} label={visibilityLabel(tenant.visibility)} />
          </HStack>
        </section>
        <section className="admin-actions" aria-label="Действия со студией">
          {tenant.visibility === 'draft' || tenant.visibility === 'preview' ? (
            <Button label="Настройка и публикация" variant="primary" icon={<ArrowSquareOut aria-hidden="true" />} href={adminUrl('tenants', tenant.id, 'setup')} />
          ) : null}
          {!tenant.suspended && !tenant.archived ? (
            <Button label="Приостановить" variant="secondary" icon={<PauseCircle aria-hidden="true" />} onClick={openSuspend} />
          ) : null}
          {tenant.suspended && !tenant.archived ? (
            <Button label="Возобновить" variant="primary" icon={<PlayCircle aria-hidden="true" />} onClick={openReactivate} />
          ) : null}
          {!tenant.archived ? (
            <Button label="В архив" variant="destructive" icon={<Archive aria-hidden="true" />} onClick={() => openConfirm('archive')} />
          ) : (
            <Button label="Из архива" variant="secondary" icon={<ArrowCounterClockwise aria-hidden="true" />} onClick={() => openConfirm('unarchive')} />
          )}
        </section>
      </header>

      {notice ? (
        <Banner status={notice.kind} title={notice.kind === 'success' ? 'Готово' : 'Не удалось сохранить'} description={notice.text} isDismissable onDismiss={() => setNotice(null)} />
      ) : null}

      <section className="admin-tab-scroll">
        <TabList value={tab} onChange={(value) => setTab(value as DetailTab)} hasDivider>
          {TABS.map((item) => (
            <Tab key={item.value} value={item.value} label={item.label} />
          ))}
        </TabList>
      </section>

      {tab === 'overview' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Обзор студии">
          <VStack gap={2}>
            <Heading level={2}>Состояние</Heading>
            <section className="admin-definition-list">
              <DefinitionRow label="Статус" value={visibilityLabel(tenant.visibility)} />
              <DefinitionRow label="Причина приостановки" value={tenant.suspendReason || '—'} />
              <DefinitionRow label="Приостановлена" value={formatDateTime(tenant.suspendedAt ?? '')} />
              <DefinitionRow label="В архиве с" value={formatDateTime(tenant.archivedAt ?? '')} />
              <DefinitionRow label="Услуг / постов / записей" value={`${detail.counts.services} / ${detail.counts.resources} / ${detail.counts.appointments}`} />
              <DefinitionRow label="Записано оплат чистыми" value={money(detail.payments.netMinor, 'RUB')} />
              <DefinitionRow label="Изменена" value={formatDateTime(tenant.updatedAt)} />
              <DefinitionRow label="Создана" value={formatDateTime(tenant.createdAt)} />
            </section>
          </VStack>
        </section>
      ) : null}

      {tab === 'appointments' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Записи студии">
          <Heading level={2}>Записи</Heading>
          {appointmentsQuery.isError ? (
            <Banner status="error" title="Не удалось загрузить записи" description={appointmentsQuery.error instanceof Error ? appointmentsQuery.error.message : 'Попробуйте позже.'} />
          ) : null}
          {appointmentsQuery.data && appointments.length === 0 ? (
            <EmptyState title="Записей нет" description="У этой студии пока нет записей." />
          ) : null}
          {appointments.length > 0 ? (
            <VStack gap={2}>
              <Table<AdminAppointmentRow>
                data={appointments}
                columns={APPOINTMENT_COLUMNS}
                idKey="id"
                density="compact"
                hasHover
                rowIndexStart={(appointmentsPage - 1) * PAGE_SIZE + 1}
                rowCount={appointmentsQuery.data?.total ?? appointments.length}
              />
              <Pagination
                page={appointmentsPage}
                onChange={setAppointmentsPage}
                totalItems={appointmentsQuery.data?.total ?? appointments.length}
                pageSize={PAGE_SIZE}
                variant="compact"
                size="sm"
                label="Страницы записей"
              />
            </VStack>
          ) : null}
        </section>
      ) : null}

      {tab === 'services' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Услуги студии">
          <Heading level={2}>Услуги</Heading>
          {servicesQuery.isError ? (
            <Banner status="error" title="Не удалось загрузить услуги" description={servicesQuery.error instanceof Error ? servicesQuery.error.message : 'Попробуйте позже.'} />
          ) : null}
          {servicesQuery.data && servicesQuery.data.length === 0 ? <EmptyState title="Услуг нет" description="Прайс этой студии пуст." /> : null}
          {servicesQuery.data && servicesQuery.data.length > 0 ? (
            <Table<AdminServiceRow> data={servicesQuery.data} columns={SERVICE_COLUMNS} idKey="id" density="compact" hasHover />
          ) : null}
        </section>
      ) : null}

      {tab === 'resources' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Ресурсы и часы работы">
          <Heading level={2}>Ресурсы и часы</Heading>
          {resourcesQuery.isError ? (
            <Banner status="error" title="Не удалось загрузить посты" description={resourcesQuery.error instanceof Error ? resourcesQuery.error.message : 'Попробуйте позже.'} />
          ) : null}
          {resourcesQuery.data && resourcesQuery.data.length === 0 ? <EmptyState title="Постов нет" description="Рабочие посты не настроены." /> : null}
          {resourcesQuery.data && resourcesQuery.data.length > 0 ? (
            <Table<AdminResourceRow> data={resourcesQuery.data} columns={RESOURCE_COLUMNS} idKey="id" density="compact" hasHover />
          ) : null}
          <VStack gap={1}>
            <Heading level={3}>Часы работы</Heading>
            {tenant.openingHours.length === 0 ? (
              <Text type="supporting" color="secondary">
                График не задан.
              </Text>
            ) : null}
            {tenant.openingHours.map((hours) => (
              <Text key={hours.weekday} type="supporting">
                {WEEKDAYS[hours.weekday] ?? `День ${hours.weekday}`}: {hours.opensAt}–{hours.closesAt}
              </Text>
            ))}
          </VStack>
        </section>
      ) : null}

      {tab === 'payments' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Оплаты студии">
          <Heading level={2}>Оплаты</Heading>
          <Text type="supporting" color="secondary">
            Только записанные операции из журнала: получено {money(paymentsQuery.data ? paymentsQuery.data.grossMinor : detail.payments.grossMinor, 'RUB')}, возвраты{' '}
            {money(paymentsQuery.data ? paymentsQuery.data.refundMinor : detail.payments.refundMinor, 'RUB')}, чистыми{' '}
            {money(paymentsQuery.data ? paymentsQuery.data.netMinor : detail.payments.netMinor, 'RUB')}.
          </Text>
          {paymentsQuery.isError ? (
            <Banner status="error" title="Не удалось загрузить оплаты" description={paymentsQuery.error instanceof Error ? paymentsQuery.error.message : 'Попробуйте позже.'} />
          ) : null}
          {paymentsQuery.data && paymentsQuery.data.payments.length === 0 ? <EmptyState title="Оплат нет" description="Записанных операций пока нет." /> : null}
          {paymentsQuery.data && paymentsQuery.data.payments.length > 0 ? (
            <VStack gap={2}>
              <Table<AdminPaymentRow>
                data={paymentsQuery.data.payments}
                columns={PAYMENT_COLUMNS}
                idKey="id"
                density="compact"
                hasHover
                rowIndexStart={(paymentsPage - 1) * PAGE_SIZE + 1}
                rowCount={paymentsQuery.data.total}
              />
              <Pagination page={paymentsPage} onChange={setPaymentsPage} totalItems={paymentsQuery.data.total} pageSize={PAGE_SIZE} variant="compact" size="sm" label="Страницы оплат" />
            </VStack>
          ) : null}
        </section>
      ) : null}

      {tab === 'settings' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Настройки студии">
          <Heading level={2}>Настройки</Heading>
          <Text type="supporting" color="secondary">
            Только чтение: изменения вносит владелец в своём кабинете.
          </Text>
          <section className="admin-definition-list">
            <DefinitionRow label="Название" value={tenant.name} />
            <DefinitionRow label="Адрес" value={tenant.slug} />
            <DefinitionRow label="Город" value={tenant.city || '—'} />
            <DefinitionRow label="Телефон" value={tenant.phone || '—'} />
            <DefinitionRow label="Статус" value={visibilityLabel(tenant.visibility)} />
            <DefinitionRow label="Демо" value={tenant.isDemo ? 'Да' : 'Нет'} />
          </section>
        </section>
      ) : null}

      {tab === 'audit' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Журнал действий">
          <Heading level={2}>Журнал</Heading>
          {auditQuery.isError ? (
            <Banner status="error" title="Не удалось загрузить журнал" description={auditQuery.error instanceof Error ? auditQuery.error.message : 'Попробуйте позже.'} />
          ) : null}
          {auditQuery.data && auditQuery.data.entries.length === 0 ? <EmptyState title="Событий нет" description="Действия по этой студии ещё не записывались." /> : null}
          {auditQuery.data && auditQuery.data.entries.length > 0 ? (
            <VStack gap={2}>
              <Table<AdminAuditEntry>
                data={auditQuery.data.entries}
                columns={AUDIT_COLUMNS}
                idKey="id"
                density="compact"
                hasHover
                rowIndexStart={(auditPage - 1) * PAGE_SIZE + 1}
                rowCount={auditQuery.data.total}
              />
              <Pagination page={auditPage} onChange={setAuditPage} totalItems={auditQuery.data.total} pageSize={PAGE_SIZE} variant="compact" size="sm" label="Страницы журнала" />
            </VStack>
          ) : null}
        </section>
      ) : null}

      <Link className="admin-link" to={adminUrl('tenants')}>
        К списку студий
      </Link>

      <Dialog isOpen={suspendOpen} onOpenChange={setSuspendOpen} purpose="form" width={480}>
        <Layout
          header={<DialogHeader title="Приостановить студию" onOpenChange={setSuspendOpen} />}
          content={
            <LayoutContent>
              <VStack gap={3}>
                <Text type="supporting" color="secondary">
                  Запись остановится сразу, страница станет недоступна для клиентов. Причина обязательна — она попадёт в журнал.
                </Text>
                <label className="admin-field">
                  <small>Причина приостановки</small>
                  <textarea
                    required
                    maxLength={500}
                    placeholder="Например, жалоба клиента, проверка документов"
                    value={suspendReason}
                    onChange={(event) => setSuspendReason(event.currentTarget.value)}
                    aria-label="Причина приостановки"
                  />
                </label>
                <HStack gap={2}>
                  <Button label="Отмена" variant="ghost" onClick={() => setSuspendOpen(false)} />
                  <Button
                    label="Приостановить"
                    variant="destructive"
                    isLoading={lifecycleMutation.isPending}
                    isDisabled={suspendReason.trim().length < 5}
                    onClick={() => lifecycleMutation.mutate({kind: 'suspend', reason: suspendReason, id: requestId || newRequestId()})}
                  />
                </HStack>
              </VStack>
            </LayoutContent>
          }
        />
      </Dialog>

      <Dialog isOpen={reactivateOpen} onOpenChange={setReactivateOpen} purpose="form" width={480}>
        <Layout
          header={<DialogHeader title="Возобновить работу студии?" onOpenChange={setReactivateOpen} />}
          content={
            <LayoutContent>
              <VStack gap={3}>
                <Text type="supporting" color="secondary">
                  Студия снова станет доступна для записи. Демо-студии можно вернуть только в предпросмотр.
                </Text>
                <label className="admin-field admin-field-select">
                  <small>Целевой статус</small>
                  <select value={targetStatus} onChange={(event) => setTargetStatus(event.currentTarget.value as 'preview' | 'live')} aria-label="Целевой статус студии">
                    <option value="preview">Preview — предпросмотр</option>
                    <option value="live">Live — в эфире</option>
                  </select>
                </label>
                <HStack gap={2}>
                  <Button label="Отмена" variant="ghost" onClick={() => setReactivateOpen(false)} />
                  <Button
                    label="Возобновить"
                    variant="primary"
                    isLoading={lifecycleMutation.isPending}
                    onClick={() => lifecycleMutation.mutate({kind: 'reactivate', target: targetStatus, id: requestId || newRequestId()})}
                  />
                </HStack>
              </VStack>
            </LayoutContent>
          }
        />
      </Dialog>

      {confirmKind === 'archive' ? (
        <Dialog isOpen onOpenChange={(open) => { if (!open) setConfirmKind(null); }} purpose="form" width={480}>
          <Layout
            header={<DialogHeader title={CONFIRM_COPY.archive.title} onOpenChange={(open) => { if (!open) setConfirmKind(null); }} />}
            content={
              <LayoutContent>
                <VStack gap={3}>
                  <Text type="supporting" color="secondary">{CONFIRM_COPY.archive.description}</Text>
                  <label className="admin-field">
                    <small>Причина архивации (необязательно)</small>
                    <textarea
                      maxLength={500}
                      placeholder="Например, договор расторгнут"
                      value={archiveReason}
                      onChange={(event) => setArchiveReason(event.currentTarget.value)}
                      aria-label="Причина архивации"
                    />
                  </label>
                  <HStack gap={2}>
                    <Button label="Отмена" variant="ghost" onClick={() => setConfirmKind(null)} />
                    <Button
                      label={CONFIRM_COPY.archive.actionLabel}
                      variant="destructive"
                      isLoading={lifecycleMutation.isPending}
                      onClick={() => lifecycleMutation.mutate({kind: 'archive', reason: archiveReason, id: requestId || newRequestId()})}
                    />
                  </HStack>
                </VStack>
              </LayoutContent>
            }
          />
        </Dialog>
      ) : null}
      {confirmKind === 'unarchive' && confirmCopy ? (
        <AlertDialog
          isOpen
          onOpenChange={(open) => {
            if (!open) setConfirmKind(null);
          }}
          title={confirmCopy.title}
          description={confirmCopy.description}
          actionLabel={confirmCopy.actionLabel}
          actionVariant={confirmCopy.actionVariant}
          cancelLabel="Отмена"
          isActionLoading={lifecycleMutation.isPending}
          onAction={() => {
            lifecycleMutation.mutate({kind: confirmKind, id: requestId || newRequestId()});
          }}
        />
      ) : null}
    </VStack>
  );
}
