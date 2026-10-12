import {useMemo, type ReactNode} from 'react';
import {Theme, defineTheme} from '@astryxdesign/core/theme';
import type {BusinessConfig} from '@/domain/tenant';

export function TenantTheme({business, children}: {business: BusinessConfig; children: ReactNode}) {
  const theme = useMemo(() => defineTheme({
    name: `tenant-${business.slug}`,
    tokens: {
      '--color-accent': [business.accentColor, business.accentColor],
      '--color-icon-accent': [business.accentColor, business.accentColor],
      '--color-text-accent': [business.accentColor, business.accentColor],
      '--color-background-body': 'oklch(13% 0.03 250)',
      '--color-background-surface': 'oklch(19% 0.035 248)',
      '--color-background-card': 'oklch(21% 0.04 246)',
      '--color-background-muted': 'oklch(24% 0.035 246)',
      '--color-border': 'oklch(46% 0.035 248 / 0.42)',
      '--color-border-emphasized': 'oklch(58% 0.035 248 / 0.58)',
      '--color-text-primary': 'oklch(97% 0.008 250)',
      '--color-text-secondary': 'oklch(76% 0.02 250)',
    },
  }), [business.accentColor, business.slug]);
  return <Theme theme={theme} mode="dark">{children}</Theme>;
}
