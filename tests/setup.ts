import {afterEach} from 'vitest';

// jsdom has no matchMedia; several Astryx overlays (dialogs, responsive
// hooks) call it on mount. A minimal stub keeps component tests focused on
// app behavior instead of the missing browser API.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
}

afterEach(() => {
  localStorage.clear();
});
