import {useState, type FormEvent} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {ChatCircleDots, PaperPlaneRight} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import type {BusinessConfig} from '@/domain/tenant';
import {createClientId} from '@/lib/id';
import {rememberAccess} from '@/lib/booking-access';
import {sendAssistantMessage, type AssistantBookingDraft} from '@/lib/tenant-api';
import {DrawerPanel} from '@/components/ui/drawer';

type Message = {id: string; role: 'user' | 'assistant'; text: string};

const EMPTY_DRAFT: AssistantBookingDraft = {
  serviceSlug: null,
  day: null,
  time: null,
  customerName: '',
  customerPhone: '',
  vehicle: '',
};

export function AssistantWidget({business, audience, inline = false}: {business: BusinessConfig; audience: 'client' | 'owner'; inline?: boolean}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  // Collected booking fields survive across turns so the customer can answer
  // "а машина BMW" without repeating the service they already named.
  const [draft, setDraft] = useState<AssistantBookingDraft>(EMPTY_DRAFT);
  // Stable per draft: the same booking intent retried resolves to the same
  // appointment instead of creating a second one.
  const [idempotencyKey, setIdempotencyKey] = useState(() => createClientId());
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
      if (nextDraft) setDraft(nextDraft);
      if (booking) {
        // Store the access pair exactly like the schedule flow does, so the
        // booking shows up in "Моя запись" as if the customer booked it there.
        rememberAccess({
          appointmentId: booking.appointmentId,
          accessToken: booking.accessToken,
          startsAt: booking.startsAt,
          businessSlug: business.slug,
        });
        setDraft(EMPTY_DRAFT);
        setIdempotencyKey(createClientId());
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
          <p className="assistant-note">Помощник отвечает по данным этой студии. Запись, оформленная в чате, появится в разделе «Моя запись».</p>
          <Link to={`/s/${business.slug}/my-booking`}>Мои записи</Link>
        </section>
      </DrawerPanel>
    </>
  );
}
