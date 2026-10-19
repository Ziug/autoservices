import {useState, type FormEvent} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {ChatCircleDots, PaperPlaneRight} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import type {BusinessConfig} from '@/domain/tenant';
import {createClientId} from '@/lib/id';
import {localDayLabel, localTimeLabel} from '@/lib/format';
import {rememberAccess} from '@/lib/booking-access';
import {sendAssistantMessage, type AssistantBookingDraft} from '@/lib/tenant-api';
import {DrawerPanel} from '@/components/ui/drawer';

type Message = {id: string; role: 'user' | 'assistant'; text: string};

/** A booking created during this conversation, with its access link. */
type CreatedBooking = {appointmentId: string; accessToken: string; startsAt: string; serviceName: string};

const EMPTY_DRAFT: AssistantBookingDraft = {
  serviceSlug: null,
  day: null,
  time: null,
  customerName: '',
  customerPhone: '',
  vehicle: '',
};

/**
 * The collected booking fields live in localStorage so an unfinished booking
 * survives a page reload — otherwise the customer would have to repeat the
 * details they already gave. The idempotency key is stored with them so a
 * reload cannot create a second appointment for the same intent.
 */
type StoredBookingState = {draft: AssistantBookingDraft; idempotencyKey: string};

function bookingStateKey(businessSlug: string) {
  return `autoservices:booking-draft:${businessSlug}`;
}

function loadBookingState(businessSlug: string): StoredBookingState {
  const fallback = {draft: EMPTY_DRAFT, idempotencyKey: createClientId()};
  try {
    const raw = localStorage.getItem(bookingStateKey(businessSlug));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredBookingState>;
    if (!parsed.draft || typeof parsed.idempotencyKey !== 'string') return fallback;
    return {
      draft: {...EMPTY_DRAFT, ...parsed.draft},
      idempotencyKey: parsed.idempotencyKey,
    };
  } catch {
    return fallback;
  }
}

function saveBookingState(businessSlug: string, state: StoredBookingState) {
  try {
    localStorage.setItem(bookingStateKey(businessSlug), JSON.stringify(state));
  } catch {
    // Storage may be unavailable — the booking still works within the session.
  }
}

export function AssistantWidget({business, audience, inline = false}: {business: BusinessConfig; audience: 'client' | 'owner'; inline?: boolean}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  // Collected booking fields survive across turns so the customer can answer
  // "а машина BMW" without repeating the service they already named.
  const [bookingState, setBookingState] = useState(() => loadBookingState(business.slug));
  const {draft, idempotencyKey} = bookingState;
  const [created, setCreated] = useState<CreatedBooking | null>(null);
  const userMessageCount = messages.filter((m) => m.role === 'user').length + 1;
  const mutation = useMutation({
    mutationFn: (message: string) => sendAssistantMessage({
      business,
      audience,
      message,
      messageCount: userMessageCount,
      bookingDraft: draft,
      idempotencyKey,
    }),
    onSuccess: ({answer, draft: nextDraft, booking}) => {
      if (booking) {
        // Store the access pair exactly like the schedule flow does, so the
        // booking shows up in "Моя запись" as if the customer booked it there.
        rememberAccess({
          appointmentId: booking.appointmentId,
          accessToken: booking.accessToken,
          startsAt: booking.startsAt,
          businessSlug: business.slug,
        });
        setCreated({
          appointmentId: booking.appointmentId,
          accessToken: booking.accessToken,
          startsAt: booking.startsAt,
          serviceName: booking.serviceName,
        });
        // The booking is done: drop the draft and start a new idempotency key
        // so the next booking is a separate appointment.
        const reset = {draft: EMPTY_DRAFT, idempotencyKey: createClientId()};
        setBookingState(reset);
        saveBookingState(business.slug, reset);
      } else if (nextDraft) {
        const next = {...bookingState, draft: nextDraft};
        setBookingState(next);
        saveBookingState(business.slug, next);
      }
      setMessages((current) => [...current, {id: createClientId(), role: 'assistant', text: answer}]);
    },
    onError: () => setMessages((current) => [...current, {id: createClientId(), role: 'assistant', text: 'Помощник временно недоступен. Запись по-прежнему можно оформить через расписание.'}]),
  });

  const submit = (message: string) => {
    const clean = message.trim();
    if (!clean || mutation.isPending) return;
    setMessages((current) => [...current, {id: createClientId(), role: 'user', text: clean}]);
    setValue('');
    mutation.mutate(clean);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(value);
  };

  return (
    <>
      <Button
        className={inline ? 'assistant-inline' : 'assistant-fab'}
        label={inline ? 'Спросить помощника' : audience === 'owner' ? 'Открыть помощника владельца' : 'Задать вопрос студии'}
        isIconOnly={!inline}
        icon={<ChatCircleDots weight="fill" />}
        onClick={() => setOpen(true)}
      />
      <DrawerPanel
        open={open}
        onOpenChange={setOpen}
        title={audience === 'owner' ? 'Помощник владельца' : 'Помощник студии'}
        description={audience === 'owner' ? 'Ответы по расписанию и оплатам этой студии.' : 'Уточните услуги, свободное время или адрес.'}
      >
        <section className="assistant-drawer-content">
          {messages.length ? (
            <section className="assistant-thread" aria-live="polite" aria-label="Переписка с помощником">
              {messages.map((message) => <article className="assistant-message" data-role={message.role} key={message.id}>{message.text}</article>)}
              {mutation.isPending ? <p className="assistant-note">Проверяю данные студии…</p> : null}
            </section>
          ) : (
            <section className="assistant-suggestions" aria-label="Примеры вопросов">
              {business.assistantPrompts.map((prompt) => <button className="action-chip" key={prompt} type="button" onClick={() => submit(prompt)}>{prompt}</button>)}
            </section>
          )}
          <form className="assistant-form" onSubmit={onSubmit}>
            <input aria-label="Сообщение помощнику" autoComplete="off" maxLength={500} onChange={(event) => setValue(event.currentTarget.value)} placeholder="Напишите вопрос" value={value} />
            <Button label="Отправить" isIconOnly icon={<PaperPlaneRight weight="fill" />} type="submit" isDisabled={!value.trim() || mutation.isPending} isLoading={mutation.isPending} />
          </form>
          {created ? (
            <section className="assistant-booking-card" aria-live="polite">
              <strong>Запись создана</strong>
              <p>{created.serviceName} · {localDayLabel(created.startsAt, business.timezone)} · {localTimeLabel(created.startsAt, business.timezone)}</p>
              <Link to={`/s/${business.slug}/reservation/${encodeURIComponent(created.appointmentId)}?token=${encodeURIComponent(created.accessToken)}`}>Открыть запись</Link>
              <Link to={`/s/${business.slug}/my-booking`}>Мои записи</Link>
            </section>
          ) : null}
          <p className="assistant-note">Помощник отвечает по данным этой студии. Запись, оформленная в чате, появится в разделе «Моя запись».</p>
        </section>
      </DrawerPanel>
    </>
  );
}
