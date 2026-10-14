import type {ReactNode} from 'react';
import {Text} from '@astryxdesign/core/Text';
import {computeOrderTotals, type OrderLine, type OrderNote, type OrderPayment} from '@/lib/order';

function money(minor: number, currency: string, locale: string) {
  return new Intl.NumberFormat(locale, {style: 'currency', currency, maximumFractionDigits: 0}).format(minor / 100);
}

function PaymentRow({payment, currency, locale, time}: {payment: OrderPayment; currency: string; locale: string; time: string}) {
  const refund = payment.kind === 'refund';
  return (
    <section className="order-line" data-kind={payment.kind}>
      <section className="order-line-copy">
        <Text>{refund ? 'Возврат' : 'Оплата'} · {payment.method}</Text>
        <small>{time}{payment.note ? ` · ${payment.note}` : ''}</small>
      </section>
      <strong className="order-line-price">{refund ? '−' : '+'}{money(payment.amountMinor, currency, locale)}</strong>
    </section>
  );
}

function timeLabel(iso: string, timezone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export interface OrderSummaryData {
  appointmentId: string;
  serviceName: string;
  startsAt: string;
  customerName: string;
  customerNote: string;
  originalMinor: number;
  extras: OrderLine[];
  notes: OrderNote[];
  payments: OrderPayment[];
}

/**
 * Complete order/financial summary — original service price, additional
 * services, comments, payment history (charges and refunds), and the final
 * totals. Values are computed from authoritative data by the caller.
 */
export function OrderSummary({order, currency, locale, timezone, children}: {
  order: OrderSummaryData;
  currency: string;
  locale: string;
  timezone: string;
  children?: ReactNode;
}) {
  const totals = computeOrderTotals(order.originalMinor, order.extras, order.payments);
  return (
    <section className="order-summary" aria-label="Итог по заказу">
      <section className="order-section">
        <Text type="supporting" color="secondary">Услуга</Text>
        <section className="order-line">
          <section className="order-line-copy">
            <Text>{order.serviceName}</Text>
            <small>{timeLabel(order.startsAt, timezone)} · {order.customerName}</small>
          </section>
          <strong className="order-line-price">{money(order.originalMinor, currency, locale)}</strong>
        </section>
      </section>

      <section className="order-section">
        <Text type="supporting" color="secondary">Доп. услуги</Text>
        {order.extras.length === 0 ? (
          <Text type="supporting" color="secondary">Дополнительных услуг нет.</Text>
        ) : (
          order.extras.map((line) => (
            <section className="order-line" key={line.id}>
              <section className="order-line-copy">
                <Text>{line.name}</Text>
                <small>{line.kind === 'custom' ? 'Своя услуга' : 'Из каталога'} · {timeLabel(line.createdAt, timezone)}</small>
              </section>
              <strong className="order-line-price">{money(line.priceMinor, currency, locale)}</strong>
            </section>
          ))
        )}
      </section>

      <section className="order-section">
        <Text type="supporting" color="secondary">Комментарии</Text>
        <section className="order-line">
          <section className="order-line-copy">
            <Text>Комментарий клиента</Text>
            <small>{order.customerNote || '—'}</small>
          </section>
        </section>
        {order.notes.length === 0 ? (
          <Text type="supporting" color="secondary">Заметок мастера нет.</Text>
        ) : (
          order.notes.map((note) => (
            <section className="order-line" key={note.id}>
              <section className="order-line-copy">
                <Text>Заметка мастера</Text>
                <small>{timeLabel(note.createdAt, timezone)} · {note.body}</small>
              </section>
            </section>
          ))
        )}
      </section>

      <section className="order-section">
        <Text type="supporting" color="secondary">Оплаты и возвраты</Text>
        {order.payments.length === 0 ? (
          <Text type="supporting" color="secondary">Оплат пока нет.</Text>
        ) : (
          order.payments.map((payment) => (
            <PaymentRow key={payment.id} payment={payment} currency={currency} locale={locale} time={timeLabel(payment.receivedAt, timezone)} />
          ))
        )}
      </section>

      <section className="order-totals" aria-label="Итоговые суммы">
        <section className="order-total-row">
          <Text>Итог по заказу</Text>
          <strong data-testid="order-total">{money(totals.totalMinor, currency, locale)}</strong>
        </section>
        <section className="order-total-row">
          <Text type="supporting">Оплачено</Text>
          <Text>{money(totals.paidMinor, currency, locale)}</Text>
        </section>
        <section className="order-total-row">
          <Text type="supporting">Возвращено</Text>
          <Text>{money(totals.refundedMinor, currency, locale)}</Text>
        </section>
        <section className="order-total-row">
          <Text type="supporting">Остаток к оплате</Text>
          <strong data-testid="order-balance">{money(totals.balanceMinor, currency, locale)}</strong>
        </section>
      </section>
      {children}
    </section>
  );
}

export function OrderPaymentHint() {
  return null;
}
