import {describe, expect, it, vi} from 'vitest';
import {render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter, Route, Routes} from 'react-router-dom';
vi.mock('@/lib/admin-api', () => ({
  activateTenant: vi.fn(), adminApiErrorReport: () => null, adminSetupTabLabel: (t: string) => t,
  compatibleResources: () => [], deriveResourceDraft: vi.fn(),
  exportTenant: vi.fn().mockResolvedValue({slug:'demo',name:'Демо',tagline:'',description:'',city:'Г',address:'А',phone:'+7',mapUrl:'',timezone:'Europe/Moscow',currency:'RUB',locale:'ru-RU',accentColor:'#4690FF',heroImage:'',logoImage:'',demo:true,status:'draft',bookingStepMinutes:30,cancellationWindowHours:12,openingHours:[],services:[],resources:[],gallery:[],infoCards:[],assistantPrompts:[]}),
  getTenantDetail: vi.fn().mockResolvedValue({tenant:{id:'t1',slug:'demo',name:'Демо',city:'Г',phone:'+7',isDemo:true,status:'draft',visibility:'draft',suspended:false,archived:false,suspendReason:'',suspendedAt:null,archivedAt:null,updatedAt:'',createdAt:'',openingHours:[]},counts:{services:0,resources:0,appointments:0},payments:{grossMinor:0,refundMinor:0,netMinor:0}}),
  listAdminOverrides: vi.fn().mockResolvedValue([]), listResources: vi.fn().mockResolvedValue([]), listServices: vi.fn().mockResolvedValue([]),
  newRequestId: () => 'r', publishTenant: vi.fn(), saveAdminDateOverride: vi.fn(), saveAdminResource: vi.fn(), saveAdminService: vi.fn(),
  suggestServiceResourceTypes: () => ({compatible:[],suggestion:null}), updateAdminTenantProfile: vi.fn(),
  validateTenant: vi.fn().mockResolvedValue({errors:[],warnings:[],info:[]}), validationFindingTarget: (c:string)=>c,
}));
vi.mock('@/lib/admin-config', () => ({adminUrl: (...p: string[]) => `/c/${p.join('/')}`}));
vi.mock('@/lib/suggest-slug', () => ({SLUG_FORMAT_HINT:'s',normalizeSlugInput:(v:string)=>v,suggestSlug:(v:string)=>v,validateSlug:()=>null}));
vi.mock('@/pages/admin/AdminLayout', () => ({AdminAreaHeading: ({title}:{title:string})=><p>{title}</p>}));
import {StudioSetupPage} from '@/pages/admin/StudioSetupPage';
describe('dbg', () => {
  it('query check', async () => {
    const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
    const {container} = render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/t/t1/setup']}><Routes><Route path="/t/:tenantId/setup" element={<StudioSetupPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(container.querySelectorAll('section[role="tabpanel"]').length).toBe(5), {timeout: 8000});
    const all = screen.queryAllByRole('tabpanel', {hidden: true});
    console.log('QUERY-ALL-HIDDEN-TRUE COUNT:', all.length, all.map(el => el.getAttribute('aria-label')));
    const all2 = screen.queryAllByRole('tabpanel');
    console.log('QUERY-ALL-DEFAULT COUNT:', all2.length, all2.map(el => el.getAttribute('aria-label')));
  });
});
