import {format, isSameDay, parseISO} from 'date-fns';
import {ru} from 'date-fns/locale';
import {formatInTimeZone} from 'date-fns-tz';

export function money(minor: number, currency: string, locale = 'ru-RU') {
  return new Intl.NumberFormat(locale, {style: 'currency', currency, maximumFractionDigits: 0}).format(minor / 100);
}

export function localDayLabel(iso: string, timezone: string) {
  return formatInTimeZone(parseISO(iso), timezone, 'EEEE, d MMMM', {locale: ru});
}

export function localTimeLabel(iso: string, timezone: string) {
  return formatInTimeZone(parseISO(iso), timezone, 'HH:mm');
}

export function localDateKey(date: Date, timezone: string) {
  return formatInTimeZone(date, timezone, 'yyyy-MM-dd');
}

export function dayLabel(date: Date) {
  return format(date, 'EEE, d MMM', {locale: ru});
}

export {isSameDay, parseISO};
