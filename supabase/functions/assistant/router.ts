export type ClientQuestionRoute = 'location' | 'prices' | 'availability' | 'services' | 'clarify';
export type OwnerQuestionRoute = {kind: 'schedule' | 'weekly-metrics'; date: string};

export function canUseOwnerAssistant(role: string | null | undefined) {
  return role === 'owner' || role === 'manager';
}

export function routeClientQuestion(message: string): ClientQuestionRoute {
  const text = message.toLocaleLowerCase('ru-RU');
  // Destructive intent always routes to clarify — never to a fact-gathering tool.
  if (/удал|отмен|перенести|убрать|снять/.test(text)) return 'clarify';
  if (/адрес|где|найти|маршрут|как добрат|карта/.test(text)) return 'location';
  if (/цен|стоим|сколько|прайс|price/.test(text)) return 'prices';
  if (/окн|свобод|ближай|когда|запис|время|available/.test(text)) return 'availability';
  if (/услуг|работ|делаете|оказываете|service/.test(text)) return 'services';
  return 'clarify';
}

function shiftDay(day: string, amount: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function routeOwnerQuestion(message: string, requestedDay: string | undefined, today: string): OwnerQuestionRoute {
  const text = message.toLocaleLowerCase('ru-RU');
  const date = requestedDay ?? (/(завтра|tomorrow)/.test(text) ? shiftDay(today, 1) : today);
  const kind = /недел|сколько машин было на неделе|сколько заезд|получен|деньг|оплат|доход|выручк|заверш/.test(text)
    ? 'weekly-metrics'
    : 'schedule';
  return {kind, date};
}
