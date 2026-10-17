import {useCallback, useEffect, useState} from 'react';

type InstallPromptEvent = Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>};

const SESSION_KEY = 'autoservices:install:dismissed';

export function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  const nav = navigator as Navigator & {standalone?: boolean};
  if (nav.standalone === true) return true;
  // iOS Safari exposes standalone mode only via matchMedia; the above covers it.
  return false;
}

export function useInstallPrompt() {
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(isInstalled);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPrompt(null);
      try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
  }, []);

  const isDismissed = () => {
    try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
  };

  const triggerNative = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!prompt) return 'unavailable';
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      setPrompt(null);
      if (result.outcome === 'accepted') {
        setInstalled(true);
        return 'accepted';
      }
      return 'dismissed';
    } catch {
      return 'dismissed';
    }
  };

  return {prompt, installed, isInstalled: installed, isDismissed, dismiss, triggerNative};
}
