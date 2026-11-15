import * as React from 'react';

/** A closed terminal can disappear with the last pane tab. Wait for the panel layout to settle,
 * then recover a lost focus without taking it from a surviving control or a newly opened terminal. */
export function useTerminalFocus(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    let inPane = !!document.activeElement?.closest('[data-testid=pane]');
    const remember = (event: FocusEvent) => { inPane = event.target instanceof Element && !!event.target.closest('[data-testid=pane]'); };
    document.addEventListener('focusin', remember);
    return () => {
      document.removeEventListener('focusin', remember);
      if (!inPane) return;
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body) return;
        if ([...document.querySelectorAll<HTMLElement>('[data-testid=terminal-tab]')].some(el => el.getClientRects().length)) return;
        const target = ['[data-testid=pane] [role=tab][aria-selected=true]', '[data-testid=pane] [aria-label="New tab"]', '[data-pane-toggle]']
          .flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)])
          .find(el => el.getClientRects().length);
        target?.focus();
      });
    };
  }, [active]);
}
