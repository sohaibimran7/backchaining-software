import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkshopView } from '@shared/types';

/** Keys live in this browser only. A key is what makes you "you" in a workshop. */
export interface SavedKey {
  workshopId: string;
  kind: 'facilitator' | 'participant';
  key: string;
  title: string;
  savedAt: string;
}

const STORE = 'backchain.keys.v1';

function readKeys(): SavedKey[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function savedKeys(): SavedKey[] {
  return readKeys().sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function getKey(workshopId: string, kind: SavedKey['kind']): string | undefined {
  return readKeys().find((k) => k.workshopId === workshopId && k.kind === kind)?.key;
}

export function saveKey(entry: Omit<SavedKey, 'savedAt'>): void {
  const rest = readKeys().filter((k) => !(k.workshopId === entry.workshopId && k.kind === entry.kind));
  try {
    localStorage.setItem(STORE, JSON.stringify([...rest, { ...entry, savedAt: new Date().toISOString() }]));
  } catch {
    /* private mode: the session still works until the tab closes */
  }
}

export function forgetKey(workshopId: string, kind: SavedKey['kind']): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(readKeys().filter((k) => !(k.workshopId === workshopId && k.kind === kind))));
  } catch {
    /* ignore */
  }
}

/**
 * Personal links carry the key after the # (so it is never sent to a server log):
 * #fkey=… for the facilitator, #pkey=… for a participant. Store it and clean the address bar.
 */
export function absorbKeysFromHash(workshopId: string): void {
  const hash = window.location.hash;
  let found = false;
  for (const [param, kind] of [
    ['fkey', 'facilitator'],
    ['pkey', 'participant'],
  ] as const) {
    const m = new RegExp(`[#&]${param}=([A-Za-z0-9_-]+)`).exec(hash);
    if (!m) continue;
    saveKey({ workshopId, kind, key: m[1]!, title: '' });
    found = true;
  }
  if (found) history.replaceState(null, '', window.location.pathname + window.location.search);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; key?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${response.status})`, response.status);
  return data as T;
}

export type ConnectionStatus = 'loading' | 'live' | 'reconnecting' | 'denied' | 'missing-key';

export interface WorkshopConnection {
  view: WorkshopView | null;
  status: ConnectionStatus;
  /** Send a command. Rejects with a readable message if the server refuses it. */
  send: (command: Record<string, unknown>) => Promise<void>;
}

/** Live connection to one workshop: an initial fetch, then a websocket that pushes this client's own view on every change. */
export function useWorkshop(workshopId: string, key: string | undefined): WorkshopConnection {
  const [view, setView] = useState<WorkshopView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(key ? 'loading' : 'missing-key');
  const latestSeq = useRef(0);

  useEffect(() => {
    if (!key) {
      setStatus('missing-key');
      return;
    }
    let closed = false;
    let socket: WebSocket | null = null;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const accept = (v: WorkshopView) => {
      latestSeq.current = v.seq;
      setView(v);
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'hello', workshopId, key }));
      socket.onmessage = (event) => {
        const msg = JSON.parse(String(event.data)) as { type: string; view?: WorkshopView };
        if (msg.type === 'view' && msg.view) {
          retry = 0;
          accept(msg.view);
          setStatus('live');
        } else if (msg.type === 'denied') {
          closed = true;
          setStatus('denied');
        }
      };
      socket.onclose = () => {
        if (closed) return;
        setStatus((s) => (s === 'denied' ? s : 'reconnecting'));
        retry += 1;
        timer = setTimeout(connect, Math.min(8000, 400 * 2 ** Math.min(retry, 5)));
      };
      socket.onerror = () => socket?.close();
    };

    api<WorkshopView>(`/api/workshops/${workshopId}/view`, { key })
      .then((v) => {
        if (closed) return;
        accept(v);
        connect();
      })
      .catch((err: ApiError) => {
        if (closed) return;
        if (err.status === 403 || err.status === 404) setStatus('denied');
        else {
          setStatus('reconnecting');
          connect();
        }
      });

    // Phones suspend sockets in the background; reconnect promptly when the page is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && socket && socket.readyState > WebSocket.OPEN) {
        clearTimeout(timer);
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      socket?.close();
    };
  }, [workshopId, key]);

  const send = useCallback(
    async (command: Record<string, unknown>) => {
      await api(`/api/workshops/${workshopId}/commands`, { body: command, key });
    },
    [workshopId, key],
  );

  return { view, status, send };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workshop';
}
