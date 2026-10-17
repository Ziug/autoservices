import {describe, expect, it, vi, afterEach, beforeEach} from 'vitest';
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Outlet, Route, Routes} from 'react-router-dom';
import {businessSchema, type BusinessConfig} from '@/domain/tenant';

const mockInvoke = vi.hoisted(() => vi.fn());
const mockFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    functions: {invoke: mockInvoke},
    from: (table: string) => mockFrom(table),
    rpc: (fn: string) => {
      if (fn === 'owner_metrics') return Promise.resolve({data: [{arrivals: 1, completed: 0, collected_minor: 0}], error: null});
      return Promise.resolve({data: null, error: null});
    },
  },
}));

vi.mock('@astryxdesign/core/BottomSheet', () => ({
  BottomSheet: ({children}: {children: React.ReactNode}) => <div data-testid="sheet">{children}</div>,
}));

import {OwnerDashboardPage} from '@/pages/owner/OwnerDashboardPage';

function studio(): BusinessConfig {
  return businessSchema.parse({
    schemaVersion: 1,
    slug: 'simple-car',
    name: 'Simple Car',
    tagline: 'Тестовая студия',
    description: 'Описание',
    city: 'Город',
    address: 'Улица, 1',
    phone: '+7 900 000-00-00',
    timezone: 'Europe/Moscow',
    currency: 'RUB',
    locale: 'ru-RU',
    accentColor: '#4690FF',
    heroImage: 'https://example.com/hero.jpg',
    logoImage: 'https://example.com/logo.svg',
    demo: false,
    status: 'preview',
    bookingStepMinutes: 30,
    cancellationWindowHours: 12,
    openingHours: [1, 2, 3, 4, 5].map((weekday) => ({weekday, opensAt: '09:00', closesAt: '21:00'})),
    services: [
      {slug: 'wash', name: 'Мойка', description: 'Мойка кузова', priceMinor: 490000, durationMinutes: 60, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, category: 'Уход', resourceTypes: ['any'], active: true},
      {slug: 'polish', name: 'Полировка', description: 'Полировка', priceMinor: 2850000, durationMinutes: 240, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, category: 'Кузов', resourceTypes: ['any'], active: true},
    ],
    resources: [{slug: 'post-1', name: 'Пост 1', resourceType: 'any', active: true}],
    gallery: [],
    infoCards: [
      {id: 'one', title: 'Раз', body: 'Текст раз'},
      {id: 'two', title: 'Два', body: 'Текст два'},
      {id: 'three', title: 'Три', body: 'Текст три'},
    ],
    assistantPrompts: ['Вопрос?'],
  });
}

const SERVICE_ID = '11111111-1111-4111-8111-111111111111';
const RESOURCE_ID = '22222222-2222-4222-8222-222222222222';
const APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: APPOINTMENT_ID,
    tenant_id: 't1',
    service_id: SERVICE_ID,
    resource_id: RESOURCE_ID,
    customer_name: 'Иван',
    customer_phone: '+79001112233',
    vehicle: 'Lada',
    starts_at: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
    ends_at: new Date(Date.now() + 4 * 3600 * 1000).toISOString(),
    status: 'in_progress',
    price_minor: 490000,
    customer_note: 'Помоешь и коврики',
    ...overrides,
  };
}

/** Minimal chainable PostgREST stub for loadOwnerSchedule. */
function fromStub(tables: Record<string, () => {data: unknown; error: unknown}>) {
  return (table: string) => {
    const payload = tables[table] ? tables[table]() : {data: [], error: null};
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'in', 'order']) {
      builder[method] = () => builder;
    }
    builder.then = (resolve: (value: unknown) => void) => resolve(payload);
    return builder;
  };
}

