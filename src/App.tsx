import {lazy, Suspense} from 'react';
import {BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useOutletContext, useParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {CalendarDots, CarProfile, CircleNotch, House, MapPin, Phone} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';
import type {BusinessConfig} from '@/domain/tenant';
import {AssistantWidget} from '@/components/assistant-widget';
import {InstallMetadata} from '@/components/install-metadata';
import {RevealSections} from '@/components/reveal-sections';
import {TenantTheme} from '@/components/tenant-theme';
import {loadBusiness} from '@/lib/tenant-api';

const StorefrontPage = lazy(() => import('@/pages/storefront/StorefrontPage').then((module) => ({default: module.StorefrontPage})));
const ServicesPage = lazy(() => import('@/pages/storefront/ServicesPage').then((module) => ({default: module.ServicesPage})));
const BookingPage = lazy(() => import('@/pages/booking/BookingPage').then((module) => ({default: module.BookingPage})));
const MyBookingPage = lazy(() => import('@/pages/booking/AppointmentPage').then((module) => ({default: module.MyBookingPage})));
const AppointmentPage = lazy(() => import('@/pages/booking/AppointmentPage').then((module) => ({default: module.AppointmentPage})));
const OwnerDashboardPage = lazy(() => import('@/pages/owner/OwnerDashboardPage').then((module) => ({default: module.OwnerDashboardPage})));
const OwnerLoginPage = lazy(() => import('@/pages/owner/OwnerLoginPage').then((module) => ({default: module.OwnerLoginPage})));
const OwnerSettingsPage = lazy(() => import('@/pages/owner/OwnerSettingsPage').then((module) => ({default: module.OwnerSettingsPage})));

type TenantOutlet = {business: BusinessConfig};

export function useTenant() {
  return useOutletContext<TenantOutlet>().business;
}

function TenantShell() {
  const {slug = ''} = useParams();
  const location = useLocation();
  const query = useQuery({queryKey: ['tenant', slug], queryFn: () => loadBusiness(slug), enabled: Boolean(slug)});
  const isOwner = location.pathname.includes('/owner');
  const isOwnerLogin = location.pathname.endsWith('/owner/login');
  const isBooking = location.pathname.endsWith('/booking');
  const isOwnerSettings = location.pathname.endsWith('/owner/settings');

  if (query.isLoading) {
    return (
      <section className="app-shell loading-page" aria-busy="true" aria-label="Загружаем студию">
        <section className="skeleton-line" />
        <section className="skeleton-line skeleton-large" />
        <section className="skeleton-line" />
        {!isOwner ? <PublicNavigation slug={slug} /> : null}
      </section>
    );
  }
  if (query.isError || !query.data) {
    return (
      <section className="not-found" role="alert">
        <Heading level={1}>Не удалось открыть студию</Heading>
        <Text color="secondary">{query.error instanceof Error ? query.error.message : 'Попробуйте обновить страницу или проверьте ссылку.'}</Text>
        <Button label="Повторить" variant="primary" onClick={() => void query.refetch()} />
        <Link to="/">К списку демо-студий</Link>
      </section>
    );
  }

  const business = query.data;
  return (
    <TenantTheme business={business}>
      <InstallMetadata business={business} />
      <section className="app-shell">
        <header className="topbar">
          <Link className="brand-link" to={`/s/${business.slug}/`} aria-label={`${business.name} — главная`}>
            <img className="brand-mark" src={business.logoImage} alt="" />
            <section className="brand-copy"><strong>{business.name}</strong><small>{business.city}</small></section>
          </Link>
          {isOwner ? (
            <nav className="tenant-nav" aria-label="Кабинет владельца">
              <NavLink to={`/s/${business.slug}/owner/`} end>Расписание</NavLink>
              <NavLink to={`/s/${business.slug}/owner/settings`}>Настройки</NavLink>
            </nav>
          ) : (
            <nav className="tenant-nav" aria-label="Разделы студии">
              <NavLink to={`/s/${business.slug}/`} end>Студия</NavLink>
              <NavLink to={`/s/${business.slug}/services`}>Услуги</NavLink>
              <NavLink to={`/s/${business.slug}/booking`}>Записаться</NavLink>
            </nav>
          )}
          <section className="topbar-actions">
            {business.demo ? <Text className="preview-pill" type="supporting">Демо</Text> : null}
            <Link className="desktop-link" to={isOwner ? `/s/${business.slug}/` : `/s/${business.slug}/owner/login`}>
              {isOwner ? 'На сайт' : 'Кабинет'}
            </Link>
          </section>
        </header>
        <Suspense fallback={<RouteLoadingFallback title={routeLoadingTitle({isBooking, isOwner, isOwnerLogin, isOwnerSettings})} />}>
          <RevealSections routeKey={location.pathname}>
            <Outlet context={{business} satisfies TenantOutlet} />
          </RevealSections>
        </Suspense>
        {!isOwner ? <PublicNavigation slug={business.slug} /> : null}
        {!isOwnerLogin && !isBooking ? <AssistantWidget business={business} audience={isOwner ? 'owner' : 'client'} /> : null}
        {!isOwner ? (
          <footer className="footer-row" data-liquid-ignore>
            <Text type="supporting">{business.name} · {business.city}</Text>
            <Link to={`/s/${business.slug}/owner/login`}>Вход владельца</Link>
          </footer>
        ) : null}
      </section>
    </TenantTheme>
  );
}

function routeLoadingTitle({isBooking, isOwner, isOwnerLogin, isOwnerSettings}: {isBooking: boolean; isOwner: boolean; isOwnerLogin: boolean; isOwnerSettings: boolean}) {
  if (isBooking) return 'Открываем запись';
  if (isOwnerLogin) return 'Открываем вход в кабинет';
  if (isOwnerSettings) return 'Открываем настройки';
  if (isOwner) return 'Открываем расписание';
  return 'Открываем студию';
}

function RouteLoadingFallback({title}: {title: string}) {
  return (
    <section className="page-content route-loading" aria-busy="true">
      <section className="route-loading-card" role="status" aria-live="polite">
        <CircleNotch className="route-loading-icon" aria-hidden="true" />
        <Heading level={2}>{title}</Heading>
        <Text color="secondary">Подготавливаем страницу и данные студии.</Text>
      </section>
    </section>
  );
}

function PublicNavigation({slug}: {slug: string}) {
  const {pathname} = useLocation();
  const tenantPath = `/s/${slug}`;
  const isHome = pathname === tenantPath || pathname === `${tenantPath}/`;
  const isServices = pathname === `${tenantPath}/services`;
  const isMyBooking = pathname === `${tenantPath}/my-booking`;

  return (
    <nav className="mobile-nav" aria-label="Нижняя навигация">
      <section className="mobile-nav-content">
        <Link className="mobile-nav-link" to={`${tenantPath}/`} aria-current={isHome ? 'page' : undefined}><House weight="regular" aria-hidden="true" /><small>Главная</small></Link>
        <Link className="mobile-nav-link" to={`${tenantPath}/services`} aria-current={isServices ? 'page' : undefined}><CarProfile weight="regular" aria-hidden="true" /><small>Услуги</small></Link>
        <Link className="mobile-nav-link" to={`${tenantPath}/my-booking`} aria-current={isMyBooking ? 'page' : undefined}><CalendarDots weight="regular" aria-hidden="true" /><small>Моя запись</small></Link>
      </section>
    </nav>
  );
}

function PageLoadingFallback() {
  const {pathname} = useLocation();
  const [, segment, slug] = pathname.split('/');
  const isPublicTenantRoute = segment === 's' && Boolean(slug) && !pathname.includes('/owner');

  return (
    <section className="app-shell loading-page" aria-busy="true" aria-label="Загружаем страницу">
      <section className="skeleton-line" />
      <section className="skeleton-line skeleton-large" />
      <section className="skeleton-line" />
      {isPublicTenantRoute && slug ? <PublicNavigation slug={slug} /> : null}
    </section>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoadingFallback />}>
        <Routes>
          <Route path="/" element={<Navigate replace to="/s/graphite-detailing/" />} />
          <Route path="/s/:slug" element={<TenantShell />}>
            <Route index element={<StorefrontPage />} />
            <Route path="services" element={<ServicesPage />} />
            <Route path="booking" element={<BookingPage />} />
            <Route path="my-booking" element={<MyBookingPage />} />
            <Route path="reservation/:appointmentId" element={<AppointmentPage />} />
            <Route path="owner/login" element={<OwnerLoginPage />} />
            <Route path="owner" element={<OwnerDashboardPage />} />
            <Route path="owner/settings" element={<OwnerSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate replace to="/s/graphite-detailing/" />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
