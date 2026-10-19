import {useEffect, useRef, useState} from 'react';
import {Link, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CalendarPlus, CheckCircle, Copy, MapPin, XCircle} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading, Text} from '@astryxdesign/core/Text';
import {useTenant} from '@/App';
import {DrawerPanel} from '@/components/ui/drawer';
import {localDayLabel, localTimeLabel, money, parseISO} from '@/lib/format';
import {readSavedAccess, subscribeToAccessChanges} from '@/lib/booking-access';
import {cancelAppointment, loadAppointmentAccess, storePushSubscription} from '@/lib/tenant-api';
import type {Appointment} from '@/domain/tenant';

function icsEscape(value: string) {
  return value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
}

function downloadCalendarEvent(businessName: string, appointment: Appointment) {
  const date = (iso: string) => new Date(iso).toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z');
  const content = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AutoServices//Booking//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${appointment.id}@autoservices`, `DTSTAMP:${date(new Date().toISOString())}`,
    `DTSTART:${date(appointment.startsAt)}`, `DTEND:${date(appointment.endsAt)}`,
    `SUMMARY:${icsEscape(`${appointment.serviceName} — ${businessName}`)}`,
    `DESCRIPTION:${icsEscape(`${appointment.customerName} · ${appointment.vehicle}`)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  const blob = new Blob([content], {type: 'text/calendar;charset=utf-8'});
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `booking-${appointment.id}.ics`;
  anchor.click();
  URL.revokeObjectURL(href);
}

function base64UrlToBytes(value: string) {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function standaloneMode() {
  const navigatorWithStandalone = navigator as Navigator & {standalone?: boolean};
  return window.matchMedia('(display-mode: standalone)').matches || navigatorWithStandalone.standalone === true;
}

export function AppointmentPage() {
  const business = useTenant();
  const {appointmentId = ''} = useParams();
  const [searchParams] = useSearchParams();
  const accessToken = searchParams.get('token') ?? '';
  const [copyMessage, setCopyMessage] = useState('');
  const [accessOpen, setAccessOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [messageError, setMessageError] = useState(false);
  const [pushPending, setPushPending] = useState(false);
  const pushGuard = useRef(false);
  const notify = (text: string, isError = false) => { setMessage(text); setMessageError(isError); };
  const queryClient = useQueryClient();
  const appointmentQuery = useQuery({
    queryKey: ['appointment-access', business.slug, appointmentId],
    queryFn: () => loadAppointmentAccess(business, appointmentId, accessToken),
    enabled: Boolean(appointmentId && accessToken),
  });
  const cancelGuard = useRef(false);
  const cancelMutation = useMutation({
    mutationFn: () => cancelAppointment(business, appointmentId, accessToken),
    onSuccess: async () => {
      setCancelOpen(false);
      notify('Запись отменена. Если планы изменятся, вы сможете выбрать новое время.');
      await queryClient.invalidateQueries({queryKey: ['appointment-access', business.slug, appointmentId]});
      // The freed slot must become bookable again without a hard reload.
      await queryClient.invalidateQueries({queryKey: ['availability', business.slug]});
    },
    onError: async (error) => {
      notify(error instanceof Error ? error.message : 'Не удалось отменить запись.', true);
      // Converge the UI: if the booking did cancel despite the error, the
      // refetch hides the cancel button and shows the cancelled state.
      await queryClient.invalidateQueries({queryKey: ['appointment-access', business.slug, appointmentId]});
    },
    onSettled: () => {
      cancelGuard.current = false;
    },
  });
  // Double-tap guard lives at the call site (checking isPending inside
  // mutationFn would always see `true` — the mutation has already started).
  // A ref covers two taps within the same frame, before state flips.
  const requestCancel = () => {
    if (cancelGuard.current || cancelMutation.isPending) return;
    cancelGuard.current = true;
    cancelMutation.mutate();
  };

  const subscribe = async (appointment: Appointment) => {
    if (pushGuard.current) return;
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim();
    const canUsePush = Boolean(vapidKey) && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!canUsePush) {
      notify('Напоминания доступны после добавления студии на экран „Домой“. Добавьте сайт на главный экран, затем включите напоминание.', true);
      return;
    }
    if (!standaloneMode() && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      notify('На iPhone push-напоминания доступны после добавления студии на главный экран. Пока добавьте запись в календарь.', true);
      return;
    }
    // Re-check the 24h window at click time: the page may have been open since
    // the booking was >24h away, but time may have passed. Avoid a pointless
    // request that the server would reject with 409.
    if (new Date(appointment.startsAt).getTime() <= Date.now() + 24 * 60 * 60 * 1000) {
      notify('До записи осталось меньше суток. Добавьте её в календарь.', true);
      return;
    }
    // One request per press: repeated taps used to burn through the server's
    // rate limit (6 per 10 minutes) and only surfaced a cryptic non-2xx error.
    pushGuard.current = true;
    setPushPending(true);
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') { notify('Разрешение на уведомления не выдано. Вы можете добавить запись в календарь.', true); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidKey)});
      await storePushSubscription(business, appointmentId, accessToken, subscription.toJSON());
      notify('Напоминание за сутки включено на этом устройстве.');
    } catch (error) {
      // Handle known error cases with clear messages; fall back to generic text.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('No connection to push daemon')) {
        notify('Push-напоминания пока недоступны на этом устройстве. Добавьте запись в календарь.', true);
      } else if (message.includes('До записи осталось меньше суток') || message.includes('non-2xx')) {
        notify('До записи осталось меньше суток. Добавьте её в календарь.', true);
      } else {
        notify(message || 'Не удалось включить push. Сохраните запись в календарь.', true);
      }
    } finally {
      pushGuard.current = false;
      setPushPending(false);
    }
  };

  const appointment = appointmentQuery.data as Appointment | undefined;
  if (!appointmentId || !accessToken) {
    return <section className="not-found"><Heading level={1}>Нужна ссылка доступа</Heading><Text color="secondary">Откройте ссылку из подтверждения записи или выберите запись из списка.</Text><Link to={`/s/${business.slug}/my-booking`}>Мои записи</Link></section>;
  }
  if (appointmentQuery.isLoading) return <section className="page-content"><p className="loading-state" role="status">Загружаем подтверждение…</p></section>;
  if (appointmentQuery.isError || !appointment) return <section className="not-found" role="alert"><Heading level={1}>Не удалось открыть запись</Heading><Text color="secondary">{appointmentQuery.error instanceof Error ? appointmentQuery.error.message : 'Проверьте ссылку доступа.'}</Text><Link to={`/s/${business.slug}/my-booking`}>Мои записи</Link></section>;

  const startsAtMs = new Date(appointment.startsAt).getTime();
  const canCancel = appointment.status === 'confirmed' && Date.now() < startsAtMs - business.cancellationWindowHours * 60 * 60 * 1000;
  // Mirrors the push-subscribe Edge Function rule: a day-before reminder can
  // only be stored while the booking is more than 24 hours away.
  const reminderAvailable = Date.now() < startsAtMs - 24 * 60 * 60 * 1000;
  return (
    <section className="page-content appointment-page">
      <section className="booking-heading" data-reveal>
        <p className="eyebrow">Подтверждение записи</p>
        <Heading className="booking-title" level={1}>{appointment.status === 'cancelled' ? 'Запись отменена' : 'Вы записаны'}</Heading>
        <Text color="secondary">{business.name} · подтверждено студией</Text>
      </section>
      <Card className="summary-panel appointment-summary">
        <section className="booking-summary"><section><strong>{appointment.serviceName}</strong><p>{localDayLabel(appointment.startsAt, business.timezone)} · {localTimeLabel(appointment.startsAt, business.timezone)}</p></section><strong className="booking-total">{money(appointment.priceMinor, business.currency, business.locale)}</strong></section>
        <Text><strong>{appointment.customerName}</strong> · {appointment.vehicle}</Text>
        <Text><MapPin aria-hidden="true" /> {business.address}, {business.city}</Text>
        <section className="contact-actions">
          <Button label="Добавить в календарь" variant="primary" icon={<CalendarPlus weight="bold" />} onClick={() => downloadCalendarEvent(business.name, appointment)} />
          {appointment.status === 'confirmed' && reminderAvailable ? <Button label="Включить напоминание за сутки" variant="secondary" isLoading={pushPending} isDisabled={pushPending} onClick={() => void subscribe(appointment)} /> : null}
          <Button
            label="Скопировать ссылку доступа"
            variant="secondary"
            icon={<Copy weight="bold" />}
            onClick={() => {
              void navigator.clipboard?.writeText(window.location.href).then(() => {
                setCopyMessage('Ссылка скопирована.');
                setAccessOpen(true);
              });
            }}
          />
        </section>
        {message ? <p className={messageError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
        {appointment.status === 'confirmed' && !reminderAvailable && startsAtMs > Date.now() ? <p className="assistant-note">До записи осталось меньше суток. Добавьте её в календарь.</p> : null}
        {appointment.status === 'confirmed' && canCancel ? <Button label="Отменить запись" variant="destructive" icon={<XCircle weight="bold" />} onClick={() => setCancelOpen(true)} isLoading={cancelMutation.isPending} /> : null}
        {appointment.status === 'confirmed' && !canCancel ? <p className="assistant-note">До начала меньше {business.cancellationWindowHours} ч. Позвоните в студию, чтобы изменить запись.</p> : null}
        {appointment.status === 'cancelled' ? <p className="form-success"><CheckCircle weight="fill" /> Эта запись отменена.</p> : null}
        <Link to={`/s/${business.slug}/`}>Вернуться на страницу студии</Link>
      </Card>
      <DrawerPanel open={cancelOpen} onOpenChange={setCancelOpen} title="Отменить запись?" description="Пост освободится, и его сможет занять другой клиент.">
        <section className="contact-actions"><Button label="Оставить запись" variant="secondary" onClick={() => setCancelOpen(false)} /><Button label="Подтвердить отмену" variant="destructive" isLoading={cancelMutation.isPending} isDisabled={cancelMutation.isPending} onClick={requestCancel} /></section>
      </DrawerPanel>
      <DrawerPanel open={accessOpen} onOpenChange={setAccessOpen} title="Номер записи и код доступа" description="Сохраните эти данные, чтобы открыть запись на другом устройстве.">
        <section className="field-grid">
          <label className="field">
            <small>Номер записи</small>
            <input readOnly value={appointmentId} />
          </label>
          <label className="field">
            <small>Код доступа</small>
            <input readOnly value={accessToken} />
          </label>
          <p className="assistant-note" role="status">
            {copyMessage || 'Откройте «Моя запись» и введите эти два значения, чтобы увидеть или отменить запись на другом устройстве.'}
          </p>
        </section>
      </DrawerPanel>
    </section>
  );
}

export function MyBookingPage() {
  const business = useTenant();
  const [appointmentId, setAppointmentId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  // The access list is written from outside React (the schedule flow and the
  // assistant widget), so it has to be re-read on change — a localStorage
  // write alone does not re-render this page.
  const [saved, setSaved] = useState(() => readSavedAccess(business.slug));
  useEffect(() => {
    setSaved(readSavedAccess(business.slug));
    return subscribeToAccessChanges(business.slug, () => setSaved(readSavedAccess(business.slug)));
  }, [business.slug]);
  const selected = saved[0];
  return (
    <section className="page-content my-booking-page">
      <section className="booking-heading"><p className="eyebrow">Управление записью</p><Heading className="booking-title" level={1}>Моя запись</Heading><Text color="secondary">Откройте защищённую ссылку из подтверждения. Код доступа хранится только на вашем устройстве.</Text></section>
      {selected ? <Card className="summary-panel"><section className="booking-summary"><section><strong>Ближайшая сохранённая запись</strong><p>{localDayLabel(selected.startsAt, business.timezone)} · {localTimeLabel(selected.startsAt, business.timezone)}</p></section></section><Link to={`/s/${business.slug}/reservation/${encodeURIComponent(selected.appointmentId)}?token=${encodeURIComponent(selected.accessToken)}`}>Открыть запись</Link></Card> : null}
      <Card className="booking-panel">
        <Heading level={2}>Открыть по коду доступа</Heading>
        <Text color="secondary">Введите номер записи и длинный код из ссылки, если вы открыли сайт на другом устройстве.</Text>
        <form className="field-grid" onSubmit={(event) => { event.preventDefault(); if (appointmentId && accessToken) window.location.assign(`/s/${business.slug}/reservation/${encodeURIComponent(appointmentId)}?token=${encodeURIComponent(accessToken)}`); }}>
          <label className="field"><small>Номер записи</small><input autoComplete="off" onChange={(event) => setAppointmentId(event.currentTarget.value)} required value={appointmentId} /></label>
          <label className="field"><small>Код доступа</small><input autoComplete="off" onChange={(event) => setAccessToken(event.currentTarget.value)} required value={accessToken} /></label>
          <Button label="Открыть запись" type="submit" variant="primary" isDisabled={!appointmentId || !accessToken} />
        </form>
        <Link to={`/s/${business.slug}/booking`}>Новая запись</Link>
      </Card>
    </section>
  );
}
