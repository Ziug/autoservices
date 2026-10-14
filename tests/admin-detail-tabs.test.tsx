import {describe, expect, it, vi, afterEach} from 'vitest';
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';

vi.mock('@/lib/admin-api', () => ({
  archiveTenant: vi.fn(),
  createOwner: vi.fn(),
  deleteOwner: vi.fn(),
  getTenantDetail: vi.fn().mockResolvedValue({
    tenant: {
      id: 't1', slug: 'demo', name: 'Демо', city: 'Город', phone: '+7000',
      isDemo: true, status: 'preview', visibility: 'preview',
      suspended: false, archived: false, suspendReason: '',
      suspendedAt: null, archivedAt: null,
      updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
      openingHours: [],
    },
    counts: {services: 0, resources: 0, appointments: 0},
    payments: {grossMinor: 0, refundMinor: 0, netMinor: 0},
  }),
  listAudit: vi.fn().mockResolvedValue({entries: [], total: 0}),
  listOwners: vi.fn().mockResolvedValue([]),
  listResources: vi.fn().mockResolvedValue([]),
  listServices: vi.fn().mockResolvedValue([]),
  listTenantAppointments: vi.fn().mockResolvedValue({appointments: [], total: 0}),
  listTenantPayments: vi.fn().mockResolvedValue({payments: [], total: 0, grossMinor: 0, refundMinor: 0, netMinor: 0}),
  newRequestId: () => 'req-1',
  reactivateTenant: vi.fn(),
  suspendTenant: vi.fn(),
  unarchiveTenant: vi.fn(),
  updateOwner: vi.fn(),
}));

vi.mock('@/lib/admin-config', () => ({adminUrl: (...parts: string[]) => `/c/${parts.join('/')}`}));
vi.mock('@/pages/admin/AdminLayout', () => ({
  AdminAreaHeading: ({title}: {title: string}) => <p>{title}</p>,
}));

import {TenantDetailPage} from '@/pages/admin/TenantDetailPage';

function Page() {
  const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/tenants/t1']}>
        <Routes>
          <Route path="/tenants/:tenantId" element={<TenantDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('tenant detail tabs', () => {
  afterEach(() => cleanup());

  it('switches panels when a tab is clicked', async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getAllByRole('button', {name: 'Владельцы'})[0]).toBeTruthy());
    const ownersTab = screen.getAllByRole('button', {name: 'Владельцы'})[0];
    fireEvent.click(ownersTab);
    await waitFor(() => expect(screen.getByRole('tabpanel', {name: 'Доступы владельцев'})).toBeTruthy());
  });
});
