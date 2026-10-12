import {useEffect, useState} from 'react';
import {DownloadSimple} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';

type InstallPromptEvent = Event & {prompt: () => Promise<void>; userChoice: Promise<{outcome: 'accepted' | 'dismissed'}>};

export function InstallAction() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) {
      setMessage(/iPhone|iPad|iPod/i.test(navigator.userAgent)
        ? 'На iPhone нажмите «Поделиться», затем «На экран Домой».'
        : 'Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».');
      return;
    }
    await installPrompt.prompt();
    const result = await installPrompt.userChoice;
    setMessage(result.outcome === 'accepted' ? 'Приложение добавлено на главный экран.' : 'Установку можно выполнить позже из меню браузера.');
    setInstallPrompt(null);
  };

  return (
    <section className="install-action">
      {!installed ? <Button label="Добавить студию на главный экран" variant="secondary" icon={<DownloadSimple />} onClick={() => void install()} /> : null}
      {message ? <p className="assistant-note" role="status">{message}</p> : null}
    </section>
  );
}
