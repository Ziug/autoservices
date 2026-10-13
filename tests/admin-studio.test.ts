import {describe, expect, it} from 'vitest';
import {normalizeSlugInput, suggestSlug, validateSlug} from '@/lib/suggest-slug';
import {tenantFilterParams} from '@/lib/admin-api';

describe('slug suggestion', () => {
  it('transliterates Russian names to URL-safe slugs', () => {
    expect(suggestSlug('Графит Детейлинг')).toBe('grafit-deteyling');
    expect(suggestSlug('Ceramica Garage!')).toBe('ceramica-garage');
    expect(suggestSlug('  Мойка №1 — Экспресс ')).toBe('moyka-1-ekspress');
    expect(suggestSlug('Мойка 24/7')).toBe('moyka-24-7');
  });

  it('validates slugs against the DB CHECK pattern', () => {
    expect(validateSlug('graphite-detailing')).toBeNull();
    expect(validateSlug('')).not.toBeNull();
    expect(validateSlug('-leading')).not.toBeNull();
    expect(validateSlug('trailing-')).not.toBeNull();
    // UI normalizes case before submit, so uppercase is accepted here.
    expect(validateSlug('UPPER')).toBeNull();
    expect(validateSlug('with space')).not.toBeNull();
  });

  it('normalizes typing input without surprises', () => {
    expect(normalizeSlugInput('Мойка 24/7')).toBe('247');
    expect(normalizeSlugInput('a--b')).toBe('a-b');
  });
});

describe('admin studio validation shapes', () => {
  it('maps suspended/archived filters to exact server params', () => {
    expect(tenantFilterParams('suspended')).toEqual({status: 'paused', archived: false});
    expect(tenantFilterParams('archived')).toEqual({archived: true});
    expect(tenantFilterParams('draft')).toEqual({status: 'draft'});
  });
});