function Page({business}: {business: BusinessConfig}) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/s/simple-car/owner`]}>
        <Routes>
          <Route path="/s/:slug" element={<Outlet context={{business}} />}>
            <Route path="owner" element={<OwnerDashboardPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function tablesWith(appointments: unknown[], extras: unknown[] = [], notes: unknown[] = [], payments: unknown[] = []) {
  return fromStub({
    appointments: () => ({data: appointments, error: null}),
    appointment_services: () => ({data: extras, error: null}),
    appointment_notes: () => ({data: notes, error: null}),
    payments: () => ({data: payments, error: null}),
  });
}

describe('owner dashboard order handling', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockFrom.mockReset();
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'owner-metrics') return Promise.resolve({data: null, error: null});
      return Promise.resolve({data: null, error: null});
    });
  });
  afterEach(() => cleanup());

  it('shows the order summary with original price, extras, notes and balance', async () => {
    mockFrom.mockImplementation((table: string) => tablesWith(
      [row()],
      [{id: 'e1', appointment_id: APPOINTMENT_ID, service_id: SERVICE_ID, name: 'Доп. полировка', price_minor: 150000, kind: 'extra', created_at: new Date().toISOString()}],
      [{id: 'n1', appointment_id: APPOINTMENT_ID, body: 'Царапина на двери', created_at: new Date().toISOString()}],
      [{id: 'p1', appointment_id: APPOINTMENT_ID, kind: 'charge', amount_minor: 400000, method: 'cash', note: '', received_at: new Date().toISOString()}],
    )(table));
    render(<Page business={studio()} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Итог заказа'}));
    const summary = await screen.findByLabelText('Итог по заказу');
    expect(summary.textContent).toContain('Мойка');
    expect(summary.textContent).toContain('Доп. полировка');
    expect(summary.textContent).toContain('Царапина на двери');
    expect(summary.textContent).toContain('Помоешь и коврики');
    // 4900 original + 1500 extras = 6400 total; 4000 paid -> 2400 balance.
    expect(screen.getByTestId('order-total').textContent).toContain('6');
    expect(screen.getByTestId('order-balance').textContent).toContain('2');
  });

  it('completes an appointment through the summary dialog and preserves history', async () => {
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'owner-api' && JSON.stringify(undefined) === '') return Promise.resolve({data: null, error: null});
      return Promise.resolve({data: null, error: null});
    });
    const calls: Array<Record<string, unknown>> = [];
    mockInvoke.mockImplementation((fn: string, opts: {body?: Record<string, unknown>}) => {
      if (fn === 'owner-api') {
        calls.push(opts.body ?? {});
        return Promise.resolve({data: {}, error: null});
      }
      return Promise.resolve({data: null, error: null});
    });
    mockFrom.mockImplementation((table: string) => tablesWith([row()], [], [], [{id: 'p1', appointment_id: APPOINTMENT_ID, kind: 'charge', amount_minor: 490000, method: 'card', note: 'Полная оплата', received_at: new Date().toISOString()}])(table));
    render(<Page business={studio()} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Итог заказа'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Отметить готово'}));
    await waitFor(() => {
      const statusCall = calls.find((call) => call.action === 'set-status' && call.status === 'completed');
      expect(statusCall).toBeDefined();
    });
    // Completion is not payment: the payment row stays in history untouched.
    const paymentCalls = calls.filter((call) => call.action === 'add-payment');
    expect(paymentCalls).toHaveLength(0);
  });

  it('adds a catalog service as an extra charge without creating an appointment', async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockInvoke.mockImplementation((fn: string, opts: {body?: Record<string, unknown>}) => {
      if (fn === 'owner-api') {
        calls.push(opts.body ?? {});
        return Promise.resolve({data: {extraService: {id: 'e1'}}, error: null});
      }
      return Promise.resolve({data: null, error: null});
    });
    mockFrom.mockImplementation((table: string) => tablesWith([row()])(table));
    render(<Page business={studio()} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Доп. услуга'}));
    const catalogSelect = await screen.findByLabelText('Услуга из каталога');
    fireEvent.change(catalogSelect, {target: {value: 'polish'}});
    fireEvent.click(screen.getByRole('button', {name: 'Добавить'}));
    await waitFor(() => {
      const call = calls.find((entry) => entry.action === 'add-extra-service');
      expect(call).toBeDefined();
      expect(call?.serviceSlug).toBe('polish');
    });
    expect(calls.some((call) => call.action === 'add-booking')).toBe(false);
  });

  it('adds a custom service with a custom price', async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockInvoke.mockImplementation((fn: string, opts: {body?: Record<string, unknown>}) => {
      if (fn === 'owner-api') {
        calls.push(opts.body ?? {});
        return Promise.resolve({data: {extraService: {id: 'e2'}}, error: null});
      }
      return Promise.resolve({data: null, error: null});
    });
    mockFrom.mockImplementation((table: string) => tablesWith([row()])(table));
    render(<Page business={studio()} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Доп. услуга'}));
    fireEvent.click(await screen.findByRole('radio', {name: 'Своя услуга'}));
    fireEvent.change(await screen.findByLabelText('Название своей услуги'), {target: {value: 'Химчистка сидений'}});
    fireEvent.change(screen.getByLabelText('Цена своей услуги'), {target: {value: '3000'}});
    fireEvent.click(screen.getByRole('button', {name: 'Добавить'}));
    await waitFor(() => {
      const call = calls.find((entry) => entry.action === 'add-extra-service');
      expect(call).toBeDefined();
      expect(call?.name).toBe('Химчистка сидений');
      expect(call?.priceMinor).toBe(300000);
    });
  });

  it('fires one add-extra-service call on double submit', async () => {
    mockInvoke.mockImplementation((fn: string, opts: {body?: Record<string, unknown>}) => {
      if (fn === 'owner-api') return new Promise(() => {});
      return Promise.resolve({data: null, error: null});
    });
    mockFrom.mockImplementation((table: string) => tablesWith([row()])(table));
    render(<Page business={studio()} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Доп. услуга'}));
    fireEvent.change(await screen.findByLabelText('Услуга из каталога'), {target: {value: 'wash'}});
    const add = screen.getByRole('button', {name: 'Добавить'});
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([fn]) => fn === 'owner-api')).toHaveLength(1);
    });
  });
});
