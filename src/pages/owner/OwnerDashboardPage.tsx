import {useMemo, useState, type FormEvent} from 'react';
import {addDays, format, getISODay, startOfDay} from 'date-fns';
import {ru} from 'date-fns/locale';
import {formatInTimeZone, fromZonedTime} from 'date-fns-tz';
import {Link} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {ArrowClockwise, ArrowLeft, ArrowRight, Check, Clock, CurrencyRub, SignOut, Wrench} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import type {Appointment} from '@/domain/tenant';
import {useTenant} from '@/App';
import {dayLabel, localDateKey, localDayLabel, localTimeLabel, money} from '@/lib/format';
import {createClientId} from '@/lib/id';
import {loadOwnerSchedule, ownerAction, signOutOwner} from '@/lib/tenant-api';
import {hasSupabaseConfig, supabase} from '@/lib/supabase';

type Period = 'day' | 'week';
type Schedule = Awaited<ReturnType<typeof loadOwnerSchedule>>;

function shiftDate(date: string, amount: number) {
  const noon = new Date(`${date}T12:00:00Z`);
  return format(addDays(noon, amount), 'yyyy-MM-dd');
}

function weekStart(date: string) {
  const weekday = getISODay(new Date(`${date}T12:00:00Z`));
  return shiftDate(date, 1 - weekday);
}

function localInputValue(iso: string, timezone: string) {
  return formatInTimeZone(new Date(iso), timezone, "yyyy-MM-dd'T'HH:mm");
}

function dateTimeFromLocal(value: string, timezone: string) {
  return fromZonedTime(value, timezone).toISOString();
}

function statusLabel(status: Appointment['status']) {
  return ({confirmed: 'Ожидает', checked_in: 'Принят', in_progress: 'В работе', completed: 'Готово', cancelled: 'Отменена', no_show: 'Не приехал'} as const)[status];
}

function statusAction(status: Appointment['status']) {
  if (status === 'confirmed') return {label: 'Отметить заезд', next: 'checked_in' as const};
  if (status === 'checked_in') return {label: 'Начать работу', next: 'in_progress' as const};
  if (status === 'in_progress') return {label: 'Отметить готово', next: 'completed' as const};
  return null;
}

