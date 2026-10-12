import {Link} from 'react-router-dom';
import {ArrowRight, CaretRight, Clock, MapPin, Phone} from '@phosphor-icons/react';
import {formatInTimeZone} from 'date-fns-tz';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Heading, Text} from '@astryxdesign/core/Text';
import {useTenant} from '@/App';
import type {BusinessConfig} from '@/domain/tenant';
import {money} from '@/lib/format';
import {InstallAction} from '@/components/install-action';

const dayNames = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
const shortDayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

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

function countLabel(count: number, one: string, few: string, many: string) {
  const hundreds = count % 100;
  const units = count % 10;
  const form = hundreds >= 11 && hundreds <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
  return `${count} ${form}`;
}

function toMinutes(hhmm: string) {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return hours * 60 + minutes;
}

function openingStatus(business: BusinessConfig) {
  const now = new Date();
  const weekday = Number(formatInTimeZone(now, business.timezone, 'i')) % 7;
  const current = Number(formatInTimeZone(now, business.timezone, 'H')) * 60 + Number(formatInTimeZone(now, business.timezone, 'm'));
  const today = business.openingHours.find((hours) => hours.weekday === weekday);
  if (today && current >= toMinutes(today.opensAt) && current < toMinutes(today.closesAt)) {
    return {open: true as const, short: `Открыто · до ${today.closesAt}`};
  }
  if (today && current < toMinutes(today.opensAt)) {
    return {open: false as const, short: `Закрыто · с ${today.opensAt}`};
  }
  return {open: false as const, short: 'Сегодня закрыто'};
}

export function StorefrontPage() {
  const business = useTenant();
  const bookUrl = `/s/${business.slug}/booking`;
  const status = openingStatus(business);
  const todayWeekday = Number(formatInTimeZone(new Date(), business.timezone, 'i')) % 7;
  const telHref = `tel:${business.phone.replaceAll(' ', '')}`;

  return (
    <section className="page-content storefront-page">
      <section className="hero-section" data-reveal>
        <section className="hero-media" aria-label={`Фото студии ${business.name}`}>
          <img className="hero-photo" src={business.heroImage} alt={`Автомобиль в студии ${business.name}`} loading="eager" onError={(event) => { event.currentTarget.src = business.logoImage; }} />
          <section className="hero-shade" aria-hidden="true" />
          <p className="preview-pill hero-status"><span className={status.open ? 'status-dot status-dot-open' : 'status-dot'} aria-hidden="true" />{status.short}</p>
          <section className="hero-title-block">
            <p className="eyebrow">{business.city} · детейлинг-студия</p>
            <Heading className="hero-title" level={1} type="display-2">{business.name}</Heading>
          </section>
          <Link className="hero-photo-cta" to={bookUrl} aria-label={`Записаться в ${business.name}`}>Записаться <ArrowRight weight="bold" aria-hidden="true" /></Link>
        </section>
        <header className="hero-copy">
          <Text className="hero-description" color="secondary">{business.tagline}</Text>
          <Text className="hero-facts" type="supporting">
            {countLabel(business.services.length, 'услуга', 'услуги', 'услуг')} · {countLabel(business.resources.length, 'пост', 'поста', 'постов')}
          </Text>
        </header>
      </section>

      <section className="content-section" id="services" data-liquid-ignore data-reveal>
        <header className="section-heading">
          <section><p className="eyebrow">Прайс</p><Heading level={2}>Услуги и стоимость</Heading></section>
          <Text color="secondary">Продолжительность и свободное время видны до подтверждения.</Text>
        </header>
        <section className="service-list">
          {business.services.map((service) => (
            <Link className="service-card" key={service.slug} to={`${bookUrl}?service=${encodeURIComponent(service.slug)}`}>
              <section className="service-copy">
                <section className="service-title">
                  <Heading level={3}>{service.name}</Heading>
                  <strong className="service-price">{service.priceMinor ? money(service.priceMinor, business.currency, business.locale) : 'Бесплатно'}</strong>
                </section>
                <Text color="secondary">{service.description}</Text>
                <section className="service-meta"><small>{service.category}</small><small>{durationLabel(service.durationMinutes)}</small></section>
              </section>
              <ArrowRight className="service-arrow" weight="bold" aria-hidden="true" />
            </Link>
          ))}
        </section>
        <Button className="full-width" label="Смотреть свободное время" variant="secondary" href={bookUrl} />
      </section>

      <section className="content-section" data-liquid-ignore data-reveal>
        <header className="section-heading"><section><p className="eyebrow">Работы</p><Heading level={2}>Внимание к деталям</Heading></section></header>
        <section className="gallery-grid">
          {business.gallery.map((photo) => (
            <article className="gallery-card" key={photo.id}>
              <img className="gallery-image" src={photo.image} alt={photo.caption} loading="lazy" onError={(event) => { event.currentTarget.src = business.logoImage; }} />
              <strong className="gallery-caption">{photo.caption}</strong>
            </article>
          ))}
        </section>
      </section>

      <section className="content-section" data-liquid-ignore data-reveal>
        <header className="section-heading"><section><p className="eyebrow">Подход</p><Heading level={2}>Как всё устроено</Heading></section></header>
        <Text color="secondary">{business.description}</Text>
        <section className="info-grid">
          {business.infoCards.map((item) => <Card className="info-card" key={item.id}><Heading level={3}>{item.title}</Heading><Text color="secondary">{item.body}</Text></Card>)}
        </section>
      </section>

      <section className="content-section" id="visit" data-liquid-ignore data-reveal>
        <header className="section-heading"><section><p className="eyebrow">Визит</p><Heading level={2}>Как нас найти</Heading></section></header>
        <p className={status.open ? 'preview-pill visit-status' : 'preview-pill visit-status visit-status-closed'} role="status"><Clock weight="regular" aria-hidden="true" />{status.short}</p>
        <section className="visit-list">
          <a className="visit-row" href={business.mapUrl} target="_blank" rel="noreferrer">
            <MapPin weight="fill" aria-hidden="true" />
            <section><strong>Адрес</strong><small>{business.address}</small></section>
            <CaretRight weight="bold" aria-hidden="true" />
          </a>
          <a className="visit-row" href={telHref}>
            <Phone weight="fill" aria-hidden="true" />
            <section><strong>Телефон</strong><small>{business.phone}</small></section>
            <CaretRight weight="bold" aria-hidden="true" />
          </a>
        </section>
        <details className="hours-details">
          <summary>Часы работы<small>Сегодня {shortDayNames[todayWeekday]}</small></summary>
          <section className="hours-list">
            {business.openingHours.map((hours) => (
              <p className="hours-row" data-today={hours.weekday === todayWeekday} key={hours.weekday}>
                <small>{dayNames[hours.weekday]}</small>
                <strong>{hours.opensAt}–{hours.closesAt}</strong>
              </p>
            ))}
          </section>
        </details>
        <section className="contact-actions">
          <Button label="Построить маршрут" variant="secondary" href={business.mapUrl} target="_blank" rel="noreferrer" icon={<MapPin weight="bold" />} />
          <Button label="Позвонить" variant="secondary" href={telHref} icon={<Phone weight="bold" />} />
        </section>
        <InstallAction />
      </section>
    </section>
  );
}
