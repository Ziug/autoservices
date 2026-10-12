import {useEffect, type ReactNode} from 'react';

export function RevealSections({children, routeKey}: {children: ReactNode; routeKey: string}) {
  useEffect(() => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      targets.forEach((target) => target.classList.add('is-visible'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, {threshold: 0.12});
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [routeKey]);
  return children;
}