function AppointmentRow({appointment, business, refresh}: {appointment: Appointment; business: ReturnType<typeof useTenant>; refresh: () => Promise<void>}) {
  const [moveTo, setMoveTo] = useState(() => localInputValue(appointment.startsAt, business.timezone));
  const [payment, setPayment] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: ({action, payload}: {action: string; payload: Record<string, unknown>}) => ownerAction(business, action, payload),
    onSuccess: async () => { setError(''); await refresh(); },
    onError: (caught) => setError(caught instanceof Error ? caught.message : 'Не удалось сохранить действие.'),
  });
  const next = statusAction(appointment.status);

  const setStatus = (status: 'checked_in' | 'in_progress' | 'completed' | 'no_show') => mutation.mutate({action: 'set-status', payload: {appointmentId: appointment.id, status}});
  const cancel = () => {
    if (window.confirm('Отменить эту запись и освободить пост?')) mutation.mutate({action: 'cancel', payload: {appointmentId: appointment.id}});
  };
  const move = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!moveTo) return;
    mutation.mutate({action: 'move', payload: {appointmentId: appointment.id, startsAt: dateTimeFromLocal(moveTo, business.timezone)}});
  };
  const addPayment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const amountMinor = Math.round(Number(payment) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError('Введите сумму больше нуля.'); return; }
    mutation.mutate({action: 'add-payment', payload: {appointmentId: appointment.id, kind: 'charge', amountMinor, method: 'cash', note}});
  };

  return (
    <article className="appointment-row">
      <section className="appointment-main">
        <section className="appointment-status"><strong>{localTimeLabel(appointment.startsAt, business.timezone)}</strong><small className={`status-pill status-${appointment.status}`}>{statusLabel(appointment.status)}</small></section>
        <strong>{appointment.customerName} · {appointment.vehicle}</strong>
        <small>{appointment.serviceName} · {appointment.resourceLabel ?? 'Пост не назначен'} · {money(appointment.priceMinor, business.currency, business.locale)}</small>
        <a href={`tel:${appointment.customerPhone.replaceAll(' ', '')}`}>{appointment.customerPhone}</a>
      </section>
      <section className="appointment-controls">
        {next ? <Button label={next.label} size="sm" variant="primary" onClick={() => setStatus(next.next)} isLoading={mutation.isPending} /> : null}
        {appointment.status === 'confirmed' || appointment.status === 'checked_in' ? <Button label="Отменить" size="sm" variant="destructive" onClick={cancel} isLoading={mutation.isPending} /> : null}
        {appointment.status === 'confirmed' ? <Button label="Не приехал" size="sm" variant="secondary" onClick={() => setStatus('no_show')} isLoading={mutation.isPending} /> : null}
      </section>
      {appointment.status !== 'cancelled' && appointment.status !== 'completed' && appointment.status !== 'no_show' ? (
        <details className="appointment-tools">
          <summary>Перенос и оплата</summary>
          <form className="inline-form" onSubmit={move}>
            <label className="field"><small>Новое время</small><input aria-label="Новое время записи" onChange={(event) => setMoveTo(event.currentTarget.value)} type="datetime-local" value={moveTo} /></label>
            <Button label="Перенести" type="submit" size="sm" variant="secondary" isLoading={mutation.isPending} />
          </form>
          <form className="inline-form" onSubmit={addPayment}>
            <label className="field"><small>Получено, {business.currency}</small><input inputMode="decimal" min="0.01" onChange={(event) => setPayment(event.currentTarget.value)} placeholder="Например, 5000" step="0.01" type="number" value={payment} /></label>
            <label className="field"><small>Комментарий</small><input maxLength={300} onChange={(event) => setNote(event.currentTarget.value)} value={note} /></label>
            <Button label="Записать оплату" type="submit" size="sm" variant="secondary" icon={<CurrencyRub />} isLoading={mutation.isPending} />
          </form>
          <RefundForm appointment={appointment} business={business} mutation={mutation} setError={setError} />
        </details>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </article>
  );
}

function RefundForm({appointment, business, mutation, setError}: {
  appointment: Appointment;
  business: ReturnType<typeof useTenant>;
  mutation: ReturnType<typeof useMutation<unknown, Error, {action: string; payload: Record<string, unknown>}>>;
  setError: (message: string) => void;
}) {
  const [amount, setAmount] = useState('');
  return (
    <form className="inline-form" onSubmit={(event) => {
      event.preventDefault();
      const amountMinor = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) { setError('Введите сумму возврата больше нуля.'); return; }
      mutation.mutate({action: 'add-payment', payload: {appointmentId: appointment.id, kind: 'refund', amountMinor, method: 'cash', note: 'Возврат'}});
    }}>
      <label className="field"><small>Возврат, {business.currency}</small><input inputMode="decimal" min="0.01" onChange={(event) => setAmount(event.currentTarget.value)} step="0.01" type="number" value={amount} /></label>
      <Button label="Записать возврат" type="submit" size="sm" variant="secondary" isLoading={mutation.isPending} />
    </form>
  );
}

