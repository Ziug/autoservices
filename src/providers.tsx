import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {useEffect, useState, type ReactNode} from 'react';
import {Theme} from '@astryxdesign/core/theme';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import {defaultThemeSlug, themes} from '../astryx-themes.js';
import {supabase} from '@/lib/supabase';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {staleTime: 30_000, retry: 1, refetchOnWindowFocus: true},
    mutations: {retry: 0},
  },
});

function SessionCacheGuard({children}: {children: ReactNode}) {
  useEffect(() => {
    if (!supabase) return;
    const {data: listener} = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') queryClient.clear();
    });
    return () => listener.subscription.unsubscribe();
  }, []);
  return children;
}

export function AppProviders({children}: {children: ReactNode}) {
  return (
    <Theme theme={themes[defaultThemeSlug]} mode="dark">
      <QueryClientProvider client={queryClient}>
        <SessionCacheGuard>{children}</SessionCacheGuard>
      </QueryClientProvider>
    </Theme>
  );
}
