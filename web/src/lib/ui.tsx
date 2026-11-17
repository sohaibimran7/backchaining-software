import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { WorkshopConfig } from '@shared/config';
import type { ConnectionStatus } from './api';

// — toasts —

interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = next.current++;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 2600);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/** Wraps an async action: shows the server's message if it is refused, and tracks "busy". */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(true);
      try {
        await fn();
        if (done) toast(done);
        return true;
      } catch (err) {
        toast((err as Error).message || 'That did not work.', 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

// — modal —

export function Modal({ title, onClose, children, wide, footer }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={ref}>
        <header className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const label = status === 'live' ? 'Connected' : status === 'loading' ? 'Connecting…' : status === 'reconnecting' ? 'Reconnecting…' : 'Not connected';
  return (
    <span className={`conn conn-${status}`} title={label}>
      <span className="conn-dot" aria-hidden />
      <span className="conn-label">{label}</span>
    </span>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="empty">
      {icon && (
        <div className="empty-icon" aria-hidden>
          {icon}
        </div>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function FullPageMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page-center">
      <div className="card card-pad message-card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** Applies a workshop's configurable colours. */
export function themeStyle(config: WorkshopConfig | undefined): CSSProperties {
  if (!config) return {};
  return {
    '--accent': config.theme.accent,
    '--goal': config.theme.goalColor,
    '--state': config.theme.stateColor,
    '--action': config.theme.actionColor,
  } as CSSProperties;
}

export function KindBadge({ kind, config }: { kind: 'goal' | 'state' | 'action'; config: WorkshopConfig }) {
  return <span className={`kind kind-${kind}`}>{config.labels[kind]}</span>;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
