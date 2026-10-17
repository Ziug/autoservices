import {useCallback, useEffect, useState} from 'react';
import {DownloadSimple, X} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {DrawerPanel} from '@/components/ui/drawer';
import {Heading, Text} from '@astryxdesign/core/Text';
import {isInstalled, useInstallPrompt} from '@/components/install-prompt';
import {detectBrowser, manualGuideFor, type BrowserId} from '@/lib/install-guide';

const SESSION_KEY = 'autoservices:install:dismissed';

function isDismissed(): boolean {
  try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}

export function InstallGuide({open, onOpenChange}: {open: boolean; onOpenChange: (open: boolean) => void}) {
  const browser = detectBrowser();
  const guide = manualGuideFor(browser);
  const [showSelector, setShowSelector] = useState(false);
  const [selected, setSelected] = useState<BrowserId>(browser);

  useEffect(() => {
    if (open) setSelected(browser);
  }, [open, browser]);

  const steps = manualGuideFor(selected).steps;
  const fallback = manualGuideFor(selected).fallback;
  const intro = manualGuideFor(selected).intro;

  return (
    <DrawerPanel open={open} onOpenChange={onOpenChange} title={guide.title} description={intro}>
      <section className="install-guide">
        {showSelector ? (
          <label className="field">
            <small>Ваш браузер</small>
            <select aria-label="Ваш браузер" value={selected} onChange={(event) => setSelected(event.currentTarget.value as BrowserId)}>
              <option value="ios-safari">Safari (iOS)</option>
              <option value="ios-chrome">Chrome (iOS)</option>
              <option value="android-chrome">Chrome (Android)</option>
              <option value="android-samsung">Samsung Internet</option>
              <option value="android-firefox">Firefox (Android)</option>
              <option value="desktop-chrome">Chrome (desktop)</option>
              <option value="desktop-safari">Safari (macOS)</option>
              <option value="desktop-edge">Edge (desktop)</option>
              <option value="desktop-firefox">Firefox (desktop)</option>
            </select>
          </label>
        ) : (
          <button className="admin-link" type="button" onClick={() => setShowSelector((v) => !v)}>
            {showSelector ? 'Скрыть выбор браузера' : 'Не нашли свой браузер?'}
          </button>
        )}
        {steps.length > 0 ? (
          <ol className="install-steps">
            {steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        ) : null}
        {fallback ? <p className="assistant-note" role="status">{fallback}</p> : null}
      </section>
    </DrawerPanel>
  );
}

export function PostBookingInstallCard({businessName}: {businessName: string}) {
  const {prompt, installed, isDismissed, dismiss, triggerNative} = useInstallPrompt();
  const [guideOpen, setGuideOpen] = useState(false);
  const [hidden, setHidden] = useState(isInstalled() || isDismissed());

  if (hidden || installed) return null;

  const handlePrimary = async () => {
    if (prompt) {
      const outcome = await triggerNative();
      if (outcome === 'dismissed') {
        setHidden(true);
        dismiss();
      }
      if (outcome === 'accepted') setHidden(true);
      return;
    }
    setGuideOpen(true);
  };

  return (
    <>
      <Card className="install-promo-card">
        <section className="install-promo-copy">
          <Heading level={3}>Забудьте о поиске сайта в следующий раз</Heading>
          <Text color="secondary">
            Добавьте студию на экран „Домой“, чтобы возвращаться к записи в одно касание. Не придётся искать сайт в истории браузера, переписках или контактах.
          </Text>
        </section>
        <section className="install-promo-actions">
          <Button label="Добавить на экран „Домой“" variant="primary" icon={<DownloadSimple weight="bold" />} onClick={() => void handlePrimary()} />
          <Button label="Не сейчас" variant="ghost" onClick={() => { setHidden(true); dismiss(); }} />
        </section>
      </Card>
      <InstallGuide open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}

export function ReturningInstallBanner() {
  const {prompt, installed, isDismissed, dismiss, triggerNative} = useInstallPrompt();
  const [guideOpen, setGuideOpen] = useState(false);
  const [hidden, setHidden] = useState(isInstalled() || isDismissed());

  if (hidden || installed) return null;

  const handlePrimary = async () => {
    if (prompt) {
      const outcome = await triggerNative();
      if (outcome === 'dismissed') {
        setHidden(true);
        dismiss();
      }
      if (outcome === 'accepted') setHidden(true);
      return;
    }
    setGuideOpen(true);
  };

  return (
    <>
      <section className="install-banner" role="region" aria-label="Установка приложения">
        <section className="install-banner-copy">
          <Heading level={3}>Студия всегда под рукой</Heading>
          <Text color="secondary">
            Добавьте сайт на экран „Домой“ и возвращайтесь к записи, не разыскивая ссылку в браузере или сообщениях.
          </Text>
        </section>
        <Button label="Как добавить" variant="secondary" onClick={() => void handlePrimary()} />
        <button aria-label="Закрыть" className="install-banner-close" onClick={() => { setHidden(true); dismiss(); }} type="button">
          <X aria-hidden="true" />
        </button>
      </section>
      <InstallGuide open={guideOpen} onOpenChange={setGuideOpen} />
    </>
  );
}