export function OwnerDashboardPage() {
  const business = useTenant();
  const queryClient = useQueryClient();
  const [selectedDate, setSelectedDate] = useState(() => localDateKey(new Date(), business.timezone));
  const [period, setPeriod] = useState<Period>('day');
  const [showManual, setShowManual] = useState(false);
  const [manualError, setManualError] = useState('');
  const [manualResult, setManualResult] = useState('');
  const [serviceSlug, setServiceSlug] = useState(business.services[0]?.slug ?? '');
  const [manualDateTime, setManualDateTime] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const startDate = period === 'day' ? selectedDate : weekStart(selectedDate);
  const endDate = shiftDate(startDate, period === 'day' ? 1 : 7);
  const from = fromZonedTime(`${startDate}T00:00:00`, business.timezone);
  const to = fromZonedTime(`${endDate}T00:00:00`, business.timezone);
  const key = ['owner-schedule', business.slug, startDate, endDate];
  const scheduleQuery = useQuery({queryKey: key, queryFn: () => loadOwnerSchedule(business, from, to), staleTime: 0, refetchInterval: 60_000});
  const refresh = async () => { await queryClient.invalidateQueries({queryKey: ['owner-schedule', business.slug]}); };
  const weekDays = useMemo(() => Array.from({length: 7}, (_, index) => shiftDate(weekStart(selectedDate), index)), [selectedDate]);
  const manualMutation = useMutation({
    mutationFn: () => ownerAction(business, 'add-booking', {
      serviceSlug, startsAt: dateTimeFromLocal(manualDateTime, business.timezone), customerName: customerName.trim(),
      customerPhone: customerPhone.trim(), vehicle: vehicle.trim(), idempotencyKey: createClientId(),
    }),
    onSuccess: async (result) => {
      setManualError('');
      setManualResult(result && typeof result === 'object' && 'accessToken' in result ? String((result as {accessToken: unknown}).accessToken) : 'Запись добавлена.');
      setCustomerName(''); setCustomerPhone(''); setVehicle('');
      await refresh();
    },
    onError: (caught) => setManualError(caught instanceof Error ? caught.message : 'Не удалось добавить запись.'),
  });
  const logout = async () => { await signOutOwner(); await queryClient.clear(); };
  const queryErrorText = scheduleQuery.error instanceof Error ? scheduleQuery.error.message : 'Не удалось загрузить расписание.';
  const appointments = scheduleQuery.data?.appointments ?? [];
  const dateHead = (date: string) => format(new Date(`${date}T12:00:00Z`), 'EEEE, d MMMM', {locale: ru});

  const addManual = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setManualError(''); setManualResult('');
    manualMutation.mutate();
  };

  return (
    <section className="owner-page">
      <header className="owner-heading">
        <section className="owner-heading-copy"><p className="eyebrow">{business.name}</p><Heading level={1}>Расписание</Heading><Text color="secondary">Записи, этапы работ и фактически полученные оплаты.</Text></section>
        <section className="owner-actions">
          <Button label="Обновить" variant="secondary" icon={<ArrowClockwise />} onClick={() => void scheduleQuery.refetch()} isLoading={scheduleQuery.isFetching} />
          <Button label="Выйти" variant="ghost" icon={<SignOut />} onClick={() => void logout()} />
        </section>
      </header>
      <section className="owner-period-bar">
        <section className="week-picker">
          <Button label="Предыдущий период" tooltip="Предыдущий период" variant="secondary" size="lg" isIconOnly icon={<ArrowLeft />} onClick={() => setSelectedDate(shiftDate(selectedDate, period === 'day' ? -1 : -7))} />
          <label className="field owner-date"><small>Дата</small><input aria-label="Дата расписания" onChange={(event) => setSelectedDate(event.currentTarget.value)} type="date" value={selectedDate} /></label>
          <Button label="Следующий период" tooltip="Следующий период" variant="secondary" size="lg" isIconOnly icon={<ArrowRight />} onClick={() => setSelectedDate(shiftDate(selectedDate, period === 'day' ? 1 : 7))} />
        </section>
        <section className="contact-actions" aria-label="Период расписания">
          <Button label="День" variant={period === 'day' ? 'primary' : 'secondary'} aria-pressed={period === 'day'} onClick={() => setPeriod('day')} />
          <Button label="Неделя" variant={period === 'week' ? 'primary' : 'secondary'} aria-pressed={period === 'week'} onClick={() => setPeriod('week')} />
          <Button label="Добавить запись" variant="secondary" icon={<Wrench />} onClick={() => setShowManual((open) => !open)} />
        </section>
      </section>
      <section className="metric-grid" aria-label="Итоги периода">
        <article className="metric-card"><small>Заездов</small><strong>{scheduleQuery.data?.metrics.arrivals ?? '—'}</strong><small>в выбранном периоде</small></article>
        <article className="metric-card"><small>Завершено</small><strong>{scheduleQuery.data?.metrics.completed ?? '—'}</strong><small>работ</small></article>
        <article className="metric-card"><small>Получено</small><strong>{scheduleQuery.data ? money(scheduleQuery.data.metrics.collectedMinor, business.currency, business.locale) : '—'}</strong><small>по журналу оплат</small></article>
      </section>
      {showManual ? (
        <section className="owner-panel">
          <header className="section-heading"><section><p className="eyebrow">Новая запись</p><Heading level={2}>Добавить вручную</Heading></section></header>
          <form className="field-grid two-column" onSubmit={addManual}>
            <label className="field"><small>Услуга</small><select onChange={(event) => setServiceSlug(event.currentTarget.value)} value={serviceSlug}>{business.services.map((service) => <option key={service.slug} value={service.slug}>{service.name}</option>)}</select></label>
            <label className="field"><small>Дата и время ({business.timezone})</small><input onChange={(event) => setManualDateTime(event.currentTarget.value)} required type="datetime-local" value={manualDateTime} /></label>
            <label className="field"><small>Имя</small><input onChange={(event) => setCustomerName(event.currentTarget.value)} required value={customerName} /></label>
            <label className="field"><small>Телефон</small><input inputMode="tel" onChange={(event) => setCustomerPhone(event.currentTarget.value)} required value={customerPhone} /></label>
            <label className="field"><small>Автомобиль</small><input onChange={(event) => setVehicle(event.currentTarget.value)} required value={vehicle} /></label>
            <Button label="Добавить запись" type="submit" variant="primary" isLoading={manualMutation.isPending} />
          </form>
          {manualError ? <p className="form-error" role="alert">{manualError}</p> : null}
          {manualResult ? <p className="form-success" role="status">{manualResult.length > 80 ? 'Запись добавлена. Код доступа клиента:' : manualResult} {manualResult.length > 80 ? <code>{manualResult}</code> : null}</p> : null}
        </section>
      ) : null}
      {scheduleQuery.isError ? <section className="owner-panel"><p className="form-error" role="alert">{queryErrorText}</p>{hasSupabaseConfig ? <Link to={`/s/${business.slug}/owner/login`}>Войти или проверить доступ к студии</Link> : null}</section> : null}
      {scheduleQuery.isLoading ? <p className="loading-state" role="status">Загружаем записи…</p> : null}
      {scheduleQuery.isSuccess && period === 'day' ? (
        <section className="owner-panel">
          <header className="section-heading"><section><p className="eyebrow">Сегодня в расписании</p><Heading level={2}>{dateHead(selectedDate)}</Heading></section><Text><Clock aria-hidden="true" /> {business.timezone}</Text></header>
          {appointments.length ? <section className="schedule-list">{appointments.map((appointment) => <AppointmentRow appointment={appointment} business={business} key={appointment.id} refresh={refresh} />)}</section> : <p className="empty-state">На эту дату записей нет.</p>}
        </section>
      ) : null}
      {scheduleQuery.isSuccess && period === 'week' ? (
        <section className="week-schedule">
          {weekDays.map((date) => {
            const daily = appointments.filter((appointment) => localDateKey(new Date(appointment.startsAt), business.timezone) === date);
            return <section className="owner-panel week-day-panel" key={date}>
              <header className="section-heading"><Heading level={2}>{dateHead(date)}</Heading><Text type="supporting">{daily.length} {daily.length === 1 ? 'запись' : 'записей'}</Text></header>
              {daily.length ? <section className="schedule-list">{daily.map((appointment) => <AppointmentRow appointment={appointment} business={business} key={appointment.id} refresh={refresh} />)}</section> : <p className="empty-state">Пока свободно.</p>}
            </section>;
          })}
        </section>
      ) : null}
      <footer className="owner-footer"><Text type="supporting">{dayLabel(new Date(`${startDate}T12:00:00Z`))} — данные из кабинета этой студии</Text><Link to={`/s/${business.slug}/owner/settings`}>Услуги, посты и часы работы</Link></footer>
    </section>
  );
}
