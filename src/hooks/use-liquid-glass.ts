import {useEffect} from 'react';

function themeTint() {
  const bodyColor = getComputedStyle(document.body).backgroundColor;
  const rootColor = getComputedStyle(document.documentElement).backgroundColor;
  const source = bodyColor === 'transparent' || bodyColor === 'rgba(0, 0, 0, 0)' ? rootColor : bodyColor;
  const channels = source
    .match(/rgba?\(([^)]+)\)/)?.[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .slice(0, 3);
  return channels?.length === 3 ? `rgba(${channels.join(', ')}, 0.28)` : null;
}

export function useLiquidGlass(target: string, snapshot: string, content: string | false, routeKey = '') {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let effect: {destroy: () => void} | undefined;
    let active = true;
    let frame = 0;
    let observer: MutationObserver | undefined;
    const attach = () => {
      if (!active || !document.querySelector(target)) return false;
      observer?.disconnect();
      frame = window.requestAnimationFrame(() => {
      void import('liquid-gl').then(({default: liquidGL}) => {
        if (!active) return;
        effect = liquidGL({
          target,
          snapshot,
          content,
          engine: 'auto',
          resolution: 1,
          refraction: 0.012,
          bevelDepth: 0.07,
          bevelWidth: 0.12,
          frost: 0.4,
          shadow: true,
          specular: true,
          reveal: 'none',
          tilt: false,
          interaction: 'none',
          tint: themeTint(),
        }) as {destroy: () => void} | undefined;
      }).catch(() => { effect = undefined; });
      });
      return true;
    };
    if (!attach()) {
      observer = new MutationObserver(() => { attach(); });
      observer.observe(document.documentElement, {childList: true, subtree: true});
    }
    return () => {
      active = false;
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      effect?.destroy();
    };
  }, [content, routeKey, snapshot, target]);
}
