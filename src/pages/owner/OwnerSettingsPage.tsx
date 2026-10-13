import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Plus, UploadSimple} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import type {BusinessConfig, Service} from '@/domain/tenant';
import {useTenant} from '@/App';
import {createClientId} from '@/lib/id';
import {loadBusiness, ownerAction} from '@/lib/tenant-api';
import {hasSupabaseConfig, supabase} from '@/lib/supabase';

const allowedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Collapses `details[data-collapse-mobile]` on first render at phone
 * widths. Attribute-only change: fields stay mounted, so expanding or
 * collapsing never resets unsaved input values. Desktop keeps every
 * group open, matching the current layout.
 */
function useCollapseOnMobile() {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (window.matchMedia('(max-width: 43.99rem)').matches) {
      ref.current?.querySelectorAll('details[data-collapse-mobile][open]').forEach((item) => item.removeAttribute('open'));
    }
  }, []);
  return ref;
}

function durationLabel(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const remaining = minutes % 1440;
    return remaining ? `${days} дн. ${Math.floor(remaining / 60)} ч.` : `${days} дн.`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} ч. ${remaining} мин.` : `${hours} ч.`;
}

function DayHoursRow({day, weekday, hours}: {day: string; weekday: number; hours?: {opensAt: string; closesAt: string}}) {
  const [open, setOpen] = useState(Boolean(hours));
  return (
    <section className="hours-editor-row" data-open={open}>
      <label className="checkbox-field"><input defaultChecked={open} name={`hours-open-${weekday}`} type="checkbox" onChange={(event) => setOpen(event.currentTarget.checked)} /><small>{day}</small></label>
      <label className="field"><small>Открытие</small><input defaultValue={hours?.opensAt ?? '09:00'} name={`hours-start-${weekday}`} type="time" disabled={!open} /></label>
      <label className="field"><small>Закрытие</small><input defaultValue={hours?.closesAt ?? '19:00'} name={`hours-end-${weekday}`} type="time" disabled={!open} /></label>
    </section>
  );
}

function SettingsForm({business}: {business: BusinessConfig}) {
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const sectionRef = useCollapseOnMobile();
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (profile: Record<string, unknown>) => ownerAction(business, 'update-profile', {profile}),
    onSuccess: async () => {
      setMessage('Настройки сохранены.');
      await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug});
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Не удалось сохранить настройки.'),
  });
  const field = (key: keyof BusinessConfig, label: string, value: string, type = 'text') => (
    <label className="field" key={String(key)}><small>{label}</small><input defaultValue={value} name={String(key)} type={type} /></label>
  );
  const saveForm = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const openingHours = Array.from({length: 7}, (_, weekday) => {
      if (data.get(`hours-open-${weekday}`) !== 'on') return null;
      return {weekday, opensAt: String(data.get(`hours-start-${weekday}`)), closesAt: String(data.get(`hours-end-${weekday}`))};
    }).filter((hours): hours is {weekday: number; opensAt: string; closesAt: string} => Boolean(hours));
    save.mutate({
      name: data.get('name'), tagline: data.get('tagline'), description: data.get('description'), city: data.get('city'),
      address: data.get('address'), phone: data.get('phone'), mapUrl: data.get('mapUrl'), timezone: data.get('timezone'),
      currency: data.get('currency'), locale: data.get('locale'), accentColor: data.get('accentColor'),
      heroImage: data.get('heroImage'), logoImage: data.get('logoImage'),
      bookingStepMinutes: Number(data.get('bookingStepMinutes')), cancellationWindowHours: Number(data.get('cancellationWindowHours')),
      openingHours,
    });
  };
  const upload = async (file: File, fieldName: 'heroImage' | 'logoImage') => {
    if (!supabase) { setMessage('Загрузка фотографий включится после настройки Supabase.'); return; }
    if (!allowedImageTypes.includes(file.type) || file.size > 15 * 1024 * 1024) { setMessage('Выберите JPG, PNG или WebP размером до 15 МБ.'); return; }
    setUploading(fieldName); setMessage('');
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const path = `${business.slug}/site/${fieldName}-${createClientId()}.${extension}`;
      const {error} = await supabase.storage.from('tenant-media').upload(path, file, {upsert: false, contentType: file.type});
      if (error) throw error;
      const {data} = supabase.storage.from('tenant-media').getPublicUrl(path);
      const input = formRef.current?.elements.namedItem(fieldName);
      if (input instanceof HTMLInputElement) input.value = data.publicUrl;
      setMessage(fieldName === 'heroImage' ? 'Главное фото загружено. Сохраните данные студии.' : 'Логотип загружен. Сохраните данные студии.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить фотографию.');
    } finally {
      setUploading('');
    }
  };
  const weekdays = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

  return (
    <section className="owner-panel" id="set-profile" ref={sectionRef}>
      <header className="section-heading"><section><p className="eyebrow">Профиль</p><Heading level={2}>Данные студии</Heading></section><Text type="supporting">Их увидят посетители страницы и записи.</Text></header>
      <form className="field-grid two-column" onSubmit={saveForm} ref={formRef}>
        <details className="set-group two-column-span" open>
          <summary>Основная информация</summary>
          <section className="field-grid two-column">
            {field('name', 'Название', business.name)}
            {field('tagline', 'Короткий заголовок', business.tagline)}
            <label className="field two-column-span"><small>Описание</small><textarea defaultValue={business.description} name="description" /></label>
          </section>
        </details>
        <details className="set-group two-column-span" open data-collapse-mobile>
          <summary>Контакты и адрес</summary>
          <section className="field-grid two-column">
            {field('city', 'Город', business.city)}
            {field('address', 'Адрес', business.address)}
            {field('phone', 'Телефон', business.phone, 'tel')}
            {field('mapUrl', 'Ссылка на карту', business.mapUrl ?? '', 'url')}
          </section>
        </details>
        <details className="set-group two-column-span" open data-collapse-mobile>
          <summary>Оформление</summary>
          <section className="field-grid two-column">
            {field('currency', 'Валюта ISO', business.currency)}
            {field('locale', 'Локаль', business.locale)}
            {field('accentColor', 'Акцентный цвет', business.accentColor, 'color')}
            {field('heroImage', 'Фото на главной', business.heroImage, 'url')}
            <label className="upload-control"><UploadSimple aria-hidden="true" /><small>{uploading === 'heroImage' ? 'Загружаем фото…' : 'Загрузить фото на главную'}</small><input accept="image/jpeg,image/png,image/webp" disabled={!hasSupabaseConfig || Boolean(uploading)} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void upload(file, 'heroImage'); event.currentTarget.value = ''; }} type="file" /></label>
            {field('logoImage', 'Логотип', business.logoImage, 'url')}
            <label className="upload-control"><UploadSimple aria-hidden="true" /><small>{uploading === 'logoImage' ? 'Загружаем логотип…' : 'Загрузить логотип'}</small><input accept="image/jpeg,image/png,image/webp" disabled={!hasSupabaseConfig || Boolean(uploading)} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void upload(file, 'logoImage'); event.currentTarget.value = ''; }} type="file" /></label>
          </section>
        </details>
        <details className="set-group two-column-span" open data-collapse-mobile>
          <summary>Расписание и отмена</summary>
          <section className="field-grid two-column">
            {field('timezone', 'Часовой пояс IANA', business.timezone)}
            {field('bookingStepMinutes', 'Шаг расписания, минут', String(business.bookingStepMinutes), 'number')}
            {field('cancellationWindowHours', 'Отмена не позднее, часов', String(business.cancellationWindowHours), 'number')}
          </section>
        </details>
        <section className="field-grid two-column-span">
          <header className="section-heading"><section><Heading level={3}>Еженедельный график</Heading><Text type="supporting">Снимите отметку у закрытых дней и измените часы работы.</Text></section></header>
          {weekdays.map((day, weekday) => {
            const hours = business.openingHours.find((item) => item.weekday === weekday);
            return <DayHoursRow day={day} weekday={weekday} key={weekday} hours={hours} />;
          })}
        </section>
        <Button label="Сохранить данные студии" type="submit" variant="primary" isLoading={save.isPending} />
      </form>
      {message ? <p className={save.isError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
    </section>
  );
}

function ServiceEditor({business}: {business: BusinessConfig}) {
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  const sectionRef = useCollapseOnMobile();
  const mutation = useMutation({
    mutationFn: (service: Service) => ownerAction(business, 'save-service', {service}),
    onSuccess: async () => { setNotice('Услуга сохранена.'); await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug}); },
    onError: (error) => setNotice(error instanceof Error ? error.message : 'Не удалось сохранить услугу.'),
  });
  const save = (event: FormEvent<HTMLFormElement>, original?: Service) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const types = String(data.get('resourceTypes') ?? 'any').split(',').map((value) => value.trim()).filter(Boolean);
    const service: Service = {
      ...(original?.id ? {id: original.id} : {}),
      slug: String(data.get('slug')).trim().toLowerCase().replaceAll(' ', '-'),
      name: String(data.get('name')).trim(), description: String(data.get('description')).trim(), category: String(data.get('category')).trim(),
      priceMinor: Math.round(Number(data.get('price')) * 100), durationMinutes: Number(data.get('duration')),
      bufferBeforeMinutes: Number(data.get('before')), bufferAfterMinutes: Number(data.get('after')),
      resourceTypes: types.length ? types : ['any'], active: data.get('active') === 'on',
    };
    mutation.mutate(service);
  };
  return (
    <section className="owner-panel" id="set-services" ref={sectionRef}>
      <header className="section-heading"><section><p className="eyebrow">Прайс и время</p><Heading level={2}>Услуги</Heading></section></header>
      {business.services.map((service) => (
        <details className="set-service" key={service.slug} open data-collapse-mobile>
          <summary>
            <section className="set-summary-copy">
              <strong>{service.name}</strong>
              <small>{service.priceMinor ? `${service.priceMinor / 100} ${business.currency}` : 'Бесплатно'} · {durationLabel(service.durationMinutes)}</small>
            </section>
            <small className="set-status" data-active={service.active}>{service.active ? 'Активна' : 'Скрыта'}</small>
          </summary>
          <form className="form-panel service-editor" onSubmit={(event) => save(event, service)}>
            <section className="field-grid two-column">
              <label className="field"><small>Название</small><input defaultValue={service.name} name="name" required /></label>
              <label className="field"><small>Адрес услуги</small><input defaultValue={service.slug} name="slug" required /></label>
              <label className="field"><small>Описание</small><input defaultValue={service.description} name="description" /></label>
              <label className="field"><small>Категория</small><input defaultValue={service.category} name="category" required /></label>
              <label className="field"><small>Цена ({business.currency})</small><input defaultValue={service.priceMinor / 100} min="0" name="price" step="0.01" type="number" /></label>
              <label className="field"><small>Длительность, минут</small><input defaultValue={service.durationMinutes} min="1" name="duration" type="number" /></label>
              <label className="field"><small>Подготовка до, минут</small><input defaultValue={service.bufferBeforeMinutes} min="0" name="before" type="number" /></label>
              <label className="field"><small>Подготовка после, минут</small><input defaultValue={service.bufferAfterMinutes} min="0" name="after" type="number" /></label>
              <label className="field"><small>Типы постов через запятую</small><input defaultValue={service.resourceTypes.join(', ')} name="resourceTypes" /></label>
              <label className="field checkbox-field"><input defaultChecked={service.active} name="active" type="checkbox" /><small>Услуга доступна для записи</small></label>
            </section>
            <Button label="Сохранить услугу" size="sm" type="submit" variant="secondary" isLoading={mutation.isPending} />
          </form>
        </details>
      ))}
      <details className="set-service set-add" open>
        <summary><strong>Добавить услугу</strong></summary>
        <form className="form-panel service-editor" onSubmit={(event) => save(event)}>
          <section className="field-grid two-column">
            <label className="field"><small>Название</small><input name="name" required /></label>
            <label className="field"><small>Адрес услуги</small><input name="slug" required /></label>
            <label className="field"><small>Описание</small><input name="description" /></label>
            <label className="field"><small>Категория</small><input defaultValue="Уход" name="category" required /></label>
            <label className="field"><small>Цена ({business.currency})</small><input min="0" name="price" step="0.01" type="number" /></label>
            <label className="field"><small>Длительность, минут</small><input defaultValue="60" min="1" name="duration" type="number" /></label>
            <label className="field"><small>Подготовка до, минут</small><input defaultValue="0" min="0" name="before" type="number" /></label>
            <label className="field"><small>Подготовка после, минут</small><input defaultValue="0" min="0" name="after" type="number" /></label>
            <label className="field"><small>Типы постов через запятую</small><input defaultValue="any" name="resourceTypes" /></label>
          </section>
          <Button label="Добавить услугу" size="sm" type="submit" variant="primary" isLoading={mutation.isPending} />
        </form>
      </details>
      {notice ? <p className={mutation.isError ? 'form-error' : 'form-success'} role="status">{notice}</p> : null}
    </section>
  );
}

function ResourceEditor({business}: {business: BusinessConfig}) {
  const [message, setMessage] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (resource: {slug: string; name: string; resourceType: string; active: boolean}) => ownerAction(business, 'save-resource', {resource}),
    onSuccess: async () => { setMessage('Пост сохранён.'); await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug}); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Не удалось сохранить пост.'),
  });
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate({slug: String(data.get('slug')).trim().toLowerCase().replaceAll(' ', '-'), name: String(data.get('name')).trim(), resourceType: String(data.get('resourceType')).trim(), active: data.get('active') === 'on'});
  };
  return (
    <section className="owner-panel" id="set-resources">
      <header className="section-heading"><section><p className="eyebrow">Занятость</p><Heading level={2}>Рабочие посты</Heading></section></header>
      <section className="service-list">{business.resources.map((resource) => <Text key={resource.slug}>{resource.name} · {resource.resourceType}</Text>)}</section>
      <form className="inline-form" onSubmit={save}>
        <label className="field"><small>Название</small><input name="name" required /></label>
        <label className="field"><small>Адрес</small><input name="slug" required /></label>
        <label className="field"><small>Тип</small><input defaultValue="any" name="resourceType" required /></label>
        <Button label="Добавить или изменить пост" type="submit" variant="secondary" isLoading={mutation.isPending} />
      </form>
      {message ? <p className={mutation.isError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
    </section>
  );
}

function HoursEditor({business}: {business: BusinessConfig}) {
  const [message, setMessage] = useState('');
  const sectionRef = useCollapseOnMobile();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (override: Record<string, unknown>) => ownerAction(business, 'save-date-override', {override}),
    onSuccess: async () => { setMessage('Исключение в графике сохранено.'); await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug}); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Не удалось сохранить график.'),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const isClosed = data.get('isClosed') === 'on';
    mutation.mutate({localDate: data.get('localDate'), isClosed, opensAt: isClosed ? null : data.get('opensAt'), closesAt: isClosed ? null : data.get('closesAt'), label: data.get('label')});
  };
  return (
    <section className="owner-panel" id="set-calendar" ref={sectionRef}>
      <header className="section-heading"><section><p className="eyebrow">Календарь</p><Heading level={2}>Выходные и особые часы</Heading></section></header>
      <section className="opening-hours">{business.openingHours.map((hours) => <p className="time-label" key={hours.weekday}>{['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'][hours.weekday]}<strong>{hours.opensAt}–{hours.closesAt}</strong></p>)}</section>
      <details className="set-exception" open data-collapse-mobile>
        <summary>Добавить исключение</summary>
        <form className="inline-form" onSubmit={submit}>
          <label className="field"><small>Дата</small><input name="localDate" required type="date" /></label>
          <label className="field"><small>Открытие</small><input defaultValue="09:00" name="opensAt" type="time" /></label>
          <label className="field"><small>Закрытие</small><input defaultValue="19:00" name="closesAt" type="time" /></label>
          <label className="field"><small>Подпись</small><input name="label" placeholder="Например, праздник" /></label>
          <label className="checkbox-field"><input name="isClosed" type="checkbox" /><small>Выходной</small></label>
          <Button label="Сохранить дату" type="submit" variant="secondary" isLoading={mutation.isPending} />
        </form>
      </details>
      {message ? <p className={mutation.isError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
    </section>
  );
}

function InfoCardsEditor({business}: {business: BusinessConfig}) {
  const [message, setMessage] = useState('');
  const sectionRef = useCollapseOnMobile();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (infoCards: BusinessConfig['infoCards']) => ownerAction(business, 'update-profile', {profile: {infoCards}}),
    onSuccess: async () => { setMessage('Три карточки сохранены.'); await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug}); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Не удалось сохранить карточки.'),
  });
  return (
    <section className="owner-panel" id="set-cards" ref={sectionRef}>
      <header className="section-heading"><section><p className="eyebrow">Главная страница</p><Heading level={2}>Информационные карточки</Heading></section></header>
      <form className="field-grid" onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        mutation.mutate(business.infoCards.map((item, index) => ({id: item.id, title: String(data.get(`title-${index}`)).trim(), body: String(data.get(`body-${index}`)).trim()})));
      }}>
        {business.infoCards.map((item, index) => (
          <details className="set-card" key={item.id} open data-collapse-mobile>
            <summary>
              <section className="set-summary-copy">
                <strong>Карточка {index + 1}</strong>
                <small>{item.title}</small>
              </section>
            </summary>
            <section className="form-panel">
              <label className="field"><small>Заголовок</small><input defaultValue={item.title} name={`title-${index}`} required /></label>
              <label className="field"><small>Текст</small><textarea defaultValue={item.body} name={`body-${index}`} required /></label>
            </section>
          </details>
        ))}
        <Button label="Сохранить карточки" type="submit" variant="secondary" isLoading={mutation.isPending} />
      </form>
      {message ? <p className={mutation.isError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
    </section>
  );
}

function GalleryEditor({business}: {business: BusinessConfig}) {
  const [message, setMessage] = useState('');
  const [uploading, setUploading] = useState(false);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (gallery: BusinessConfig['gallery']) => ownerAction(business, 'update-profile', {profile: {gallery}}),
    onSuccess: async () => { setMessage('Галерея обновлена.'); await queryClient.invalidateQueries({predicate: (query) => query.queryKey[1] === business.slug}); },
    onError: (error) => setMessage(error instanceof Error ? error.message : 'Не удалось сохранить галерею.'),
  });
  const upload = async (file: File) => {
    if (!supabase || !business.id) { setMessage('Загрузка фото включится после настройки Supabase.'); return; }
    if (!allowedImageTypes.includes(file.type) || file.size > 15 * 1024 * 1024) { setMessage('Выберите JPG, PNG или WebP размером до 15 МБ.'); return; }
    setUploading(true); setMessage('');
    try {
      const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
      const objectPath = `${business.slug}/gallery/${createClientId()}.${extension}`;
      const {error} = await supabase.storage.from('tenant-media').upload(objectPath, file, {upsert: false, contentType: file.type});
      if (error) throw error;
      const {data} = supabase.storage.from('tenant-media').getPublicUrl(objectPath);
      const next = [...business.gallery, {id: createClientId().replaceAll('-', '').slice(0, 12), image: data.publicUrl, caption: file.name.replace(/\.[^.]+$/, ''), position: business.gallery.length}];
      await save.mutateAsync(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Не удалось загрузить фотографию.');
    } finally {
      setUploading(false);
    }
  };
  const updatePhoto = (id: string, changes: Partial<BusinessConfig['gallery'][number]>) => {
    save.mutate(business.gallery.map((photo) => photo.id === id ? {...photo, ...changes} : photo));
  };
  return (
    <section className="owner-panel" id="set-gallery">
      <header className="section-heading"><section><p className="eyebrow">Примеры работ</p><Heading level={2}>Галерея</Heading></section><Text type="supporting">Добавление сохраняет все существующие фотографии.</Text></header>
      <label className="upload-control"><UploadSimple aria-hidden="true" /><small>Добавить фотографию</small><input accept="image/jpeg,image/png,image/webp" disabled={!hasSupabaseConfig || uploading} onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} type="file" /></label>
      {business.gallery.length ? <section className="gallery-admin">{business.gallery.map((photo) => <article className="gallery-admin-row" key={photo.id}>
        <img src={photo.image} alt="" />
        <label className="field"><small>Подпись</small><input defaultValue={photo.caption} onBlur={(event) => { const caption = event.currentTarget.value.trim(); if (caption && caption !== photo.caption) updatePhoto(photo.id, {caption}); }} /></label>
        <label className="upload-control"><UploadSimple aria-hidden="true" /><small>Заменить фото</small><input accept="image/jpeg,image/png,image/webp" disabled={!hasSupabaseConfig || uploading} onChange={async (event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
          if (!file || !supabase) return;
          if (!allowedImageTypes.includes(file.type) || file.size > 15 * 1024 * 1024) { setMessage('Выберите JPG, PNG или WebP размером до 15 МБ.'); return; }
          try {
            const extension = file.name.split('.').pop()?.toLowerCase() || 'jpg';
            const path = `${business.slug}/gallery/${createClientId()}.${extension}`;
            const {error} = await supabase.storage.from('tenant-media').upload(path, file, {upsert: false, contentType: file.type});
            if (error) throw error;
            const {data} = supabase.storage.from('tenant-media').getPublicUrl(path);
            updatePhoto(photo.id, {image: data.publicUrl});
          } catch (error) { setMessage(error instanceof Error ? error.message : 'Не удалось заменить фотографию.'); }
        }} type="file" /></label>
      </article>)}</section> : <p className="empty-state">Фотографий пока нет.</p>}
      {message ? <p className={save.isError ? 'form-error' : 'form-success'} role="status">{message}</p> : null}
      {uploading ? <p className="loading-state" role="status">Загружаем фотографию…</p> : null}
      <Button label="Сохранить подписи и замены" variant="secondary" isLoading={save.isPending} onClick={() => save.mutate(business.gallery)} />
    </section>
  );
}

export function OwnerSettingsPage() {
  const business = useTenant();
  const businessQuery = useQuery({queryKey: ['tenant-settings', business.slug], queryFn: () => loadBusiness(business.slug, {includeInactive: true}), enabled: hasSupabaseConfig});
  const current = businessQuery.data ?? business;
  return (
    <section className="owner-page owner-settings">
      <header className="owner-heading"><section className="owner-heading-copy"><p className="eyebrow">Управление студией</p><Heading level={1}>Настройки</Heading><Text color="secondary">Обновите публичные данные, прайс, занятость и материалы главной страницы.</Text></section></header>
      {businessQuery.isError ? <p className="form-error" role="alert">{businessQuery.error instanceof Error ? businessQuery.error.message : 'Не удалось загрузить настройки.'}</p> : null}
      <nav className="owner-settings-nav" aria-label="Разделы настроек">
        <a href="#set-profile">Профиль</a>
        <a href="#set-services">Услуги</a>
        <a href="#set-resources">Посты</a>
        <a href="#set-calendar">Календарь</a>
        <a href="#set-cards">Карточки</a>
        <a href="#set-gallery">Галерея</a>
      </nav>
      <SettingsForm business={current} />
      <ServiceEditor business={current} />
      <ResourceEditor business={current} />
      <HoursEditor business={current} />
      <InfoCardsEditor business={current} />
      <GalleryEditor business={current} />
    </section>
  );
}
