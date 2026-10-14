import {describe, expect, it} from 'vitest';
import {amountToMinor, byCreatedAt, computeOrderTotals, isValidCustomExtra} from '@/lib/order';

describe('order totals', () => {
  it('computes the total from the original price and extras, never from payments', () => {
    const totals = computeOrderTotals(10000, [{priceMinor: 1500}, {priceMinor: 500}], []);
    expect(totals.originalMinor).toBe(10000);
    expect(totals.extrasMinor).toBe(2000);
    expect(totals.totalMinor).toBe(12000);
    expect(totals.paidMinor).toBe(0);
    // Completion is not payment: balance stays owed regardless of status.
    expect(totals.balanceMinor).toBe(12000);
  });

  it('separates charges and refunds and reports the remaining balance', () => {
    const totals = computeOrderTotals(10000, [{priceMinor: 2000}], [
      {kind: 'charge', amountMinor: 8000},
      {kind: 'refund', amountMinor: 1000},
      {kind: 'charge', amountMinor: 1000},
    ]);
    expect(totals.totalMinor).toBe(12000);
    expect(totals.paidMinor).toBe(9000);
    expect(totals.refundedMinor).toBe(1000);
    expect(totals.netMinor).toBe(8000);
    expect(totals.balanceMinor).toBe(4000);
  });

  it('reports a negative balance for overpayments instead of hiding it', () => {
    const totals = computeOrderTotals(5000, [], [{kind: 'charge', amountMinor: 6000}]);
    expect(totals.balanceMinor).toBe(-1000);
  });

  it('counts a partially paid order with extras exactly once', () => {
    const extras = [{priceMinor: 1000}, {priceMinor: 1000}];
    const totals = computeOrderTotals(2000, extras, [{kind: 'charge', amountMinor: 3000}]);
    expect(totals.totalMinor).toBe(4000);
    expect(totals.balanceMinor).toBe(1000);
  });

  it('survives missing data without producing NaN', () => {
    const totals = computeOrderTotals(Number.NaN, [], []);
    expect(totals.totalMinor).toBe(0);
    expect(Number.isNaN(totals.balanceMinor)).toBe(false);
  });
});

describe('amount parsing', () => {
  it('accepts ruble and kopeck inputs', () => {
    expect(amountToMinor('5000')).toBe(500000);
    expect(amountToMinor('5000.50')).toBe(500050);
    expect(amountToMinor('0,05')).toBe(5);
  });

  it('rejects empty, negative, malformed, spaced and oversized amounts', () => {
    expect(amountToMinor('')).toBeNull();
    expect(amountToMinor('-5')).toBeNull();
    expect(amountToMinor('abc')).toBeNull();
    expect(amountToMinor('1.234')).toBeNull();
    expect(amountToMinor('1 200')).toBeNull();
    expect(amountToMinor('9999999999999999')).toBeNull();
  });
});

describe('custom extra validation', () => {
  it('accepts a name and positive price and rejects everything else', () => {
    expect(isValidCustomExtra('Химчистка сидений', 300000)).toBe(true);
    expect(isValidCustomExtra('  ', 300000)).toBe(false);
    expect(isValidCustomExtra('x', 300000)).toBe(false);
    expect(isValidCustomExtra('x'.repeat(101), 300000)).toBe(false);
    expect(isValidCustomExtra('Нормально', null)).toBe(false);
    expect(isValidCustomExtra('Нормально', 0)).toBe(false);
  });
});

describe('history ordering', () => {
  it('sorts line items oldest-first', () => {
    const rows = [{createdAt: '2026-01-02T00:00:00Z'}, {createdAt: '2026-01-01T00:00:00Z'}];
    expect([...rows].sort(byCreatedAt)[0].createdAt).toBe('2026-01-01T00:00:00Z');
  });
});
