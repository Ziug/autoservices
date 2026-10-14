import {describe, expect, it, vi, afterEach, beforeEach} from 'vitest';
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Outlet, Route, Routes} from 'react-router-dom';
import {businessSchema, type BusinessConfig} from '@/domain/tenant';

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {functions: {invoke: mockInvoke}},
}));

vi.mock('@astryxdesign/core/BottomSheet', () => ({
  BottomSheet: ({children}: {children: React.ReactNode}) => <div data-testid="sheet">{children}</div>,
}));
vi.mock('@astryxdesign/core/DateInput', () => ({
  DateInput: () => <input data-testid="stub-date" aria-label="stub-date" readOnly />,
}));
vi.mock('@/components/ui/drawer', () => ({
  DrawerPanel: ({open, children}: {open: boolean; children: React.ReactNode}) => (open ? <div data-testid="drawer">{children}</div> : null),
}));

import {BookingPage} from '@/pages/booking/BookingPage';
import {AppointmentPage} from '@/pages/booking/AppointmentPage';

function studio(): BusinessConfig {
  return businessSchema.parse({
    schemaVersion: 1,
    slug: 'simple-car',
    name: 'Simple Car',
    tagline: 'Тестовая студия',
    description: 'Описание студии',
    city: 'Город',
    address: 'Улица, 1',
    phone: '+7 900 000-00-00',
    timezone: 'Europe/Moscow',
    currency: 'RUB',
    locale: 'ru-RU',
    accentColor: '#4690FF',
    heroImage: 'https://example.com/hero.jpg',
    logoImage: 'https://example.com/logo.svg',
    demo: true,
    status: 'preview',
    bookingStepMinutes: 30,
    cancellationWindowHours: 12,
    openingHours: [1, 2, 3, 4, 5].map((weekday) => ({weekday, opensAt: '09:00', closesAt: '21:00'})),
    services: [{
      slug: 'full-detailing', name: 'Full', description: 'Полный детейлинг',
      priceMinor: 100000, durationMinutes: 120, bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0, category: 'Test', resourceTypes: ['any'], active: true,
    }],
    resources: [{slug: 'post-1', name: 'Post 1', resourceType: 'any', active: true}],
    gallery: [],
    infoCards: [
      {id: 'one', title: 'Раз', body: 'Текст раз'},
      {id: 'two', title: 'Два', body: 'Текст два'},
      {id: 'three', title: 'Три', body: 'Текст три'},
    ],
    assistantPrompts: ['Вопрос?'],
  });
}

const SERVER_ROWS = [
  {starts_at: '2026-10-15T06:00:00+00:00', available_count: 3},
  {starts_at: '2026-10-15T06:30:00+00:00', available_count: 3},
];

function Shell({business, client, entry}: {business: BusinessConfig; client: QueryClient; entry: string}) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/s/:slug" element={<Outlet context={{business}} />}>
            <Route path="booking" element={<BookingPage />} />
            <Route path="reservation/:appointmentId" element={<AppointmentPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function reachReview() {
  fireEvent.click(await screen.findByRole('button', {name: 'Выбрать дату'}));
  fireEvent.click(await screen.findByRole('button', {name: '09:30, свободно'}));
  fireEvent.click(await screen.findByRole('button', {name: 'Продолжить'}));
  fireEvent.change(screen.getByPlaceholderText('Как к вам обращаться'), {target: {value: 'Иван'}});
  fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), {target: {value: '+7 900 111-11-11'}});
  fireEvent.change(screen.getByPlaceholderText('Марка и модель'), {target: {value: 'Lada'}});
  fireEvent.click(await screen.findByRole('button', {name: 'Проверить запись'}));
  await screen.findByRole('button', {name: 'Подтвердить запись'});
}

