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

// jsdom has no Web Animations API; the booking flow guards on
// prefers-reduced-motion but otherwise calls node.animate(). A minimal stub
// keeps step-transition tests focused on app behavior.
if (typeof window !== 'undefined' && typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  Element.prototype.animate = (() => ({cancel: () => {}, finished: Promise.resolve()})) as unknown as typeof Element.prototype.animate;
}

afterEach(() => {
  localStorage.clear();
});
