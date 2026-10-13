import {Link} from 'react-router-dom';
import {ArrowRight} from '@phosphor-icons/react';
import {Heading, Text} from '@astryxdesign/core/Text';
import {useTenant} from '@/App';
import {money} from '@/lib/format';

function durationLabel(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 60 / 24);
    const remaining = minutes % 1440;
    return remaining ? `${days} дн. ${Math.floor(remaining / 60)} ч.` : `${days} дн.`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours} ч. ${remaining} мин.` : `${hours} ч.`;
}

function plural(count: number, one: string, few: string, many: string) {
  const hundreds = count % 100;
  const units = count % 10;
  if (hundreds >= 11 && hundreds <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

export function ServicesPage() {
  const business = useTenant();
  const bookUrl = `/s/${business.slug}/booking`;

  return (
    <section className="page-content svc-page">
      <header className="svc-heading" data-reveal>
        <p className="eyebrow">Прайс</p>
        <Heading className="svc-title" level={1}>Услуги и цены</Heading>
        <Text color="secondary">{`${business.services.length} ${plural(business.services.length, 'услуга', 'услуги', 'услуг')}`} · точная стоимость и продолжительность. Свободное время — на следующем шаге.</Text>
      </header>

      {business.services.length ? (
        <section className="svc-list" aria-label="Каталог услуг">
          {business.services.map((service) => {
            const price = service.priceMinor ? money(service.priceMinor, business.currency, business.locale) : 'Бесплатно';
            const duration = durationLabel(service.durationMinutes);
            return (
              <Link
                className="svc-row"
                key={service.slug}
                to={`${bookUrl}?service=${encodeURIComponent(service.slug)}`}
                aria-label={`${service.name}, ${price}, ${duration}`}
              >
                <section className="svc-copy">
                  <section className="svc-top">
                    <strong>{service.name}</strong>
                    <strong className="svc-price">{price}</strong>
                  </section>
                  {service.description ? <Text className="svc-desc" color="secondary">{service.description}</Text> : null}
                  <section className="svc-meta"><small>{service.category}</small><small>{duration}</small></section>
                </section>
                <ArrowRight className="svc-arrow" weight="bold" aria-hidden="true" />
              </Link>
            );
          })}
        </section>
      ) : (
        <section className="svc-empty" role="status">
          <Text color="secondary">Услуги пока недоступны. Позвоните в студию — подскажем варианты.</Text>
          <Link to={`/s/${business.slug}/`}>Вернуться на главную</Link>
        </section>
      )}
    </section>
  );
}
