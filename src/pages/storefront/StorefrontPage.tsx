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

function plural(count: number, one: string, few: string, many: string) {
  const hundreds = count % 100;
  const units = count % 10;
  if (hundreds >= 11 && hundreds <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

type ServiceEntry = {cheapestName: string; priceLabel: string} | null;

function serviceEntry(business: BusinessConfig): ServiceEntry {
  if (!business.services.length) return null;
  const cheapest = business.services.reduce((best, item) => (item.priceMinor < best.priceMinor ? item : best));
  return {
    cheapestName: cheapest.name,
    priceLabel: cheapest.priceMinor ? `от ${money(cheapest.priceMinor, business.currency, business.locale)}` : 'Бесплатно',
  };
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
  const servicesUrl = `/s/${business.slug}/services`;
  const status = openingStatus(business);
  const todayWeekday = Number(formatInTimeZone(new Date(), business.timezone, 'i')) % 7;
  const telHref = `tel:${business.phone.replaceAll(' ', '')}`;
  const stats = [
    {value: business.services.length, label: plural(business.services.length, 'услуга', 'услуги', 'услуг')},
    ...(business.gallery.length ? [{value: business.gallery.length, label: plural(business.gallery.length, 'работа', 'работы', 'работ')}] : []),
    {value: business.resources.length, label: plural(business.resources.length, 'пост', 'поста', 'постов')},
  ];

  return (
    <section className="page-content storefront-page">
      <section className="sf-hero" data-reveal>
        <section className="sf-hero-media" aria-label={`Фото студии ${business.name}`}>
          <img className="sf-hero-photo" src={business.heroImage} alt={`Автомобиль в студии ${business.name}`} loading="eager" onError={(event) => { event.currentTarget.src = business.logoImage; }} />
          <section className="sf-hero-shade" aria-hidden="true" />
          <p className="preview-pill sf-hero-status"><span className={status.open ? 'status-dot status-dot-open' : 'status-dot'} aria-hidden="true" />{status.short}</p>
          <section className="sf-hero-titles">
            <p className="eyebrow">{business.city}</p>
            <Heading className="sf-hero-title" level={1}>{business.name}</Heading>
          </section>
          <Link className="sf-hero-cta" to={bookUrl} aria-label={`Записаться в ${business.name}`}>Записаться <ArrowRight weight="bold" aria-hidden="true" /></Link>
        </section>
        <header className="sf-identity">
          <Text className="sf-tagline" color="secondary">{business.tagline}</Text>
        </header>
        <section className="sf-stats" data-count={stats.length} aria-label="О студии в цифрах">
          {stats.map((stat) => (
            <section className="sf-stat" key={stat.label}>
              <strong>{stat.value}</strong>
              <small>{stat.label}</small>
            </section>
          ))}
        </section>
      </section>

      <section className="content-section" id="services" data-liquid-ignore data-reveal>
        <header className="section-heading">
          <section><p className="eyebrow">Услуги</p><Heading level={2}>Направления и цены</Heading></section>
          <Text color="secondary">Полный каталог с точной стоимостью — внутри записи.</Text>
        </header>
        {(() => {
          const entry = serviceEntry(business);
          if (!entry) return null;
          return (
            <Link
              className="sf-entry-row"
              to={servicesUrl}
              aria-label={`Услуги студии, ${entry.cheapestName}, ${entry.priceLabel}, открыть каталог`}
            >
              <section className="sf-entry-copy">
                <strong>Услуги студии</strong>
                <small>{entry.cheapestName} · {entry.priceLabel}</small>
              </section>
              <ArrowRight className="sf-entry-arrow" weight="bold" aria-hidden="true" />
            </Link>
          );
        })()}
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
