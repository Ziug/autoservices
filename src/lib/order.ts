/**
 * Order financial helpers — single source of truth for order math.
 *
 * Model: appointments.price_minor is the ORIGINAL service price snapshot.
 * appointment_services rows are additional line items. payments rows are the
 * financial history (kind 'charge' | 'refund'). The final order total is
 * always computed here, never stored, so no field can drift.
 * An appointment's status is never treated as proof of payment.
 */

export type OrderLineKind = 'extra' | 'custom';

export interface OrderLine {
  id: string;
  serviceId?: string | null;
  name: string;
  priceMinor: number;
  kind: OrderLineKind;
  createdAt: string;
}

export interface OrderNote {
  id: string;
  body: string;
  createdAt: string;
}

export interface OrderPayment {
  id: string;
  kind: 'charge' | 'refund';
  amountMinor: number;
  method: string;
  note: string;
  receivedAt: string;
}

export interface OrderTotals {
  /** Original service price snapshot from the booking. */
  originalMinor: number;
  /** Sum of additional service line items. */
  extrasMinor: number;
  /** Final order total = original + extras. */
  totalMinor: number;
  /** Sum of recorded charges (money received). */
  paidMinor: number;
  /** Sum of recorded refunds. */
  refundedMinor: number;
  /** paidMinor - refundedMinor: what the studio actually kept. */
  netMinor: number;
  /** totalMinor - netMinor: what is still owed (negative = overpaid). */
  balanceMinor: number;
}

export function computeOrderTotals(
  originalMinor: number,
  extras: ReadonlyArray<{priceMinor: number}> = [],
  payments: ReadonlyArray<{kind: string; amountMinor: number}> = [],
): OrderTotals {
  const extrasMinor = extras.reduce((sum, line) => sum + (Number.isFinite(line.priceMinor) ? line.priceMinor : 0), 0);
  const paidMinor = payments.reduce((sum, row) => (row.kind === 'refund' ? sum : sum + row.amountMinor), 0);
  const refundedMinor = payments.reduce((sum, row) => (row.kind === 'refund' ? sum + row.amountMinor : sum), 0);
  const original = Number.isFinite(originalMinor) ? originalMinor : 0;
  const totalMinor = original + extrasMinor;
  const netMinor = paidMinor - refundedMinor;
  return {originalMinor: original, extrasMinor, totalMinor, paidMinor, refundedMinor, netMinor, balanceMinor: totalMinor - netMinor};
}

/**
 * Parse a human-entered amount ("5000", "5000.50") into minor units.
 * Returns null for anything invalid, negative, or unbounded — the caller
 * shows a field error instead of sending a bogus amount to the server.
 */
export function amountToMinor(input: string): number | null {
  const trimmed = input.trim().replace(',', '.');
  if (!trimmed || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const minor = Math.round(Number(trimmed) * 100);
  if (!Number.isFinite(minor) || minor <= 0 || minor > 100_000_000_000_000) return null;
  return minor;
}

/** Guard for the "+ Доп. услуга" custom form: 2..100 chars, 1..1e12 minor units. */
export function isValidCustomExtra(name: string, priceMinor: number | null): boolean {
  return name.trim().length >= 2 && name.trim().length <= 100 && priceMinor !== null && priceMinor >= 1 && priceMinor <= 1_000_000_000_000;
}

/** Sort helper: line items and notes always render oldest-first (history order). */
export function byCreatedAt<T extends {createdAt: string}>(a: T, b: T) {
  return a.createdAt.localeCompare(b.createdAt);
}
