import {describe, expect, it} from 'vitest';
import {isValidOwnerUsername, normalizeOwnerUsername} from '@/lib/admin-api';
import {OWNER_AUTH_DOMAIN, ownerEmailFor} from '@/lib/tenant-api';

describe('owner username rules', () => {
  it('normalizes logins to lowercase without surrounding spaces', () => {
    expect(normalizeOwnerUsername('  Grafit-Studio_1 ')).toBe('grafit-studio_1');
  });

  it('accepts logins matching the server pattern', () => {
    expect(isValidOwnerUsername('grafit')).toBe(true);
    expect(isValidOwnerUsername('studio.01_мойка'.toLowerCase())).toBe(false);
    expect(isValidOwnerUsername('north-studio_7')).toBe(true);
    expect(isValidOwnerUsername('  NORTH-STUDIO ')).toBe(true);
  });

  it('rejects short, long, or unsafe logins', () => {
    expect(isValidOwnerUsername('ab')).toBe(false);
    expect(isValidOwnerUsername('a'.repeat(33))).toBe(false);
    expect(isValidOwnerUsername('-leading')).toBe(false);
    expect(isValidOwnerUsername('with space')).toBe(false);
    expect(isValidOwnerUsername('name@domain')).toBe(false);
    expect(isValidOwnerUsername('')).toBe(false);
  });
});

describe('owner synthetic auth email', () => {
  it('maps a login to the internal auth address', () => {
    expect(ownerEmailFor('Grafit-Studio')).toBe(`grafit-studio@${OWNER_AUTH_DOMAIN}`);
    expect(ownerEmailFor('  north_7 ')).toBe(`north_7@${OWNER_AUTH_DOMAIN}`);
  });

  it('never uses a contact email for login', () => {
    expect(ownerEmailFor('owner')).not.toContain('example.com');
    expect(OWNER_AUTH_DOMAIN).not.toContain('example');
  });
});
