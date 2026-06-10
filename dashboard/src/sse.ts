import { useEffect, useRef, useState } from 'react';
import { API_BASE, getToken } from './api';

type Handlers = Record<string, (data: unknown) => void>;

/**
 * Subscribe to a gateway SSE endpoint. EventSource can't set headers, so the
 * JWT goes in the query string. Returns the live connection status (drives the
 * dashboard's real-time indicator). Handlers are kept in a ref so the
 * EventSource isn't torn down on every render.
 */
export function useEventSource(path: string | null, handlers: Handlers): boolean {
  const [connected, setConnected] = useState(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!path) return;
    const token = getToken();
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${token}`;
    const es = new EventSource(url);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const listeners: [string, EventListener][] = [];
    for (const event of Object.keys(handlersRef.current)) {
      const listener = ((e: MessageEvent) => {
        try {
          handlersRef.current[event]?.(JSON.parse(e.data));
        } catch {
          /* ignore malformed */
        }
      }) as EventListener;
      es.addEventListener(event, listener);
      listeners.push([event, listener]);
    }

    return () => {
      for (const [event, listener] of listeners) es.removeEventListener(event, listener);
      es.close();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return connected;
}
