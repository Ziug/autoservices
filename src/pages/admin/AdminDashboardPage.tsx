import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowRight, Plus} from '@phosphor-icons/react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Skeleton} from '@astryxdesign/core/Skeleton';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {auditActionLabel, getAdminDashboard} from '@/lib/admin-api';
import {money} from '@/lib/format';

function formatDateTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

/**
 * Dashboard shows ONLY computable metrics: tenant totals by visibility,
 * upcoming appointments in the server's 7-day window, RECORDED payment sums
 * over the last 30 days, and the latest audit events. No forecasts.
 */
export function AdminDashboardPage() {
  const dashboardQuery = useQuery({queryKey: ['admin-dashboard'], queryFn: getAdminDashboard, staleTime: 30_000});

  if (dashboardQuery.isLoading) {
    return (
      <VStack gap={4} className="admin-page" aria-busy="true" aria-label="Загружаем показатели">
        <AdminAreaHeading title="Обзор" description="Показатели платформы." />
        <VStack gap={2} className="admin-skeleton-stack">
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </VStack>
      </VStack>
    );
  }

  if (dashboardQuery.isError) {
    return (
      <VStack gap={4} className="admin-page">
        <AdminAreaHeading title="Обзор" description="Показатели платформы." />
        <Banner
          status="error"
          title="Не удалось загрузить показатели"
          description={dashboardQuery.error instanceof Error ? dashboardQuery.error.message : 'Попробуйте обновить страницу.'}
        />
        <HStack gap={2}>
          <Button label="Повторить" variant="secondary" onClick={() => void dashboardQuery.refetch()} />
        </HStack>
      </VStack>
    );
  }

  const metrics = dashboardQuery.data;
  if (!metrics) {
    return (
      <VStack gap={4} className="admin-page">
        <AdminAreaHeading title="Обзор" description="Показатели платформы." />
        <Banner status="error" title="Нет данных" description="Показатели недоступны. Попробуйте обновить страницу." />
        <HStack gap={2}>
          <Button label="Повторить" variant="secondary" onClick={() => void dashboardQuery.refetch()} />
        </HStack>
      </VStack>
    );
  }

  const tenantCards = [
    {label: 'Всего студий', value: String(metrics.tenants.total), filter: 'all'},
    {label: 'В эфире (live)', value: String(metrics.tenants.live), filter: 'live'},
    {label: 'Предпросмотр (preview)', value: String(metrics.tenants.preview), filter: 'preview'},
    {label: 'Приостановлены', value: String(metrics.tenants.suspended), filter: 'suspended'},
    {label: 'В архиве', value: String(metrics.tenants.archived), filter: 'archived'},
  ];
  const paymentCards = [
    {label: 'Получено (записано)', value: money(metrics.payments30d.grossMinor, 'RUB')},
    {label: 'Возвраты (записано)', value: money(metrics.payments30d.refundMinor, 'RUB')},
    {label: 'Итого чистыми (записано)', value: money(metrics.payments30d.netMinor, 'RUB')},
  ];

  return (
    <VStack gap={4} className="admin-page">
      <AdminAreaHeading title="Обзор" description="Только вычисляемые показатели: студии, записи и записанные оплаты." />

      <HStack gap={2}>
        <Button label="Создать студию" variant="primary" icon={<Plus aria-hidden="true" />} href={adminUrl('tenants', 'new')} />
      </HStack>

      <VStack gap={2}>
        <Heading level={2}>Студии</Heading>
        <section className="admin-kpi-grid admin-kpi-grid-5">
          {tenantCards.map((card) => (
            <Card key={card.label}>
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  {card.label}
                </Text>
                <p className="admin-kpi-value">{card.value}</p>
                <Link className="admin-link" to={`${adminUrl('tenants')}?status=${card.filter}`} aria-label={`${card.label} — открыть список`}>
                  Открыть список <ArrowRight aria-hidden="true" />
                </Link>
              </VStack>
            </Card>
          ))}
        </section>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Записи</Heading>
        <section className="admin-kpi-grid">
          <Card>
            <VStack gap={1}>
              <Text type="supporting" color="secondary">
                Предстоящие записи (7 дней)
              </Text>
              <p className="admin-kpi-value">{metrics.upcoming7d}</p>
            </VStack>
          </Card>
        </section>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Оплаты</Heading>
        <Text type="supporting" color="secondary">
          Суммы из журнала оплат за последние 30 дней. Прогнозов нет — только записанные операции.
        </Text>
        <section className="admin-kpi-grid">
          {paymentCards.map((card) => (
            <Card key={card.label}>
              <VStack gap={1}>
                <Text type="supporting" color="secondary">
                  {card.label}
                </Text>
                <p className="admin-kpi-value">{card.value}</p>
              </VStack>
            </Card>
          ))}
        </section>
      </VStack>

      <VStack gap={2}>
        <Heading level={2}>Последние события</Heading>
        {metrics.recentAudit.length === 0 ? (
          <EmptyState title="Событий пока нет" description="Административные действия появятся здесь." />
        ) : null}
        {metrics.recentAudit.map((entry) => (
          <Text key={entry.id} type="supporting">
            {formatDateTime(entry.createdAt)} · {auditActionLabel(entry.action)}
            {entry.reason ? ` · ${entry.reason}` : ''}
          </Text>
        ))}
      </VStack>

      {metrics.tenants.total === 0 ? (
        <EmptyState title="Студий пока нет" description="Когда появятся студии, их показатели будут здесь." />
      ) : null}
    </VStack>
  );
}
