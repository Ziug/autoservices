import {useState} from 'react';
import {Link} from 'react-router-dom';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {VStack} from '@astryxdesign/core/Stack';
import {Pagination} from '@astryxdesign/core/Pagination';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {auditActionLabel, listAudit, type AdminAuditEntry} from '@/lib/admin-api';

const PAGE_SIZE = 20;

function formatDateTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function shortId(value: string | null): string {
  if (!value) return '—';
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

const COLUMNS: Array<TableColumn<AdminAuditEntry>> = [
  {key: 'createdAt', header: 'Время', width: proportional(1, {minWidth: 110}), renderCell: (row) => <Text type="supporting">{formatDateTime(row.createdAt)}</Text>},
  {key: 'action', header: 'Действие', width: proportional(1, {minWidth: 120}), renderCell: (row) => <Text type="supporting">{auditActionLabel(row.action)}</Text>},
  {
    key: 'tenantId',
    header: 'Студия',
    width: proportional(1, {minWidth: 120}),
    renderCell: (row) =>
      row.tenantId ? (
        <Link className="admin-link" to={adminUrl('tenants', row.tenantId)} aria-label="Открыть карточку студии">
          {shortId(row.tenantId)}
        </Link>
      ) : (
        <Text type="supporting">—</Text>
      ),
  },
  {key: 'reason', header: 'Причина', width: proportional(2, {minWidth: 140}), renderCell: (row) => <Text type="supporting">{row.reason || '—'}</Text>},
  {
    key: 'success',
    header: 'Итог',
    width: proportional(1, {minWidth: 90}),
    renderCell: (row) => <Badge variant={row.success ? 'success' : 'error'} label={row.success ? 'Успех' : 'Ошибка'} />,
  },
];

/** Platform-wide append-only audit history with server pagination. */
export function AuditPage() {
  const [page, setPage] = useState(1);
  const auditQuery = useQuery({
    queryKey: ['admin-audit', page],
    queryFn: () => listAudit({page, pageSize: PAGE_SIZE}),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const entries = auditQuery.data?.entries ?? [];
  const total = auditQuery.data?.total ?? 0;

  return (
    <VStack gap={4} className="admin-page">
      <AdminAreaHeading title="Журнал" description="Все административные действия платформы: входы, приостановки, архивация." />

      {auditQuery.isError ? (
        <Banner
          status="error"
          title="Не удалось загрузить журнал"
          description={auditQuery.error instanceof Error ? auditQuery.error.message : 'Попробуйте обновить страницу.'}
        />
      ) : null}

      {auditQuery.isSuccess && entries.length === 0 ? (
        <EmptyState title="Событий пока нет" description="Административные действия появятся здесь." />
      ) : null}

      {entries.length > 0 ? (
        <VStack gap={2}>
          <Text type="supporting" color="secondary" role="status">
            Событий: {total}
          </Text>
          <Table<AdminAuditEntry>
            data={entries}
            columns={COLUMNS}
            idKey="id"
            density="compact"
            hasHover
            rowIndexStart={(page - 1) * PAGE_SIZE + 1}
            rowCount={total}
          />
          <Pagination page={page} onChange={setPage} totalItems={total} pageSize={PAGE_SIZE} variant="compact" size="sm" label="Страницы журнала" />
        </VStack>
      ) : null}
    </VStack>
  );
}
