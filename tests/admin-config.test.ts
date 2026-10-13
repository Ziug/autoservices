import {describe, expect, it} from 'vitest';
import {adminUrl, getAdminBasePath, isAdminPath, isAdminPathConfigured} from '@/lib/admin-config';
import {tenantFilterParams} from '@/lib/admin-api';

describe('admin hidden-route configuration', () => {
  it('defaults to a /control/ path and never hardcodes a secret', () => {
    const base = getAdminBasePath();
    expect(base.startsWith('/control/')).toBe(true);
    expect(base).not.toContain('http');
  });

  it('recognises nested admin paths and builds scoped urls', () => {
    const base = getAdminBasePath();
    expect(isAdminPath(base)).toBe(true);
    expect(isAdminPath(`${base}/tenants`)).toBe(true);
    expect(isAdminPath('/s/graphite-detailing/')).toBe(false);
    expect(adminUrl('tenants')).toBe(`${base}/tenants`);
  });

  it('reports whether an explicit path is configured', () => {
    expect(typeof isAdminPathConfigured()).toBe('boolean');
  });
});

describe('admin tenant filter mapping (server contract)', () => {
  it('maps suspended/archived to exact server params', () => {
    expect(tenantFilterParams('all')).toEqual({});
    expect(tenantFilterParams('suspended')).toEqual({status: 'paused', archived: false});
    expect(tenantFilterParams('archived')).toEqual({archived: true});
    expect(tenantFilterParams('live')).toEqual({status: 'live'});
  });
});
