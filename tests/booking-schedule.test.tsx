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

// BottomSheet uses a native <dialog> presentation that jsdom cannot drive;
// the schedule-step content (dates, times, messages) is what this suite owns.
vi.mock('@astryxdesign/core/BottomSheet', () => ({
  BottomSheet: ({children}: {children: React.ReactNode}) => <div data-testid="sheet">{children}</div>,
}));
vi.mock('@astryxdesign/core/DateInput', () => ({
  DateInput: () => <input data-testid="stub-date" aria-label="stub-date" readOnly />,
}));

import {BookingPage} from '@/pages/booking/BookingPage';

function studio(openingHours: BusinessConfig['openingHours']): BusinessConfig {
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
    openingHours,
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

const OPEN_WEEK = [1, 2, 3, 4, 5].map((weekday) => ({weekday, opensAt: '09:00', closesAt: '21:00'}));

// Server shape: snake_case rows exactly as get-slots returns them.
const SERVER_ROWS = [
  {starts_at: '2026-10-15T06:00:00+00:00', available_count: 3},
  {starts_at: '2026-10-15T06:30:00+00:00', available_count: 0},
  {starts_at: '2026-10-15T07:00:00+00:00', available_count: 3},
];

function Page({business}: {business: BusinessConfig}) {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}, mutations: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/s/simple-car/booking?service=full-detailing']}>
        <Routes>
          <Route path="/s/:slug" element={<Outlet context={{business}} />}>
            <Route path="booking" element={<BookingPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function openSchedule() {
  // Step 1 (service) -> step 2 (schedule).
  const next = await screen.findByRole('button', {name: 'Выбрать дату'});
  fireEvent.click(next);
}

describe('booking schedule step', () => {
  beforeEach(() => mockInvoke.mockReset());
  afterEach(() => cleanup());

  it('renders time buttons from a snake_case server response', async () => {
    mockInvoke.mockResolvedValue({data: {slots: SERVER_ROWS}, error: null});
    render(<Page business={studio(OPEN_WEEK)} />);
    await openSchedule();
    // Real loadAvailability mapping runs inside the component: 09:00 and
    // 10:00 Moscow are free, 09:30 has count 0 and must not render.
    expect(await screen.findByRole('button', {name: '09:00, свободно'})).toBeTruthy();
    expect(await screen.findByRole('button', {name: '10:00, свободно'})).toBeTruthy();
    expect(screen.queryByRole('button', {name: '09:30, свободно'})).toBeNull();
    expect(screen.queryByText(/свободных окон нет/)).toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith('get-slots', {
      body: expect.objectContaining({slug: 'simple-car', serviceSlug: 'full-detailing'}),
    });
  });

  it('shows the booked-out message only when every count is zero', async () => {
    mockInvoke.mockResolvedValue({
      data: {slots: SERVER_ROWS.map((row) => ({...row, available_count: 0}))},
      error: null,
    });
    render(<Page business={studio(OPEN_WEEK)} />);
    await openSchedule();
    expect(await screen.findByText(/свободных окон нет/)).toBeTruthy();
    expect(screen.queryByRole('button', {name: /свободно/})).toBeNull();
  });

  it('shows the closed-day message when the weekday has no hours', async () => {
    mockInvoke.mockResolvedValue({data: {slots: []}, error: null});
    render(<Page business={studio([])} />);
    await openSchedule();
    expect(await screen.findByText(/закрыта по обычному графику/)).toBeTruthy();
  });
});
