import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {toAvailableSlots} from '@/lib/tenant-api';
import {localTimeLabel} from '@/lib/format';

// Trimmed shape of the real get-slots response for simple-car/full-detailing,
// 2026-10-16 (recorded pre-migration: 60-minute step, 09:00-20:00 Friday).
const SERVER_SAMPLE = [
  {starts_at: '2026-10-16T06:00:00+00:00', available_count: 3},
  {starts_at: '2026-10-16T06:30:00+00:00', available_count: 0},
  {starts_at: '2026-10-16T07:00:00+00:00', available_count: 3},
];

// Expected post-migration shape: 30-minute step, 09:00-21:00 Friday
// (last valid start 20:30 Moscow = 17:30 UTC).
const SERVER_SAMPLE_30MIN = [
  {starts_at: '2026-10-16T06:00:00+00:00', available_count: 3},
  {starts_at: '2026-10-16T17:30:00+00:00', available_count: 2},
];

// Contract of the get-slots Edge Function response body.
const slotsResponseSchema = z.object({
  slots: z.array(z.object({starts_at: z.iso.datetime({offset: true}), available_count: z.number().int().nonnegative()})),
});

describe('get-slots boundary mapping', () => {
  it('parses the real Edge Function response schema', () => {
    expect(slotsResponseSchema.parse({slots: SERVER_SAMPLE}).slots).toHaveLength(3);
    expect(slotsResponseSchema.parse({slots: SERVER_SAMPLE_30MIN}).slots).toHaveLength(2);
  });

  it('maps snake_case server rows to the camelCase app shape', () => {
    const mapped = toAvailableSlots(SERVER_SAMPLE);
    expect(mapped).toEqual([
      {startsAt: '2026-10-16T06:00:00+00:00', availableCount: 3},
      {startsAt: '2026-10-16T06:30:00+00:00', availableCount: 0},
      {startsAt: '2026-10-16T07:00:00+00:00', availableCount: 3},
    ]);
  });

  it('preserves zero-count rows (the page decides emptiness, not the mapping)', () => {
    const mapped = toAvailableSlots(SERVER_SAMPLE);
    const usable = mapped.filter((slot) => slot.availableCount > 0);
    expect(usable).toHaveLength(2);
    expect(toAvailableSlots(SERVER_SAMPLE.map((row) => ({...row, available_count: 0}))).filter((slot) => slot.availableCount > 0)).toHaveLength(0);
  });

  it('drops malformed rows but keeps the usable ones', () => {
    const mapped = toAvailableSlots([
      ...SERVER_SAMPLE,
      {starts_at: '2026-10-16T08:00:00+00:00'},
      {available_count: 2},
      null,
      'garbage',
    ]);
    expect(mapped).toHaveLength(3);
  });

  it('returns an empty list for non-array payloads', () => {
    expect(toAvailableSlots(undefined)).toEqual([]);
    expect(toAvailableSlots(null)).toEqual([]);
    expect(toAvailableSlots({})).toEqual([]);
  });
});

describe('Moscow timezone labels', () => {
  it('converts the recorded UTC starts to Moscow wall time', () => {
    expect(localTimeLabel('2026-10-16T06:00:00+00:00', 'Europe/Moscow')).toBe('09:00');
    expect(localTimeLabel('2026-10-16T16:00:00+00:00', 'Europe/Moscow')).toBe('19:00');
  });

  it('labels the post-migration last start (20:30 Moscow) correctly', () => {
    expect(localTimeLabel('2026-10-16T17:30:00+00:00', 'Europe/Moscow')).toBe('20:30');
  });
});
