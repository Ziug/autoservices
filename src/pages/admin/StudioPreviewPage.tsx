import {Link, useParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowSquareOut} from '@phosphor-icons/react';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Table, proportional, type TableColumn} from '@astryxdesign/core/Table';
import {Heading, Text} from '@astryxdesign/core/Text';
import {AdminAreaHeading} from '@/pages/admin/AdminLayout';
import {adminUrl} from '@/lib/admin-config';
import {exportTenant} from '@/lib/admin-api';
import {money} from '@/lib/format';

const WEEKDAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

type PreviewService = {slug: string; name: string; description: string; priceMinor: number; durationMinutes: number; category: string};

const PREVIEW_COLUMNS: Array<TableColumn<PreviewService & Record<string, unknown>>> = [
  {key: 'name', header: 'Услуга', width: proportional(2, {minWidth: 140})},
  {key: 'category', header: 'Категория', width: proportional(1, {minWidth: 90})},
  {key: 'priceMinor', header: 'Цена', width: proportional(1, {minWidth: 90}), renderCell: (row) => <Text type="supporting">{money(Number(row.priceMinor ?? 0), 'RUB')}</Text>},
  {key: 'durationMinutes', header: 'Мин.', width: proportional(1, {minWidth: 70}), renderCell: (row) => <Text type="supporting">{String(row.durationMinutes ?? '—')}</Text>},
];

/**
 * Realistic studio preview rendered from the same DB-backed configuration
 * (export-tenant) that publication uses. Booking is disabled here on
 * purpose: previews must never send notifications or create real bookings.
 */
export function StudioPreviewPage() {
  const {tenantId = ''} = useParams();
  const previewQuery = useQuery({
    queryKey: ['admin-studio-preview', tenantId],
    queryFn: () => exportTenant(tenantId),
    enabled: Boolean(tenantId),
    staleTime: 15_000,
  });

  if (previewQuery.isLoading) {
    return (
      <VStack gap={3} className="admin-page" aria-busy="true" aria-label="Загружаем предпросмотр">
        <AdminAreaHeading title="Предпросмотр" description="Собираем страницу студии." />
      </VStack>
    );
  }

  if (previewQuery.isError || !previewQuery.data) {
    return (
      <VStack gap={4} className="admin-page">
        <AdminAreaHeading title="Предпросмотр" description="Страница студии." />
        <Banner status="error" title="Не удалось собрать предпросмотр" description={previewQuery.error instanceof Error ? previewQuery.error.message : 'Попробуйте обновить страницу.'} />
        <Button label="К настройке" variant="ghost" href={adminUrl('tenants', tenantId, 'setup')} />
      </VStack>
    );
  }

  const config = previewQuery.data as Record<string, unknown>;
  const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
  const services = (Array.isArray(config.services) ? config.services : []) as Array<PreviewService & Record<string, unknown>>;
  const hours = (Array.isArray(config.openingHours) ? config.openingHours : []) as Array<{weekday: number; opensAt: string; closesAt: string}>;
  const gallery = (Array.isArray(config.gallery) ? config.gallery : []) as Array<{id: string; image: string; caption: string}>;
  const status = str(config.status, 'draft');
  const bookable = status === 'preview' || status === 'live';
  const publicUrl = `/s/${str(config.slug)}/`;

  return (
    <VStack gap={4} className="admin-page">
      <AdminAreaHeading title={`Предпросмотр: ${str(config.name, 'Студия')}`} description="Так студию увидят клиенты. Запись здесь отключена." />
      <Banner status="info" title="Режим предпросмотра" description="Оформление, услуги и часы — из реальной конфигурации. Кнопки записи не работают: тестовые брони не создают уведомлений." />
      {bookable ? (
        <HStack gap={2}>
          <Button label="Открыть публичную страницу" variant="secondary" icon={<ArrowSquareOut aria-hidden="true" />} href={publicUrl} />
        </HStack>
      ) : (
        <Text type="supporting" color="secondary">Публичная страница появится после публикации (черновик недоступен для записи).</Text>
      )}

      <section className="admin-preview-hero" aria-label="Шапка студии">
        {str(config.heroImage) ? <img src={str(config.heroImage)} alt="" /> : null}
        <Heading level={2}>{str(config.name)}</Heading>
        {str(config.tagline) ? <Text color="secondary">{str(config.tagline)}</Text> : null}
        <Text type="supporting">{str(config.city)}{str(config.address) ? ` · ${str(config.address)}` : ''}{str(config.phone) ? ` · ${str(config.phone)}` : ''}</Text>
        {str(config.description) ? <Text type="body">{str(config.description)}</Text> : null}
      </section>

      <section aria-label="Услуги">
        <Heading level={3}>Услуги</Heading>
        {services.length > 0 ? (
          <Table data={services} columns={PREVIEW_COLUMNS} idKey="slug" density="compact" />
        ) : (
          <Text type="supporting" color="secondary">Услуг пока нет.</Text>
        )}
      </section>

      <section aria-label="Часы работы">
        <Heading level={3}>Часы работы ({str(config.timezone, '—')})</Heading>
        {hours.length === 0 ? <Text type="supporting" color="secondary">График не задан.</Text> : null}
        {hours.map((row) => (
          <Text key={row.weekday} type="supporting">{WEEKDAYS[row.weekday] ?? `День ${row.weekday}`}: {row.opensAt}–{row.closesAt}</Text>
        ))}
      </section>

      {gallery.length > 0 ? (
        <section aria-label="Галерея">
          <Heading level={3}>Галерея</Heading>
          {gallery.map((photo) => (
            <Text key={photo.id} type="supporting">{photo.caption || photo.image}</Text>
          ))}
        </section>
      ) : null}

      <HStack gap={2}>
        <Button label="К настройке" variant="secondary" href={adminUrl('tenants', tenantId, 'setup')} />
        <Link className="admin-link" to={adminUrl('tenants')}>К списку студий</Link>
      </HStack>
    </VStack>
  );
}
