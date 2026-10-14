import {useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent} from 'react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {addDays} from 'date-fns';
import {ru} from 'date-fns/locale';
import {formatInTimeZone, fromZonedTime} from 'date-fns-tz';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Clock, X} from '@phosphor-icons/react';
import {BottomSheet} from '@astryxdesign/core/BottomSheet';
import {Button} from '@astryxdesign/core/Button';
import {DateInput} from '@astryxdesign/core/DateInput';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Step, Stepper} from '@astryxdesign/core/Stepper';
import {Heading, Text} from '@astryxdesign/core/Text';
import type {ISODateString} from '@astryxdesign/core/Calendar';
import {bookingContactSchema, type BookingContact} from '@/domain/booking';
import type {Appointment, Service} from '@/domain/tenant';
import {useTenant} from '@/App';
import {money, localDateKey, localTimeLabel, parseISO} from '@/lib/format';
import {createClientId} from '@/lib/id';
import {getDefaultBookingDate, loadAvailability, reserveAppointment} from '@/lib/tenant-api';

type SavedAccess = {appointmentId: string; accessToken: string; startsAt: string; businessSlug: string};
type FlowStep = 'service' | 'schedule' | 'contact' | 'review';
type ContactField = keyof BookingContact;
type ContactErrors = Partial<Record<ContactField, string>>;

const FLOW_STEPS: {id: FlowStep; title: string}[] = [
  {id: 'service', title: 'Выберите вариант'},
  {id: 'schedule', title: 'Дата и время'},
  {id: 'contact', title: 'Контактные данные'},
  {id: 'review', title: 'Проверьте запись'},
];

function dateOptions(timezone: string, selectedDate: string) {
  const today = localDateKey(new Date(), timezone);
  const selectedNoon = fromZonedTime(`${selectedDate}T12:00:00`, timezone);
  const preferredStart = formatInTimeZone(addDays(selectedNoon, -3), timezone, 'yyyy-MM-dd');
  const start = preferredStart < today ? today : preferredStart;
  const noon = fromZonedTime(`${start}T12:00:00`, timezone);
  return Array.from({length: 7}, (_, index) => {
    const instant = addDays(noon, index);
    const key = formatInTimeZone(instant, timezone, 'yyyy-MM-dd');
    const weekday = formatInTimeZone(instant, timezone, 'EEEE', {locale: ru});
    const shortName = formatInTimeZone(instant, timezone, 'EEEEEE', {locale: ru});
    const weekdayShort = shortName.charAt(0).toLocaleUpperCase('ru-RU') + shortName.slice(1);
    return {key, weekday, weekdayShort, day: formatInTimeZone(instant, timezone, 'd'), accessibleDate: formatInTimeZone(instant, timezone, 'd MMMM', {locale: ru})};
  });
}

function durationLabel(service: Service) {
  if (service.durationMinutes >= 1440) return `${Math.round(service.durationMinutes / 1440)} дн.`;
  const hours = Math.floor(service.durationMinutes / 60);
  const minutes = service.durationMinutes % 60;
  return minutes ? `${hours} ч. ${minutes} мин.` : `${hours} ч.`;
}

function themeDurationMs(fallbackMs: number) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--duration-medium').trim();
  const parsed = raw.endsWith('ms') ? Number.parseFloat(raw) : raw.endsWith('s') ? Number.parseFloat(raw) * 1000 : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function rememberAccess(appointment: Appointment, accessToken: string, businessSlug: string) {
  const key = `autoservices:access:${businessSlug}`;
  let saved: SavedAccess[] = [];
  try { saved = JSON.parse(localStorage.getItem(key) ?? '[]') as SavedAccess[]; } catch { saved = []; }
  const next = [{appointmentId: appointment.id, accessToken, startsAt: appointment.startsAt, businessSlug}, ...saved.filter((entry) => entry.appointmentId !== appointment.id)].slice(0, 10);
  localStorage.setItem(key, JSON.stringify(next));
}

