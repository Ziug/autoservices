import {useState} from 'react';
import {Link, useParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Archive, ArrowCounterClockwise, ArrowSquareOut, PauseCircle, PlayCircle} from '@phosphor-icons/react';
import {AlertDialog} from '@astryxdesign/core/AlertDialog';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
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
  createOwner,
  deleteOwner,
  getTenantDetail,
  listAudit,
  listOwners,
  listResources,
  listServices,
  listTenantAppointments,
  listTenantPayments,
  newRequestId,
  reactivateTenant,
  suspendTenant,
  unarchiveTenant,
  updateOwner,
  type AdminAppointmentRow,
  type AdminAuditEntry,
  type AdminOwnerRow,
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
  {value: 'owners', label: 'Владельцы'},
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
  const [ownerLogin, setOwnerLogin] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerRole, setOwnerRole] = useState<'owner' | 'manager'>('owner');
  const [ownerNotice, setOwnerNotice] = useState<{kind: 'success' | 'error'; text: string} | null>(null);
  const [passwordFor, setPasswordFor] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [contactFor, setContactFor] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactRole, setContactRole] = useState<'owner' | 'manager' | 'staff'>('owner');
  const [deleteFor, setDeleteFor] = useState('');

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
  const ownersQuery = useQuery({
    queryKey: ['admin-tenant-owners', tenantId],
    queryFn: () => listOwners(tenantId),
    enabled: Boolean(tenantId) && tab === 'owners',
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

  const ownerMutation = useMutation({
    mutationFn: async (input:
      | {kind: 'create'}
      | {kind: 'password'; username: string}
      | {kind: 'contact'; username: string}
      | {kind: 'delete'; username: string}) => {
      if (input.kind === 'create') {
        return createOwner({
          tenantId,
          username: ownerLogin,
          password: ownerPassword,
          recoveryEmail: ownerEmail.trim() || undefined,
          role: ownerRole,
          requestId: newRequestId(),
        });
      }
      if (input.kind === 'password') return updateOwner(tenantId, input.username, {password: passwordValue});
      if (input.kind === 'contact') {
        return updateOwner(tenantId, input.username, {recoveryEmail: contactEmail.trim(), role: contactRole});
      }
      return deleteOwner(tenantId, input.username, newRequestId());
    },
    onSuccess: async (result, input) => {
      if (result && typeof result === 'object' && 'deduped' in result && result.deduped) {
        setOwnerNotice({kind: 'success', text: 'Повтор уже учтён: доступ уже создан ранее.'});
      } else if (input.kind === 'create') {
        setOwnerNotice({kind: 'success', text: `Доступ создан: логин ${ownerLogin.trim().toLowerCase()}. Передайте его владельцу вместе с паролем.`});
        setOwnerLogin('');
        setOwnerPassword('');
        setOwnerEmail('');
      } else if (input.kind === 'password') {
        setOwnerNotice({kind: 'success', text: `Новый пароль для ${input.username} сохранён. Передайте его владельцу.`});
        setPasswordFor('');
        setPasswordValue('');
      } else if (input.kind === 'contact') {
        setOwnerNotice({kind: 'success', text: `Контакты ${input.username} обновлены.`});
        setContactFor('');
      } else {
        setOwnerNotice({kind: 'success', text: `Доступ ${input.username} удалён.`});
        setDeleteFor('');
      }
      await queryClient.invalidateQueries({queryKey: ['admin-tenant-owners', tenantId]});
      await queryClient.invalidateQueries({queryKey: ['admin-tenant-audit', tenantId]});
    },
    onError: (caught) => setOwnerNotice({kind: 'error', text: caught instanceof Error ? caught.message : 'Не удалось сохранить доступ.'}),
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

      {tab === 'owners' ? (
        <section className="admin-tab-panel" role="tabpanel" aria-label="Доступы владельцев">
          <Heading level={2}>Владельцы</Heading>
          <Text type="supporting" color="secondary">
            Доступ создаётся только здесь: логин и пароль. Почта необязательна — она нужна лишь чтобы связаться с владельцем
            (например, передать новый пароль). Для входа почта не используется.
          </Text>
          {ownerNotice ? (
            <Banner
              status={ownerNotice.kind}
              title={ownerNotice.kind === 'success' ? 'Готово' : 'Не удалось сохранить'}
              description={ownerNotice.text}
              isDismissable
              onDismiss={() => setOwnerNotice(null)}
            />
          ) : null}
          <VStack gap={2}>
            <Heading level={3}>Новый доступ</Heading>
            <form
              className="admin-form"
              onSubmit={(event) => {
                event.preventDefault();
                setOwnerNotice(null);
                ownerMutation.mutate({kind: 'create'});
              }}
            >
              <section className="admin-grid-2">
                <label className="admin-field">
                  <small>Логин (3–32: a-z, 0–9, точка, _, -)</small>
                  <input
                    autoComplete="off"
                    maxLength={32}
                    placeholder="naprimer-studio"
                    value={ownerLogin}
                    onChange={(event) => setOwnerLogin(event.currentTarget.value)}
                    aria-label="Логин владельца"
                    required
                  />
                </label>
                <label className="admin-field">
                  <small>Пароль (минимум 8 символов)</small>
                  <input
                    autoComplete="new-password"
                    minLength={8}
                    type="password"
                    value={ownerPassword}
                    onChange={(event) => setOwnerPassword(event.currentTarget.value)}
                    aria-label="Пароль владельца"
                    required
                  />
                </label>
                <label className="admin-field">
                  <small>Почта для связи (необязательно)</small>
                  <input
                    autoComplete="off"
                    placeholder="owner@example.com"
                    type="email"
                    value={ownerEmail}
                    onChange={(event) => setOwnerEmail(event.currentTarget.value)}
                    aria-label="Почта владельца для связи"
                  />
                </label>
                <label className="admin-field admin-field-select">
                  <small>Роль</small>
                  <select value={ownerRole} onChange={(event) => setOwnerRole(event.currentTarget.value as 'owner' | 'manager')} aria-label="Роль владельца">
                    <option value="owner">Владелец</option>
                    <option value="manager">Управляющий</option>
                  </select>
                </label>
              </section>
              <Button
                label="Создать доступ"
                type="submit"
                variant="primary"
                isLoading={ownerMutation.isPending}
                isDisabled={!ownerLogin.trim() || ownerPassword.length < 8}
              />
            </form>
          </VStack>
          <VStack gap={2}>
            <Heading level={3}>Выданные доступы</Heading>
            {ownersQuery.isError ? (
              <Banner
                status="error"
                title="Не удалось загрузить доступы"
                description={ownersQuery.error instanceof Error ? ownersQuery.error.message : 'Попробуйте позже.'}
              />
            ) : null}
            {ownersQuery.data && ownersQuery.data.length === 0 ? (
              <EmptyState title="Доступов нет" description="Создайте первый доступ выше — владелец войдёт по логину и паролю." />
            ) : null}
            {(ownersQuery.data ?? []).map((owner: AdminOwnerRow) => (
              <Card key={owner.username}>
                <VStack gap={2}>
                  <HStack gap={2}>
                    <Text>
                      <strong>{owner.username}</strong> · {owner.role}
                    </Text>
                  </HStack>
                  <Text type="supporting" color="secondary">
                    Почта для связи: {owner.recoveryEmail || '—'}
                  </Text>
                  {passwordFor === owner.username ? (
                    <form
                      className="admin-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        ownerMutation.mutate({kind: 'password', username: owner.username});
                      }}
                    >
                      <label className="admin-field">
                        <small>Новый пароль (минимум 8 символов)</small>
                        <input
                          autoComplete="new-password"
                          minLength={8}
                          type="password"
                          value={passwordValue}
                          onChange={(event) => setPasswordValue(event.currentTarget.value)}
                          aria-label={`Новый пароль для ${owner.username}`}
                          required
                        />
                      </label>
                      <HStack gap={2}>
                        <Button label="Отмена" variant="ghost" onClick={() => { setPasswordFor(''); setPasswordValue(''); }} />
                        <Button
                          label="Сохранить пароль"
                          type="submit"
                          variant="primary"
                          isLoading={ownerMutation.isPending}
                          isDisabled={passwordValue.length < 8}
                        />
                      </HStack>
                    </form>
                  ) : contactFor === owner.username ? (
                    <form
                      className="admin-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        ownerMutation.mutate({kind: 'contact', username: owner.username});
                      }}
                    >
                      <section className="admin-grid-2">
                        <label className="admin-field">
                          <small>Почта для связи (пусто — убрать)</small>
                          <input
                            autoComplete="off"
                            type="email"
                            value={contactEmail}
                            onChange={(event) => setContactEmail(event.currentTarget.value)}
                            aria-label={`Почта для ${owner.username}`}
                          />
                        </label>
                        <label className="admin-field admin-field-select">
                          <small>Роль</small>
                          <select
                            value={contactRole}
                            onChange={(event) => setContactRole(event.currentTarget.value as 'owner' | 'manager' | 'staff')}
                            aria-label={`Роль для ${owner.username}`}
                          >
                            <option value="owner">Владелец</option>
                            <option value="manager">Управляющий</option>
                            <option value="staff">Сотрудник</option>
                          </select>
                        </label>
                      </section>
                      <HStack gap={2}>
                        <Button label="Отмена" variant="ghost" onClick={() => setContactFor('')} />
                        <Button label="Сохранить" type="submit" variant="primary" isLoading={ownerMutation.isPending} />
                      </HStack>
                    </form>
                  ) : deleteFor === owner.username ? (
                    <HStack gap={2}>
                      <Text type="supporting">Удалить доступ {owner.username} без возможности восстановления?</Text>
                      <Button label="Отмена" variant="ghost" onClick={() => setDeleteFor('')} />
                      <Button
                        label="Удалить"
                        variant="destructive"
                        isLoading={ownerMutation.isPending}
                        onClick={() => ownerMutation.mutate({kind: 'delete', username: owner.username})}
                      />
                    </HStack>
                  ) : (
                    <HStack gap={2}>
                      <Button
                        label="Новый пароль"
                        variant="secondary"
                        onClick={() => { setContactFor(''); setDeleteFor(''); setPasswordFor(owner.username); setPasswordValue(''); setOwnerNotice(null); }}
                      />
                      <Button
                        label="Почта и роль"
                        variant="secondary"
                        onClick={() => {
                          setPasswordFor(''); setDeleteFor(''); setContactFor(owner.username);
                          setContactEmail(owner.recoveryEmail); setContactRole((owner.role as 'owner' | 'manager' | 'staff') ?? 'owner');
                          setOwnerNotice(null);
                        }}
                      />
                      <Button
                        label="Удалить"
                        variant="ghost"
                        onClick={() => { setPasswordFor(''); setContactFor(''); setDeleteFor(owner.username); setOwnerNotice(null); }}
                      />
                    </HStack>
                  )}
                </VStack>
              </Card>
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
