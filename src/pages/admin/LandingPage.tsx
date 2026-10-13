import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowRight, MapPin, Storefront} from '@phosphor-icons/react';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import {supabase} from '@/lib/supabase';

interface BookableTenant {
  slug: string;
  name: string;
  city: string;
  tagline: string;
}

async function loadBookableTenants(): Promise<BookableTenant[]> {
  if (!supabase) throw new Error('Каталог сейчас недоступен. Проверьте соединение и обновите страницу.');
  const {data, error} = await supabase
    .from('tenants')
    .select('slug,name,city,tagline')
    .in('status', ['preview', 'live'])
    .order('name');
  if (error) throw new Error('Не удалось загрузить список студий. Попробуйте обновить страницу.');
  return (data ?? []) as BookableTenant[];
}

/** Neutral root page: lists every bookable studio, no hardcoded default tenant. */
export function LandingPage() {
  const query = useQuery({queryKey: ['bookable-tenants'], queryFn: loadBookableTenants, staleTime: 60_000});

  return (
    <section className="app-shell">
      <header className="topbar">
        <Link className="brand-link" to="/" aria-label="Студии — главная">
          <section className="brand-copy">
            <strong>Студии</strong>
            <small>Запись на автосервис</small>
          </section>
        </Link>
      </header>
      <section className="page-content">
        <section className="content-section">
          <header className="section-heading">
            <section>
              <p className="eyebrow">Каталог</p>
              <Heading level={1}>Выберите студию</Heading>
            </section>
            <Text color="secondary">Свободные окна, услуги и запись — на странице студии.</Text>
          </header>
          {query.isLoading ? (
            <section className="app-shell loading-page" aria-busy="true" aria-label="Загружаем студии">
              <section className="skeleton-line" />
              <section className="skeleton-line skeleton-large" />
              <section className="skeleton-line" />
            </section>
          ) : null}
          {query.isError ? (
            <section className="owner-panel">
              <p className="form-error" role="alert">
                {query.error instanceof Error ? query.error.message : 'Не удалось загрузить список студий.'}
              </p>
              <Button label="Повторить" variant="secondary" onClick={() => void query.refetch()} />
            </section>
          ) : null}
          {query.isSuccess && query.data.length === 0 ? (
            <EmptyState
              icon={<Storefront aria-hidden="true" />}
              title="Студий пока нет"
              description="Загляните позже — новые студии появятся в каталоге."
            />
          ) : null}
          {query.isSuccess && query.data.length > 0 ? (
            <section className="visit-list">
              {query.data.map((tenant) => (
                <Link className="visit-row" key={tenant.slug} to={`/s/${tenant.slug}/`} aria-label={`${tenant.name}, ${tenant.city}, открыть страницу студии`}>
                  <MapPin weight="fill" aria-hidden="true" />
                  <section>
                    <strong>{tenant.name}</strong>
                    <small>
                      {tenant.city}
                      {tenant.tagline ? ` · ${tenant.tagline}` : ''}
                    </small>
                  </section>
                  <ArrowRight weight="bold" aria-hidden="true" />
                </Link>
              ))}
            </section>
          ) : null}
        </section>
      </section>
    </section>
  );
}
