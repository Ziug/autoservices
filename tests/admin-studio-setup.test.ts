import {describe, expect, it} from 'vitest';
import {
  DETAILING_TEMPLATE_CONTENTS,
  compatibleResources,
  deriveResourceDraft,
  isCompatibleResource,
  suggestServiceResourceTypes,
  validationFindingTarget,
  type AdminResourceRow,
} from '@/lib/admin-api';
import {SLUG_FORMAT_HINT, suggestSlug, validateSlug} from '@/lib/suggest-slug';
import {resolveTenantLogo} from '@/components/install-metadata';

function post(overrides: Partial<AdminResourceRow> = {}): AdminResourceRow {
  return {
    id: 'id', slug: 'post-1', name: 'Пост 1', resourceType: 'any', location: '', active: true,
    ...overrides,
  } as AdminResourceRow;
}

describe('service–resource compatibility (mirrors server rule)', () => {
  it('matches on overlap or any on either side', () => {
    expect(isCompatibleResource(['detailing'], 'detailing')).toBe(true);
    expect(isCompatibleResource(['detailing'], 'any')).toBe(true);
    expect(isCompatibleResource(['any'], 'wash')).toBe(true);
    expect(isCompatibleResource(['detailing'], 'wash')).toBe(false);
    expect(isCompatibleResource([], 'any')).toBe(false);
  });

  it('lists only active compatible posts', () => {
    const resources = [
      post({slug: 'a', name: 'A', resourceType: 'wash', active: true}),
      post({slug: 'b', name: 'B', resourceType: 'wash', active: false}),
      post({slug: 'c', name: 'C', resourceType: 'detailing', active: true}),
    ];
    expect(compatibleResources(['wash'], resources).map((row) => row.slug)).toEqual(['a']);
  });

  it('preselects when exactly one compatible post exists', () => {
    const resources = [post({slug: 'wash-1', name: 'Мойка', resourceType: 'wash'})];
    const {compatible, suggestion} = suggestServiceResourceTypes(['wash', 'polish'], resources);
    expect(compatible.map((row) => row.slug)).toEqual(['wash-1']);
    expect(suggestion).toEqual(['wash']);
  });

  it('suggests any when an any-post exists among several', () => {
    const resources = [
      post({slug: 'u', name: 'Универсальный', resourceType: 'any'}),
      post({slug: 'w', name: 'Мойка', resourceType: 'wash'}),
    ];
    expect(suggestServiceResourceTypes(['any'], resources).suggestion).toEqual(['any']);
  });

  it('returns no suggestion when there is nothing compatible', () => {
    const resources = [post({slug: 'w', name: 'Мойка', resourceType: 'wash'})];
    const {compatible, suggestion} = suggestServiceResourceTypes(['detailing'], resources);
    expect(compatible).toEqual([]);
    expect(suggestion).toBeNull();
  });
});

describe('one-click compatible post draft', () => {
  it('derives type and slug from the service', () => {
    const draft = deriveResourceDraft(['detailing', 'polish'], []);
    expect(draft.resourceType).toBe('detailing');
    expect(draft.slug).toBe(suggestSlug(draft.name));
    expect(validateSlug(draft.slug)).toBeNull();
  });

  it('falls back to a universal post for any-only services', () => {
    expect(deriveResourceDraft(['any'], []).resourceType).toBe('any');
  });

  it('dedupes slugs against existing posts', () => {
    const first = deriveResourceDraft(['wash'], []);
    const second = deriveResourceDraft(['wash'], [first.slug]);
    expect(second.slug).not.toBe(first.slug);
    expect(validateSlug(second.slug)).toBeNull();
  });
});

describe('validation finding fix-links', () => {
  it('routes codes to the tab that fixes them', () => {
    expect(validationFindingTarget('services-missing')).toBe('services');
    expect(validationFindingTarget('service-no-resource')).toBe('services');
    expect(validationFindingTarget('name-missing')).toBe('branding');
    expect(validationFindingTarget('city-empty')).toBe('branding');
    expect(validationFindingTarget('gallery-empty')).toBe('branding');
    expect(validationFindingTarget('demo-live-conflict')).toBe('publication');
    expect(validationFindingTarget('contact-placeholder')).toBe('branding');
    expect(validationFindingTarget('slug-taken')).toBe('overview');
    expect(validationFindingTarget('counts')).toBe('overview');
    expect(validationFindingTarget('something-new')).toBe('overview');
  });
});

describe('starter template contract', () => {
  it('advertises visible contents for the default template', () => {
    expect(DETAILING_TEMPLATE_CONTENTS.length).toBeGreaterThan(0);
    expect(DETAILING_TEMPLATE_CONTENTS.join(' ')).toMatch(/4/);
  });

  it('shares one slug format hint across forms', () => {
    expect(SLUG_FORMAT_HINT).toMatch(/латинские/);
    expect(validateSlug('trailing-')).toBe(SLUG_FORMAT_HINT);
  });
});

describe('tenant install icon resolution', () => {
  const business = (logoImage: string) => ({
    logoImage,
    name: 'Студия', slug: 'studio', tagline: '', description: '', city: '', address: '',
    phone: '', mapUrl: '', timezone: 'Europe/Moscow', currency: 'RUB', locale: 'ru-RU',
    accentColor: '#4690FF', heroImage: '', demo: true, status: 'draft',
    bookingStepMinutes: 30, cancellationWindowHours: 12, openingHours: [],
    services: [], resources: [], gallery: [], infoCards: [], assistantPrompts: [],
  }) as unknown as Parameters<typeof resolveTenantLogo>[0];

  it('uses the same-origin logo and falls back to the placeholder', () => {
    expect(resolveTenantLogo(business('/tenants/studio/images/mark.svg'))).toBe('/tenants/studio/images/mark.svg');
    expect(resolveTenantLogo(business(''))).toBe('/placeholders/detailing-logo.svg');
    expect(resolveTenantLogo(business('https://cdn.example.com/logo.png'))).toBe('/placeholders/detailing-logo.svg');
  });
});
