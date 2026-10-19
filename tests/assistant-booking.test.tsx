import {describe, expect, it, vi, afterEach, beforeEach} from 'vitest';
import {render, screen, fireEvent, cleanup, waitFor, act} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Outlet, Route, Routes} from 'react-router-dom';
import {businessSchema, type BusinessConfig} from '@/domain/tenant';
import type {TenantOutlet} from '@/App';

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {functions: {invoke: mockInvoke}},
}));

vi.mock('@/components/ui/drawer', () => ({
  DrawerPanel: ({children, open}: {children: React.ReactNode; open: boolean}) =>
    open ? <div data-testid="drawer">{children}</div> : null,
}));

import {AssistantWidget} from '@/components/assistant-widget';
import {MyBookingPage} from '@/pages/booking/AppointmentPage';
import {readSavedAccess, rememberAccess} from '@/lib/booking-access';

function studio(): BusinessConfig {
  return businessSchema.parse({
    schemaVersion: 1,
    slug: 'yo',
    name: 'Yo',
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
    demo: false,
    status: 'live',
    bookingStepMinutes: 30,
    cancellationWindowHours: 2,
    openingHours: [{weekday: 1, opensAt: '09:00', closesAt: '19:00'}],
    services: [{
      slug: 'polishing',
      name: 'Полировка кузова',
      description: 'Полировка',
      priceMinor: 100000,
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      category: 'Уход',
      resourceTypes: ['any'],
      active: true,
    }],
    resources: [{slug: 'post-1', name: 'Пост 1', resourceType: 'any', active: true}],
    gallery: [],
    infoCards: [
      {id: 'one', title: '1', body: 'a'},
      {id: 'two', title: '2', body: 'b'},
      {id: 'three', title: '3', body: 'c'},
    ],
    assistantPrompts: ['Какие есть услуги?'],
  });
}

const BOOKING_RESPONSE = {
  answer: 'Записал вас на полировку кузова.',
  draft: {serviceSlug: null, day: null, time: null, customerName: '', customerPhone: '', vehicle: ''},
  booking: {
    appointmentId: 'appt-123',
    accessToken: 'token-abc',
    startsAt: '2026-10-20T06:00:00+00:00',
    endsAt: '2026-10-20T16:00:00+00:00',
    serviceName: 'Полировка кузова',
    priceMinor: 100000,
  },
};

function renderAssistant(business: BusinessConfig) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssistantWidget business={business} audience="client" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockInvoke.mockReset();
});

afterEach(() => cleanup());

describe('assistant booking reaches the customer cabinet', () => {
  it('stores the access pair so the booking appears in "Моя запись"', async () => {
    mockInvoke.mockResolvedValue({data: BOOKING_RESPONSE, error: null});
    const business = studio();
    renderAssistant(business);

    fireEvent.click(screen.getByRole('button', {name: /задать вопрос студии/i}));
    fireEvent.change(screen.getByLabelText(/сообщение помощнику/i), {target: {value: 'Запиши меня завтра на полировку'}});
    fireEvent.click(screen.getByRole('button', {name: /отправить/i}));

    await waitFor(() => expect(mockInvoke).toHaveBeenCalled());
    await waitFor(() => {
      const saved = readSavedAccess(business.slug);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({appointmentId: 'appt-123', accessToken: 'token-abc'});
    });
  });

  it('shows a direct link to the created booking in the chat', async () => {
    mockInvoke.mockResolvedValue({data: BOOKING_RESPONSE, error: null});
    const business = studio();
    renderAssistant(business);

    fireEvent.click(screen.getByRole('button', {name: /задать вопрос студии/i}));
    fireEvent.change(screen.getByLabelText(/сообщение помощнику/i), {target: {value: 'Запиши меня завтра на полировку'}});
    fireEvent.click(screen.getByRole('button', {name: /отправить/i}));

    await waitFor(() => expect(screen.getByText(/запись создана/i)).toBeTruthy());
    const link = screen.getByRole('link', {name: /открыть запись/i});
    expect(link.getAttribute('href')).toContain('/s/yo/reservation/appt-123');
    expect(link.getAttribute('href')).toContain('token=token-abc');
  });

  it('the cabinet page lists a booking created by the assistant', async () => {
    // The assistant wrote the pair into localStorage.
    localStorage.setItem('autoservices:access:yo', JSON.stringify([
      {appointmentId: 'appt-123', accessToken: 'token-abc', startsAt: '2026-10-20T06:00:00+00:00', businessSlug: 'yo'},
    ]));
    mockInvoke.mockResolvedValue({data: {answer: 'ок'}, error: null});
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/s/yo/my-booking']}>
          <Routes>
            <Route path="/s/:slug" element={<Outlet context={{business} satisfies TenantOutlet} />}>
              <Route path="my-booking" element={<MyBookingPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const link = await screen.findByRole('link', {name: /открыть запись/i});
    expect(link.getAttribute('href')).toContain('appt-123');
  });

  it('the cabinet page picks up a booking added while it is open', async () => {
    const business = studio();
    const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/s/yo/my-booking']}>
          <Routes>
            <Route path="/s/:slug" element={<Outlet context={{business} satisfies TenantOutlet} />}>
              <Route path="my-booking" element={<MyBookingPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Nothing saved yet.
    expect(screen.queryByRole('link', {name: /открыть запись/i})).toBeNull();

    // The assistant widget saves a booking from outside React.
    act(() => {
      rememberAccess({
        appointmentId: 'appt-late',
        accessToken: 'token-late',
        startsAt: '2026-10-20T06:00:00+00:00',
        businessSlug: business.slug,
      });
    });

    // The page must re-read the list without a manual reload.
    const link = await screen.findByRole('link', {name: /открыть запись/i});
    expect(link.getAttribute('href')).toContain('appt-late');
  });
});
