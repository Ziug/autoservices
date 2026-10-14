import {describe, expect, it, vi, afterEach} from 'vitest';
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';

vi.mock('@/lib/admin-api', () => ({
  activateTenant: vi.fn(),
  adminApiErrorReport: () => null,
  adminSetupTabLabel: (tab: string) => tab,
  compatibleResources: () => [],
  deriveResourceDraft: vi.fn(),
  exportTenant: vi.fn().mockResolvedValue({
    slug: 'demo', name: 'Демо', tagline: '', description: '', city: 'Город',
    address: 'Адрес', phone: '+7000', mapUrl: '', timezone: 'Europe/Moscow',
    currency: 'RUB', locale: 'ru-RU', accentColor: '#4690FF', heroImage: '',
    logoImage: '', demo: true, status: 'draft', bookingStepMinutes: 30,
    cancellationWindowHours: 12, openingHours: [], services: [], resources: [],
    gallery: [], infoCards: [], assistantPrompts: [],
  }),
  getTenantDetail: vi.fn().mockResolvedValue({
    tenant: {
      id: 't1', slug: 'demo', name: 'Демо', city: 'Город', phone: '+7000',
      isDemo: true, status: 'draft', visibility: 'draft',
      suspended: false, archived: false, suspendReason: '',
      suspendedAt: null, archivedAt: null,
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
      openingHours: [],
    },
    counts: {services: 0, resources: 0, appointments: 0},
    payments: {grossMinor: 0, refundMinor: 0, netMinor: 0},
  }),
  listAdminOverrides: vi.fn().mockResolvedValue([]),
  listResources: vi.fn().mockResolvedValue([]),
  listServices: vi.fn().mockResolvedValue([]),
  newRequestId: () => 'req-1',
  publishTenant: vi.fn(),
  saveAdminDateOverride: vi.fn(),
  saveAdminResource: vi.fn(),
  saveAdminService: vi.fn(),
  suggestServiceResourceTypes: () => ({compatible: [], suggestion: null}),
  updateAdminTenantProfile: vi.fn(),
  validateTenant: vi.fn().mockResolvedValue({errors: [], warnings: [], info: []}),
  validationFindingTarget: (code: string) => code,
}));

vi.mock('@/lib/admin-config', () => ({adminUrl: (...parts: string[]) => `/c/${parts.join('/')}`}));
vi.mock('@/lib/suggest-slug', () => ({
  SLUG_FORMAT_HINT: 'slug',
  normalizeSlugInput: (value: string) => value,
  suggestSlug: (value: string) => value,
  validateSlug: () => null,
}));
vi.mock('@/pages/admin/AdminLayout', () => ({
  AdminAreaHeading: ({title}: {title: string}) => <p>{title}</p>,
}));

import {StudioSetupPage} from '@/pages/admin/StudioSetupPage';

function Page() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tenants/t1/setup']}>
        <Routes>
          <Route path="/tenants/:tenantId/setup" element={<StudioSetupPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('studio setup tabs', () => {
  afterEach(() => cleanup());

  it('shows only the selected panel; hidden panels stay hidden', async () => {
    const {container} = render(<Page />);
    // NOTE: role+name queries skip `hidden` subtrees in this testing-library
    // version, so panels are located by aria-label instead.
    const panel = (name: string) => {
      const found = container.querySelector(`section[role="tabpanel"][aria-label="${name}"]`);
      if (!found) throw new Error(`panel missing: ${name}`);
      return found;
    };
    await waitFor(() => expect(panel('Обзор настройки')).toBeTruthy());

    // Initially the overview is shown and services hidden.
    expect(panel('Обзор настройки').hasAttribute('hidden')).toBe(false);
    expect(panel('Услуги студии').hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getAllByRole('button', {name: 'Услуги'})[0]);

    await waitFor(() => expect(panel('Услуги студии').hasAttribute('hidden')).toBe(false));
    expect(panel('Обзор настройки').hasAttribute('hidden')).toBe(true);
    // Sanity: the tab strip itself marks the selection (nav pattern).
    expect(screen.getAllByRole('button', {name: 'Услуги'})[0].getAttribute('aria-current')).toBe('true');
  });
});