describe('booking submission', () => {
  beforeEach(() => mockInvoke.mockReset());
  afterEach(() => cleanup());

  it('invalidates availability after a successful booking', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'get-slots') return Promise.resolve({data: {slots: SERVER_ROWS}, error: null});
      if (fn === 'book-appointment') {
        return Promise.resolve({data: {appointment: {id: 'a1'}, accessToken: 'tok'}, error: null});
      }
      return Promise.resolve({data: null, error: null});
    });
    render(<Shell business={business} client={client} entry="/s/simple-car/booking?service=full-detailing" />);
    await reachReview();
    fireEvent.click(screen.getByRole('button', {name: 'Подтвердить запись'}));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('book-appointment', expect.anything());
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({queryKey: ['availability', 'simple-car']});
    });
  });

  it('fires only one request on double confirm', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'get-slots') return Promise.resolve({data: {slots: SERVER_ROWS}, error: null});
      if (fn === 'book-appointment') return new Promise(() => {});
      return Promise.resolve({data: null, error: null});
    });
    render(<Shell business={business} client={client} entry="/s/simple-car/booking?service=full-detailing" />);
    await reachReview();
    const confirm = screen.getByRole('button', {name: 'Подтвердить запись'});
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([fn]) => fn === 'book-appointment')).toHaveLength(1);
    });
  });

  // Real supabase-js failure shape: generic English message on the error,
  // server text inside error.context (Response). tenant-api must parse it —
  // matching on error.message alone would be dead in production.
  function functionsError(serverText: string, status = 409) {
    return Object.assign(new Error('Edge Function returned a non-2xx status code'), {
      name: 'FunctionsHttpError',
      context: new Response(JSON.stringify({error: serverText}), {status}),
    });
  }

  it('shows the conflict message and refreshes availability on SLOT_TAKEN', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'get-slots') return Promise.resolve({data: {slots: SERVER_ROWS}, error: null});
      if (fn === 'book-appointment') {
        return Promise.resolve({data: null, error: functionsError('Это окно только что заняли. Выберите другое время.')});
      }
      return Promise.resolve({data: null, error: null});
    });
    render(<Shell business={business} client={client} entry="/s/simple-car/booking?service=full-detailing" />);
    await reachReview();
    fireEvent.click(screen.getByRole('button', {name: 'Подтвердить запись'}));
    await waitFor(() => {
      expect(screen.getByText(/только что заняли/)).toBeTruthy();
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({queryKey: ['availability', 'simple-car']});
    });
  });

  it('explains an idempotency mismatch instead of showing a raw error', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'get-slots') return Promise.resolve({data: {slots: SERVER_ROWS}, error: null});
      if (fn === 'book-appointment') {
        return Promise.resolve({data: null, error: functionsError('idempotency key mismatch', 400)});
      }
      return Promise.resolve({data: null, error: null});
    });
    render(<Shell business={business} client={client} entry="/s/simple-car/booking?service=full-detailing" />);
    await reachReview();
    fireEvent.click(screen.getByRole('button', {name: 'Подтвердить запись'}));
    await waitFor(() => {
      expect(screen.getByText(/Проверьте «Мою запись»/)).toBeTruthy();
    });
  });

  it('cancel converges availability and fires once on double confirm', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const appointment = {
      id: 'a1', tenantId: 't1', serviceSlug: 'full-detailing', serviceName: 'Full',
      startsAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 74 * 3600 * 1000).toISOString(),
      customerName: 'Иван', customerPhone: '+7 900 111-11-11', vehicle: 'Lada',
      status: 'confirmed', priceMinor: 100000,
    };
    mockInvoke.mockImplementation((fn: string) => {
      if (fn === 'appointment-access') return Promise.resolve({data: {appointment}, error: null});
      if (fn === 'cancel-appointment') return Promise.resolve({data: {cancelled: true}, error: null});
      return Promise.resolve({data: null, error: null});
    });
    render(<Shell business={business} client={client} entry="/s/simple-car/reservation/a1?token=tok123" />);
    fireEvent.click(await screen.findByRole('button', {name: 'Отменить запись'}));
    const confirm = await screen.findByText('Подтвердить отмену');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter(([fn]) => fn === 'cancel-appointment')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({queryKey: ['availability', 'simple-car']});
    });
  });
});
