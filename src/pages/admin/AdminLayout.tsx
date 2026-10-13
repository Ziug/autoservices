import type {CSSProperties, MouseEvent, ReactNode} from 'react';
import {Link, Navigate, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {ChartBar, Scroll, ShieldCheck, SignOut, Storefront} from '@phosphor-icons/react';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Breadcrumbs, BreadcrumbItem} from '@astryxdesign/core/Breadcrumbs';
import {Button} from '@astryxdesign/core/Button';
import {NavIcon} from '@astryxdesign/core/NavIcon';
import {SideNav, SideNavHeading, SideNavItem, SideNavSection} from '@astryxdesign/core/SideNav';
import {Skeleton} from '@astryxdesign/core/Skeleton';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TopNav, TopNavHeading} from '@astryxdesign/core/TopNav';
import {adminUrl, getAdminBasePath} from '@/lib/admin-config';
import {signOutAdmin, verifyAdminSession} from '@/lib/admin-api';

/** Adapter so Astryx nav items (href-based) use client-side routing. */
function AdminLink({
  href,
  children,
  className,
  style,
  onClick,
  'aria-current': ariaCurrent,
}: {
  href?: string;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  'aria-current'?: 'page' | undefined;
}) {
  if (!href) return null;
  return (
    <Link to={href} className={className} style={style} onClick={onClick} aria-current={ariaCurrent}>
      {children}
    </Link>
  );
}

const NAV_ITEMS = [
  {segment: 'dashboard', label: 'Обзор', icon: <ChartBar aria-hidden="true" />},
  {segment: 'tenants', label: 'Студии', icon: <Storefront aria-hidden="true" />},
  {segment: 'audit', label: 'Журнал', icon: <Scroll aria-hidden="true" />},
] as const;

function crumbTrail(pathname: string): Array<{label: string; href?: string}> {
  const base = getAdminBasePath();
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  const parts = rest.split('/').filter(Boolean);
  if (parts[0] === 'tenants' && parts[1] === 'new') {
    return [
      {label: 'Студии', href: adminUrl('tenants')},
      {label: 'Новая студия'},
    ];
  }
  if (parts[0] === 'tenants' && parts[1] && parts[2] === 'setup') {
    return [
      {label: 'Студии', href: adminUrl('tenants')},
      {label: 'Настройка студии'},
    ];
  }
  if (parts[0] === 'tenants' && parts[1]) {
    return [
      {label: 'Студии', href: adminUrl('tenants')},
      {label: 'Карточка студии'},
    ];
  }
  if (parts[0] === 'tenants') return [{label: 'Студии'}];
  if (parts[0] === 'audit') return [{label: 'Журнал'}];
  return [{label: 'Обзор'}];
}

/**
 * Super Admin shell: AppShell + collapsible SideNav + TopNav + Breadcrumbs.
 * The guard only decides what to render; every admin-api call re-verifies
 * platform-admin membership server-side.
 */
export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({queryKey: ['admin-session'], queryFn: verifyAdminSession, retry: false, staleTime: 60_000});

  if (sessionQuery.isLoading) {
    return (
      <section className="admin-login-wrap" aria-busy="true" aria-label="Проверяем доступ">
        <VStack gap={2} className="admin-skeleton-stack">
          <Skeleton height={28} width="60%" />
          <Skeleton height={120} />
          <Skeleton height={120} />
        </VStack>
      </section>
    );
  }

  if (sessionQuery.isError) {
    return <Navigate replace to={adminUrl('login')} state={{next: `${location.pathname}${location.search}`}} />;
  }

  const signOut = async () => {
    await signOutAdmin();
    await queryClient.clear();
    navigate(adminUrl('login'), {replace: true});
  };

  const crumbs = crumbTrail(location.pathname);
  const isSelected = (segment: string) =>
    segment === 'tenants' ? location.pathname.startsWith(adminUrl('tenants')) : location.pathname === adminUrl(segment);

  return (
    <AppShell
      height="auto"
      contentPadding={4}
      topNav={
        <TopNav
          label="Верхняя навигация панели"
          heading={<TopNavHeading heading="Super Admin" headingHref={adminUrl('dashboard')} logo={<NavIcon icon={<ShieldCheck aria-hidden="true" />} />} />}
          endContent={<Button label="Выйти" variant="ghost" size="sm" icon={<SignOut aria-hidden="true" />} onClick={() => void signOut()} />}
        />
      }
      sideNav={
        <SideNav collapsible header={<SideNavHeading heading="Super Admin" headingHref={adminUrl('dashboard')} />}>
          <SideNavSection title="Управление" isHeaderHidden>
            {NAV_ITEMS.map((item) => (
              <SideNavItem
                key={item.segment}
                as={AdminLink}
                label={item.label}
                icon={item.icon}
                href={adminUrl(item.segment)}
                isSelected={isSelected(item.segment)}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
      <VStack gap={4} className="admin-page">
        <Breadcrumbs label="Хлебные крошки панели">
          <BreadcrumbItem as={AdminLink} href={adminUrl('dashboard')}>
            Панель
          </BreadcrumbItem>
          {crumbs.map((crumb) =>
            crumb.href ? (
              <BreadcrumbItem as={AdminLink} key={crumb.label} href={crumb.href}>
                {crumb.label}
              </BreadcrumbItem>
            ) : (
              <BreadcrumbItem key={crumb.label} isCurrent>
                {crumb.label}
              </BreadcrumbItem>
            ),
          )}
        </Breadcrumbs>
        <Outlet />
        <footer className="admin-pagination-row">
          <Text type="supporting" color="secondary">
            Доступ ограничен администраторами платформы.
          </Text>
        </footer>
      </VStack>
    </AppShell>
  );
}

export function AdminAreaHeading({title, description}: {title: string; description: string}) {
  return (
    <header className="admin-page-head">
      <section className="admin-page-head-copy">
        <Heading level={1}>{title}</Heading>
        <Text color="secondary">{description}</Text>
      </section>
    </header>
  );
}
