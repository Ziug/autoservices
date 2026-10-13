/**
 * Slug helpers for studio creation: transliterate display names (incl.
 * Cyrillic) to URL-safe slugs and validate them against the DB CHECK
 * (^[a-z0-9]+(-[a-z0-9]+)*$) before the server is even called.
 */

const TRANSLITERATION: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 100;

/** Suggest a URL-safe slug from an arbitrary studio name. */
export function suggestSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .split('')
    .map((char) => TRANSLITERATION[char] ?? char)
    .join('')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
  return slug;
}

/** Validate a slug client-side. Returns an error message or null when valid. */
export function validateSlug(slug: string): string | null {
  const value = slug.trim().toLowerCase();
  if (!value) return 'Введите адрес студии.';
  if (value.length > SLUG_MAX_LENGTH) return `Адрес не длиннее ${SLUG_MAX_LENGTH} символов.`;
  if (!SLUG_PATTERN.test(value)) {
    return 'Только строчные латинские буквы, цифры и дефисы; нельзя начинать или заканчивать дефисом.';
  }
  return null;
}

/** Normalize free-form input toward a slug while typing (lowercase, hyphens). */
export function normalizeSlugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX_LENGTH);
}