export function BookingPage() {
  const business = useTenant();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialService = searchParams.get('service') ?? business.services[0]?.slug ?? '';
  const [activeSheet, setActiveSheet] = useState<FlowStep | null>('service');
  const [serviceSlug, setServiceSlug] = useState(initialService);
  const [day, setDay] = useState(() => getDefaultBookingDate(business));
  const [startsAt, setStartsAt] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [fieldErrors, setFieldErrors] = useState<ContactErrors>({});
  const [formError, setFormError] = useState('');
  const [flowDirection, setFlowDirection] = useState<1 | -1>(1);
  const [hasNavigated, setHasNavigated] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientId());
  // Synchronous double-submit guard. bookingMutation.isPending flips only
  // after a re-render, so two taps within the same frame would both pass an
  // isPending check and fire redundant requests with the same key.
  const submitGuard = useRef(false);
  const service = business.services.find((item) => item.slug === serviceSlug) ?? business.services[0];
  const dates = useMemo(() => dateOptions(business.timezone, day), [business.timezone, day]);
  const availabilityQuery = useQuery({
    queryKey: ['availability', business.slug, service?.slug, day],
    queryFn: () => loadAvailability(business, service!, day),
    enabled: Boolean(service && day),
  });
  const availableSlots = useMemo(() => availabilityQuery.data?.filter((slot) => slot.availableCount > 0) ?? [], [availabilityQuery.data]);
  // Weekday of the selected day in studio time (0 = Sunday, matches openingHours).
  const selectedWeekday = useMemo(() => {
    const noon = fromZonedTime(`${day}T12:00:00`, business.timezone);
    return Number(formatInTimeZone(noon, business.timezone, 'i')) % 7;
  }, [day, business.timezone]);
  const openThatDay = business.openingHours.some((hours) => hours.weekday === selectedWeekday);
  // Same compatibility rule as the server (and admin validation): with zero
  // compatible active posts the service can never produce a slot.
  const compatiblePosts = useMemo(() => {
    if (!service) return [];
    const types = service.resourceTypes ?? ['any'];
    return business.resources.filter(
      (resource) => (resource.active ?? true) && (types.includes('any') || resource.resourceType === 'any' || types.includes(resource.resourceType)),
    );
  }, [service, business.resources]);
  const selectedSlot = availabilityQuery.data?.find((slot) => slot.startsAt === startsAt);
  const queryClient = useQueryClient();
  const refreshAvailability = () => queryClient.invalidateQueries({queryKey: ['availability', business.slug]});
  const bookingMutation = useMutation({
    mutationFn: (contact: BookingContact) => reserveAppointment({business, service: service!, startsAt, ...contact, idempotencyKey}),
    onSuccess: ({appointment, accessToken}) => {
      rememberAccess(appointment, accessToken, business.slug);
      // The booked slot must disappear even if the customer goes Back:
      // drop every cached availability entry for this studio before leaving.
      void refreshAvailability();
      navigate(`/s/${business.slug}/reservation/${encodeURIComponent(appointment.id)}?token=${encodeURIComponent(accessToken)}`);
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Не удалось оформить запись. Попробуйте ещё раз.';
      if (/только что заняли/i.test(message)) {
        // Someone took the slot: the cached day is stale, refetch it so the
        // customer sees current availability instead of retrying blindly.
        void refreshAvailability();
      }
      setFormError(
        /idempotency key mismatch/i.test(message)
          ? 'Данные отличаются от предыдущей попытки. Проверьте «Мою запись» — возможно, запись уже создана. Иначе вернитесь и отправьте заново.'
          : message,
      );
    },
    onSettled: () => {
      submitGuard.current = false;
    },
  });

  useEffect(() => {
    if (!business.services.some((item) => item.slug === serviceSlug)) setServiceSlug(business.services[0]?.slug ?? '');
  }, [business.services, serviceSlug]);

  useEffect(() => {
    setFormError('');
  }, [activeSheet]);

  function closeFlow() {
    navigate(`/s/${business.slug}/`);
  }

  function handleSheetOpenChange(isOpen: boolean) {
    if (!isOpen) closeFlow();
  }

  function goTo(next: FlowStep) {
    const currentIndex = activeSheet ? FLOW_STEPS.findIndex((step) => step.id === activeSheet) : -1;
    const nextIndex = FLOW_STEPS.findIndex((step) => step.id === next);
    setFlowDirection(nextIndex >= currentIndex ? 1 : -1);
    setHasNavigated(true);
    setActiveSheet(next);
  }

  function onServiceChange(slug: string) {
    setServiceSlug(slug);
    setSearchParams({service: slug}, {replace: true});
    setStartsAt('');
    setFormError('');
    setIdempotencyKey(createClientId());
  }

  function selectDay(key: string) {
    setDay(key);
    setStartsAt('');
    setFormError('');
    setIdempotencyKey(createClientId());
  }

  function selectTime(instant: string) {
    setStartsAt(instant);
    setFormError('');
    setIdempotencyKey(createClientId());
  }

  function validateContact() {
    const parsed = bookingContactSchema.safeParse({customerName, customerPhone, vehicle});
    if (!parsed.success) {
      const nextErrors: ContactErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'customerName' || field === 'customerPhone' || field === 'vehicle') nextErrors[field] ??= issue.message;
      }
      setFieldErrors(nextErrors);
      return null;
    }
    setFieldErrors({});
    return parsed.data;
  }

  function continueToReview() {
    if (!startsAt || !selectedSlot?.availableCount) {
      setFormError('Выберите свободное время.');
      return;
    }
    setFormError('');
    goTo('contact');
  }

  function continueFromContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateContact()) return;
    goTo('review');
  }

  function submitBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Double-submit guard: the in-flight request already carries this step's
    // idempotency key, so a second tap must not fire a redundant request.
    // A ref (not isPending) because state flips only after a re-render.
    if (submitGuard.current || bookingMutation.isPending) return;
    setFormError('');
    if (!service) { setFormError('Выберите вариант.'); goTo('service'); return; }
    if (!startsAt || !selectedSlot?.availableCount) { setFormError('Выбранное время больше недоступно. Выберите другое.'); goTo('schedule'); return; }
    const contact = validateContact();
    if (!contact) { goTo('contact'); return; }
    // Latch only here: every early return above never calls mutate, so
    // onSettled would never fire to release the guard (stranded form).
    submitGuard.current = true;
    bookingMutation.mutate(contact);
  }

  const formatPrice = (candidate: Service) => candidate.priceMinor ? money(candidate.priceMinor, business.currency, business.locale) : 'Бесплатно';
  const selectedDay = dates.find((option) => option.key === day);
  const selectedDateLabel = startsAt ? formatInTimeZone(parseISO(startsAt), business.timezone, 'EEEE, d MMMM', {locale: ru}) : selectedDay?.day ?? '';
  const selectedTimeLabel = startsAt ? localTimeLabel(startsAt, business.timezone) : '';
  const currentStep: FlowStep = activeSheet ?? 'service';
  const activeIndex = FLOW_STEPS.findIndex((item) => item.id === currentStep);
  const currentTitle = FLOW_STEPS[activeIndex]?.title ?? '';
  const flowRef = useRef<HTMLElement | null>(null);
  const slideRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const node = flowRef.current;
    if (!node || !hasNavigated || !activeSheet) return;
    slideRef.current?.cancel();
    slideRef.current = null;
    let scrollable: HTMLElement | null = node;
    while (scrollable) {
      if (scrollable.scrollHeight > scrollable.clientHeight + 1) {
        scrollable.scrollTop = 0;
        break;
      }
      scrollable = scrollable.parentElement;
    }
    node.focus({preventScroll: true});
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const from = flowDirection === 1 ? '6%' : '-6%';
    slideRef.current = node.animate(
      [
        {opacity: '0', transform: `translateX(${from})`},
        {opacity: '1', transform: 'translateX(0)'},
      ],
      {duration: themeDurationMs(240), easing: 'ease-out'},
    );
    return () => {
      slideRef.current?.cancel();
      slideRef.current = null;
    };
  }, [activeSheet, flowDirection, hasNavigated]);
  return (
    <main className="page-content booking-page">
      <section className="booking-stage" aria-label={`Онлайн-запись в студию ${business.name}`}>
        <img className="booking-stage-photo" src={business.heroImage} alt="" aria-hidden="true" fetchPriority="high" onError={(event) => { event.currentTarget.src = business.logoImage; }} />
        <section className="booking-stage-copy">
          <p className="eyebrow">Запись в студию · 2 минуты</p>
          <Heading className="booking-stage-title" level={1}>{business.name}</Heading>
          <Text>{business.tagline}</Text>
        </section>
      </section>

      <BottomSheet
        className="booking-bottom-sheet"
        isOpen={activeSheet !== null}
        onOpenChange={handleSheetOpenChange}
        purpose="form"
        label={`${currentTitle} · шаг ${activeIndex + 1} из 4`}
        height="70dvh"
        padding={0}>
        <section
          key={currentStep}
          ref={flowRef}
          className="booking-flow"
          tabIndex={-1}
          aria-labelledby={`booking-title-${currentStep}`}>
          <section className="booking-flow-top">
            <header className="booking-flow-header">
              <section className="booking-flow-heading">
                <Heading className={`booking-flow-title${currentStep === 'schedule' ? ' booking-schedule-title' : ''}`} id={`booking-title-${currentStep}`} level={2}>{currentTitle}</Heading>
              </section>
              <IconButton className="booking-flow-close" label="Закрыть запись" icon={<X aria-hidden="true" />} variant="ghost" onClick={closeFlow} />
            </header>

            <Stepper
              activeStep={activeIndex}
                  label="Этапы записи"
                  orientation="horizontal"
                  density="compact"
                  horizontalOptions={{minimumStepWidth: 9999, collapsedVariant: 'hiddenLabel'}}>
                  <Step step={0} label={FLOW_STEPS[0].title} indicator="none" />
                  <Step step={1} label={FLOW_STEPS[1].title} indicator="none" />
                  <Step step={2} label={FLOW_STEPS[2].title} indicator="none" />
                  <Step step={3} label={FLOW_STEPS[3].title} indicator="none" />
                </Stepper>
              </section>

              {currentStep === 'service' ? (
                <>
                  <section className="booking-flow-body">
                    <section className="booking-service-list" role="radiogroup" aria-label="Доступные варианты">
                      {business.services.map((candidate) => {
                        const isSelected = serviceSlug === candidate.slug;
                        return (
                          <button className="booking-service-option" type="button" role="radio" aria-checked={isSelected} key={candidate.slug} onClick={() => onServiceChange(candidate.slug)}>
                            <strong className="booking-service-name">{candidate.name}</strong>
                            <small className="booking-service-meta">{durationLabel(candidate)} · {candidate.category}</small>
                            <strong className="booking-service-price">{formatPrice(candidate)}</strong>
                          </button>
                        );
                      })}
                    </section>
                  </section>
                  <footer className="booking-flow-footer">
                    <Button className="booking-flow-primary" label="Выбрать дату" variant="primary" size="lg" isDisabled={!service} onClick={() => goTo('schedule')} />
                  </footer>
                </>
              ) : null}

              {currentStep === 'schedule' ? (
                <>
                  <section className="booking-flow-body booking-schedule-body">
                    {service ? <section className="booking-selection-summary booking-schedule-service"><strong>{service.name}</strong><strong>{formatPrice(service)}</strong></section> : null}
                    <section className="booking-date-section" aria-label="Выберите дату">
                      <section className="booking-date-list">
                        {dates.map((option) => <button className="booking-date-option" type="button" key={option.key} aria-label={`${option.weekday}, ${option.accessibleDate}`} aria-pressed={day === option.key} onClick={() => selectDay(option.key)}><strong>{option.weekdayShort}</strong><small>{option.day}</small></button>)}
                      </section>
                      <section className="booking-other-date-section">
                        <Text aria-hidden="true" className="booking-other-date-label">Другая дата</Text>
                        <DateInput
                          className="booking-other-date-control"
                          label="Другая дата"
                          isLabelHidden
                          value={day as ISODateString}
                          min={localDateKey(new Date(), business.timezone) as ISODateString}
                          presentation="adaptive-native"
                          size="lg"
                          format={(value) => formatInTimeZone(fromZonedTime(`${value}T12:00:00`, business.timezone), business.timezone, "d MMM yyyy 'г.'", {locale: ru})}
                          onChange={(value) => { if (value) selectDay(value); }}
                        />
                      </section>
                    </section>

                    <section className="booking-time-section" aria-label="Выберите время">
                      <section className="booking-section-caption"><Clock aria-hidden="true" /><Text>Время студии</Text></section>
                      {availabilityQuery.isLoading ? <p className="booking-inline-state" role="status">Проверяем расписание…</p> : null}
                      {availabilityQuery.isError ? <section className="booking-inline-error" role="alert"><Text>{availabilityQuery.error instanceof Error ? availabilityQuery.error.message : 'Не удалось загрузить расписание.'}</Text><Button label="Повторить" variant="secondary" size="sm" onClick={() => void availabilityQuery.refetch()} /></section> : null}
                      {availabilityQuery.isSuccess && !availableSlots.length ? (
                        <p className="booking-inline-state" role="status">
                          {!openThatDay
                            ? 'В этот день студия закрыта по обычному графику. Выберите другой день.'
                            : service && compatiblePosts.length === 0
                              ? 'Для этой услуги сейчас нет подходящего поста. Позвоните в студию — подскажем варианты.'
                              : 'На эту дату свободных окон нет. Попробуйте соседний день.'}
                        </p>
                      ) : null}
                      {availableSlots.length ? (
                        <section className="booking-time-list" aria-label="Доступные окна">
                          {availableSlots.map((slot) => {
                            const time = localTimeLabel(slot.startsAt, business.timezone);
                            return <button className="booking-time-option" type="button" key={slot.startsAt} aria-label={`${time}, свободно`} aria-pressed={startsAt === slot.startsAt} onClick={() => selectTime(slot.startsAt)}><strong>{time}</strong></button>;
                          })}
                        </section>
                      ) : null}
                    </section>
                    {formError ? <p className="booking-inline-error" role="alert">{formError}</p> : null}
                  </section>
                  <footer className="booking-flow-footer booking-flow-footer-split">
                    <Button className="booking-flow-back" label="Назад" variant="secondary" onClick={() => goTo('service')} />
                    <Button className="booking-flow-primary" label="Продолжить" variant="primary" size="lg" isDisabled={!startsAt || !selectedSlot?.availableCount || availabilityQuery.isLoading} onClick={continueToReview} />
                  </footer>
                </>
              ) : null}

              {currentStep === 'contact' ? (
                <form className="booking-flow-body booking-contact-form" onSubmit={continueFromContact} noValidate>
                  {service && startsAt ? (
                    <section className="booking-contact-summary" aria-label="Выбранный вариант и время">
                      <section className="booking-selection-summary booking-schedule-service"><strong>{service.name}</strong><strong>{formatPrice(service)}</strong></section>
                      <section className="booking-selection-summary"><strong>{selectedDateLabel} · {selectedTimeLabel}</strong><button type="button" onClick={() => goTo('schedule')}>Изменить</button></section>
                    </section>
                  ) : null}
                  <section className="booking-contact-fields">
                    <label className="booking-field">
                      <small>Имя</small>
                      <input autoComplete="name" aria-invalid={Boolean(fieldErrors.customerName)} aria-describedby={fieldErrors.customerName ? 'booking-name-error' : undefined} maxLength={100} name="customerName" onChange={(event) => { setCustomerName(event.currentTarget.value); setFieldErrors((current) => ({...current, customerName: undefined})); }} placeholder="Как к вам обращаться" value={customerName} />
                      {fieldErrors.customerName ? <small className="booking-field-error" id="booking-name-error">{fieldErrors.customerName}</small> : null}
                    </label>
                    <label className="booking-field">
                      <small>Телефон</small>
                      <input autoComplete="tel" aria-invalid={Boolean(fieldErrors.customerPhone)} aria-describedby={fieldErrors.customerPhone ? 'booking-phone-error' : undefined} inputMode="tel" maxLength={40} name="customerPhone" onChange={(event) => { setCustomerPhone(event.currentTarget.value); setFieldErrors((current) => ({...current, customerPhone: undefined})); }} placeholder="+7 900 000-00-00" value={customerPhone} />
                      {fieldErrors.customerPhone ? <small className="booking-field-error" id="booking-phone-error">{fieldErrors.customerPhone}</small> : null}
                    </label>
                    <label className="booking-field">
                      <small>Автомобиль</small>
                      <input autoComplete="off" aria-invalid={Boolean(fieldErrors.vehicle)} aria-describedby={fieldErrors.vehicle ? 'booking-vehicle-error' : undefined} maxLength={120} name="vehicle" onChange={(event) => { setVehicle(event.currentTarget.value); setFieldErrors((current) => ({...current, vehicle: undefined})); }} placeholder="Марка и модель" value={vehicle} />
                      {fieldErrors.vehicle ? <small className="booking-field-error" id="booking-vehicle-error">{fieldErrors.vehicle}</small> : null}
                    </label>
                  </section>
                  <footer className="booking-flow-footer booking-flow-footer-split">
                    <Button className="booking-flow-back" label="Назад" variant="secondary" onClick={() => goTo('schedule')} />
                    <Button className="booking-flow-primary" label="Проверить запись" variant="primary" size="lg" type="submit" />
                  </footer>
                </form>
              ) : null}

              {currentStep === 'review' ? (
                <form className="booking-flow-body booking-review-form" onSubmit={submitBooking} noValidate>
                  <section className="booking-review-card" aria-label="Данные записи">
                    <header className="booking-review-service">
                      <section>
                        <strong>{service?.name}</strong>
                        <small>{service ? durationLabel(service) : ''}</small>
                      </section>
                      <strong className="booking-review-price">{service ? formatPrice(service) : ''}</strong>
                    </header>
                    <section className="booking-review-row"><Text color="secondary">Дата и время</Text><strong>{selectedDateLabel} · {selectedTimeLabel}</strong></section>
                    <section className="booking-review-row"><Text color="secondary">Имя</Text><strong>{customerName.trim()}</strong></section>
                    <section className="booking-review-row"><Text color="secondary">Телефон</Text><strong>{customerPhone.trim()}</strong></section>
                    <section className="booking-review-row"><Text color="secondary">Автомобиль</Text><strong>{vehicle.trim()}</strong></section>
                  </section>
                  <Text className="booking-review-note" color="secondary">Ссылка для управления записью придёт после подтверждения.</Text>
                  {formError ? <p className="booking-inline-error" role="alert">{formError}</p> : null}
                  <footer className="booking-flow-footer booking-flow-footer-split">
                    <Button className="booking-flow-back" label="Назад" variant="secondary" onClick={() => goTo('contact')} />
                    <Button className="booking-flow-primary" label="Подтвердить запись" variant="primary" size="lg" type="submit" isLoading={bookingMutation.isPending} isDisabled={bookingMutation.isPending} />
                  </footer>
                </form>
              ) : null}
            </section>
          </BottomSheet>

    </main>
  );
}
