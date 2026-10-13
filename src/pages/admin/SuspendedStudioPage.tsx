import {PauseCircle} from '@phosphor-icons/react';
import {Button} from '@astryxdesign/core/Button';
import {Heading, Text} from '@astryxdesign/core/Text';

/**
 * Neutral "studio unavailable" page. Shown when public_tenant_visibility
 * reports suspended/archived. Explains the pause without revealing internal
 * reasons, operator notes, or enforcement details.
 */
export function SuspendedStudioPage({archived = false}: {archived?: boolean}) {
  return (
    <section className="app-shell">
      <section className="not-found" role="status">
        <PauseCircle size={32} aria-hidden="true" />
        <Heading level={1}>Студия временно недоступна</Heading>
        <Text color="secondary">
          {archived
            ? 'Эта страница больше не принимает записи. Выберите другую студию из каталога.'
            : 'Запись в эту студию сейчас приостановлена. Попробуйте позже или выберите другую студию из каталога.'}
        </Text>
        <Button label="К списку студий" variant="primary" href="/" />
      </section>
    </section>
  );
}
