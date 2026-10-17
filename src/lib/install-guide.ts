import {useEffect, useState} from 'react';

export type BrowserId =
  | 'ios-safari'
  | 'ios-chrome'
  | 'ios-orion'
  | 'ios-other'
  | 'android-chrome'
  | 'android-samsung'
  | 'android-firefox'
  | 'desktop-chrome'
  | 'desktop-safari'
  | 'desktop-edge'
  | 'desktop-firefox'
  | 'unknown';

export interface ManualGuide {
  title: string;
  intro: string;
  steps: string[];
  fallback?: string;
  selector?: boolean;
}

export function detectBrowser(): BrowserId {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);
  const isMac = /Macintosh/i.test(ua);
  const isChrome = /Chrome\//.test(ua) && !/Edg\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !isChrome && !/Edg\//.test(ua);
  const isEdge = /Edg\//.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const isSamsung = /SamsungBrowser\//.test(ua);
  const isOrion = /Orion\//.test(ua);

  if (isIos) {
    if (isSafari) return 'ios-safari';
    if (isChrome) return 'ios-chrome';
    if (isOrion) return 'ios-orion';
    return 'ios-other';
  }
  if (isAndroid) {
    if (isSamsung) return 'android-samsung';
    if (isFirefox) return 'android-firefox';
    return 'android-chrome';
  }
  if (isMac && isSafari) return 'desktop-safari';
  if (isEdge) return 'desktop-edge';
  if (isFirefox) return 'desktop-firefox';
  if (isChrome) return 'desktop-chrome';
  return 'unknown';
}

export function manualGuideFor(browser: BrowserId): ManualGuide {
  switch (browser) {
    case 'ios-safari':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Нажмите «Поделиться».',
          'Выберите «На экран Домой».',
          'Если доступен переключатель «Открыть как веб-приложение», включите его.',
          'Нажмите «Добавить».',
        ],
      };
    case 'ios-chrome':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «Поделиться».',
          'Выберите «На экран Домой», если этот пункт доступен.',
          'Нажмите «Добавить».',
        ],
        fallback: 'Если пункта «На экран Домой» нет, откройте сайт в Safari и следуйте инструкциям для Safari.',
      };
    case 'ios-orion':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: ['Откройте меню браузера.', 'Найдите пункт «На экран Домой» или «Добавить на главный экран».'],
        fallback: 'Если пункта нет, откройте сайт в Safari и следуйте инструкциям для Safari.',
      };
    case 'ios-other':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [],
        fallback: 'В этом браузере установка может быть недоступна. Откройте сайт в Safari и следуйте инструкциям для Safari.',
      };
    case 'android-chrome':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «⋮».',
          'Выберите «Установить приложение» или «Установить» / «Добавить на главный экран», в зависимости от доступного пункта.',
          'Подтвердите действие, если браузер запросит подтверждение.',
        ],
      };
    case 'android-samsung':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «☰».',
          'Выберите «Добавить страницу в».',
          'Выберите «Главный экран».',
        ],
      };
    case 'android-firefox':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «⋮».',
          'Выберите «Дополнительно», если этот пункт доступен.',
          'Выберите «Добавить на главный экран» или «Добавить в ярлыки», в зависимости от версии браузера.',
        ],
        fallback: 'Ярлык Firefox может не работать как отдельное приложение.',
      };
    case 'desktop-chrome':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню браузера «⋮».',
          'Найдите пункт установки приложения. В зависимости от версии он может находиться в разделе «Трансляция, сохранение и отправка» или быть доступен через отдельный значок установки.',
          'Выберите установку, если соответствующая функция доступна.',
        ],
      };
    case 'desktop-safari':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «Поделиться».',
          'Выберите «Добавить в Dock».',
          'Подтвердите действие.',
        ],
      };
    case 'desktop-edge':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [
          'Откройте меню «…».',
          'Перейдите в раздел «Приложения».',
          'Выберите «Установить этот сайт как приложение», если пункт доступен.',
        ],
      };
    case 'desktop-firefox':
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [],
        fallback: 'В этом браузере установка как отдельного приложения недоступна. Используйте закладку или другой браузер.',
      };
    default:
      return {
        title: 'Пара касаний, и готово',
        intro: 'Добавьте иконку студии на главный экран телефона. В следующий раз просто нажмите на неё, чтобы открыть сайт и записаться снова.',
        steps: [],
        fallback: 'Не удалось определить браузер. Откройте сайт в Safari (iOS) или Chrome (Android) и следуйте инструкциям.',
      };
  }
}