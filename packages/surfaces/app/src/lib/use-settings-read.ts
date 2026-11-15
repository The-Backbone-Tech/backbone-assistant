import * as React from 'react';
import type { ApiEvent } from '@backbone-next/platform';
import { onEvent } from './api';

/** Keep the last successful inspection, but never let an older request replace a newer one. */
export function useSettingsRead<T>(read: () => Promise<T>, topic: ApiEvent['topic']) {
  const [state, setState] = React.useState<{ value?: T; pending: boolean; failed: boolean }>({ pending: true, failed: false });
  const generation = React.useRef(0);
  const reload = React.useCallback(() => {
    const request = ++generation.current;
    setState(previous => ({ ...previous, pending: true, failed: false }));
    void (async () => {
      try {
        const value = await read();
        if (request === generation.current) setState({ value, pending: false, failed: false });
      } catch {
        if (request === generation.current) setState(previous => ({ ...previous, pending: false, failed: true }));
      }
    })();
  }, [read]);
  React.useEffect(() => {
    reload();
    const off = onEvent(event => { if (event.topic === topic) reload(); });
    return () => { generation.current++; off(); };
  }, [reload, topic]);
  return { ...state, reload };
}
