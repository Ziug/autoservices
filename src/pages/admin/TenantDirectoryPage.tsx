import {useEffect, useState} from 'react';
import {Link, useSearchParams} from 'react-router-dom';
import {keepPreviousData, useQuery} from '@tanstack/react-query';
import {ArrowCounterClockwise, Plus} from '@phosphor-icons/react';
import {Badge} from '@astryxdesign/core/Badge';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Pagination} from '@astryxdesign/core/Pagination';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {listTenants, type AdminTenantFilter, type AdminTenantRow, type AdminTenantVisibility} from '@/lib/admin-api';

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const STATUS_FILTERS: Array<{value: AdminTenantFilter; label: string}> = [
  {value: 'all', label: 'Все'},
  {value: 'live', label: 'Live'},
  {value: 'preview', label: 'Preview'},
  {value: 'suspended', label: 'Приостановлены'},
  {value: 'archived', label: 'В архиве'},
  {value: 'draft', label: 'Черновики'},
];

function statusBadgeVariant(visibility: AdminTenantVisibility): 'success' | 'info' | 'warning' | 'error' | 'neutral' {
  if (visibility === 'live') return 'success';
  if (visibility === 'preview') return 'info';
  if (visibility === 'suspended') return 'warning';
  if (visibility === 'archived') return 'error';
  return 'neutral';
}

function statusLabel(visibility: AdminTenantVisibility): string {
  if (visibility === 'live') return 'Live';
  if (visibility === 'preview') return 'Preview';
  if (visibility === 'suspended') return 'Приостановлена';
  if (visibility === 'archived') return 'В архиве';
  return 'Черновик';
}

function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', {day: 'numeric', month: 'short', year: 'numeric'});
}

const COLUMNS: Array<TableColumn<AdminTenantRow>> = [
  {
    key: 'name',
    header: 'Студия',
    width: proportional(2, {minWidth: 160}),
    renderCell: (row) => (
      <Link className="admin-link" to={adminUrl('tenants', row.id)} aria-label={`${row.name} — открыть карточку`}>
        {row.name}
      </Link>
    ),
  },
  {key: 'city', header: 'Город', width: proportional(1, {minWidth: 100})},
  {key: 'phone', header: 'Телефон', width: proportional(1, {minWidth: 120})},
  {
    key: 'visibility',
    header: 'Статус',
    width: proportional(1, {minWidth: 110}),
    renderCell: (row) => <Badge variant={statusBadgeVariant(row.visibility)} label={statusLabel(row.visibility)} />,
  },
  {key: 'updatedAt', header: 'Изменена', width: proportional(1, {minWidth: 110}), renderCell: (row) => <Text type="supporting">{formatDate(row.updatedAt)}</Text>},
];

/** Server-driven directory: search, status filter, pagination. Order is server-side (recently updated first). */
export function TenantDirectoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '');
  const [appliedQuery, setAppliedQuery] = useState(searchParams.get('q') ?? '');
  const rawStatus = searchParams.get('status');
  const status: AdminTenantFilter = STATUS_FILTERS.some((option) => option.value === rawStatus)
    ? (rawStatus as AdminTenantFilter)
    : 'all';
  const page = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
  const pageSize = PAGE_SIZE_OPTIONS.includes(Number(searchParams.get('pageSize'))) ? Number(searchParams.get('pageSize')) : 20;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAppliedQuery(searchInput);
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (searchInput) next.set('q', searchInput);
          else next.delete('q');
          next.set('page', '1');
          return next;
        },
        {replace: true},
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput, setSearchParams]);

  const directoryQuery = useQuery({
    queryKey: ['admin-tenants', appliedQuery, status, page, pageSize],
    queryFn: () => listTenants({search: appliedQuery, status, limit: pageSize, offset: (page - 1) * pageSize}),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });

  const updateParams = (patch: Record<string, string>) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      {replace: true},
    );
  };

  const tenants = directoryQuery.data?.tenants ?? [];
  const total = directoryQuery.data?.total ?? 0;

  return (
    <VStack gap={4} className="admin-page">
      <AdminAreaHeading title="Студии" description="Поиск и фильтр по статусу выполняются на сервере. Порядок: сначала недавно изменённые." />

      <section className="admin-actions" aria-label="Действия со списком">
        <Button label="Создать студию" variant="primary" icon={<Plus aria-hidden="true" />} href={adminUrl('tenants', 'new')} />
      </section>

      <section className="admin-toolbar" aria-label="Поиск и фильтры">
        <label className="admin-field admin-field-search">
          <small>Поиск по названию или адресу</small>
          <input
            type="search"
            autoComplete="off"
            placeholder="Например, graphite"
            value={searchInput}
            onChange={(event) => setSearchInput(event.currentTarget.value)}
            aria-label="Поиск студий"
          />
        </label>
        <label className="admin-field admin-field-select">
          <small>Статус</small>
          <select value={status} onChange={(event) => updateParams({status: event.currentTarget.value === 'all' ? '' : event.currentTarget.value, page: '1'})} aria-label="Фильтр по статусу">
            {STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {directoryQuery.isError ? (
        <Banner
          status="error"
          title="Не удалось загрузить список"
          description={directoryQuery.error instanceof Error ? directoryQuery.error.message : 'Попробуйте обновить страницу.'}
        />
      ) : null}

      {directoryQuery.isSuccess && tenants.length === 0 ? (
        <EmptyState
          title="Ничего не найдено"
          description="Измените запрос или сбросьте фильтры, чтобы увидеть больше студий."
          actions={
            <Button
              label="Сбросить фильтры"
              variant="secondary"
              icon={<ArrowCounterClockwise aria-hidden="true" />}
              onClick={() => {
                setSearchInput('');
                setSearchParams({}, {replace: true});
              }}
            />
          }
        />
      ) : null}

      {tenants.length > 0 ? (
        <VStack gap={2}>
          <Text type="supporting" color="secondary" role="status">
            Найдено: {total}
          </Text>
          <Table<AdminTenantRow>
            data={tenants}
            columns={COLUMNS}
            idKey="id"
            density="compact"
            hasHover
            rowIndexStart={(page - 1) * pageSize + 1}
            rowCount={total}
          />
          <section className="admin-pagination-row">
            <label className="admin-field admin-field-select">
              <small>На странице</small>
              <select value={String(pageSize)} onChange={(event) => updateParams({pageSize: event.currentTarget.value, page: '1'})} aria-label="Студий на странице">
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <Pagination page={page} onChange={(next) => updateParams({page: String(next)})} totalItems={total} pageSize={pageSize} variant="compact" size="sm" label="Страницы студий" />
          </section>
        </VStack>
      ) : null}

      {directoryQuery.isLoading ? (
        <VStack gap={2} className="admin-skeleton-stack" aria-busy="true" aria-label="Загружаем студии">
          <Heading level={2}>Загружаем…</Heading>
          <Text type="supporting" color="secondary">
            Получаем список студий с сервера.
          </Text>
        </VStack>
      ) : null}

      {directoryQuery.isFetching && !directoryQuery.isLoading ? (
        <HStack gap={2}>
          <Text type="supporting" color="secondary" role="status">
            Обновляем список…
          </Text>
        </HStack>
      ) : null}
    </VStack>
  );
}
