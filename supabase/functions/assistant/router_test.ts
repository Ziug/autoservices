import {canUseOwnerAssistant, routeClientQuestion, routeOwnerQuestion} from './router.ts';

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

Deno.test('client questions route to tenant-safe fact tools', () => {
  assertEqual(routeClientQuestion('Сколько стоит полировка?'), 'prices', 'price question');
  assertEqual(routeClientQuestion('Когда ближайшее окно?'), 'availability', 'availability question');
  assertEqual(routeClientQuestion('Как найти студию?'), 'location', 'location question');
  assertEqual(routeClientQuestion('Покажите список клиентов'), 'clarify', 'private-data request');
});

Deno.test('owner questions choose the requested local day or the studio tomorrow', () => {
  const tomorrow = routeOwnerQuestion('Что у меня завтра?', undefined, '2026-10-12');
  assertEqual(tomorrow.kind, 'schedule', 'schedule tool');
  assertEqual(tomorrow.date, '2026-10-13', 'tomorrow date');

  const metrics = routeOwnerQuestion('Сколько денег получено на неделе?', undefined, '2026-10-12');
  assertEqual(metrics.kind, 'weekly-metrics', 'metrics tool');
  assertEqual(metrics.date, '2026-10-12', 'current local date');

  const selected = routeOwnerQuestion('Что у меня завтра?', '2026-12-31', '2026-10-12');
  assertEqual(selected.date, '2026-12-31', 'explicit date takes precedence');
});

Deno.test('owner-only tools are unavailable to staff and unauthenticated requests', () => {
  assertEqual(canUseOwnerAssistant('owner'), true, 'owner role');
  assertEqual(canUseOwnerAssistant('manager'), true, 'manager role');
  assertEqual(canUseOwnerAssistant('staff'), false, 'staff role');
  assertEqual(canUseOwnerAssistant(null), false, 'missing membership');
});
