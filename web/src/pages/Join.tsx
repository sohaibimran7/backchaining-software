import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, getKey, saveKey, type ApiError } from '../lib/api';
import { FullPageMessage, Spinner, useAction } from '../lib/ui';

export function Join() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const { busy, run } = useAction();
  const [found, setFound] = useState<{ workshopId: string; title: string } | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    if (!code) return;
    setError('');
    setFound(null);
    api<{ workshopId: string; title: string }>(`/api/join/${encodeURIComponent(code)}`)
      .then((w) => {
        // Already joined on this device: go straight back in as the same person.
        if (getKey(w.workshopId, 'participant')) navigate(`/p/${w.workshopId}`, { replace: true });
        else setFound(w);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [code, navigate]);

  if (!code || error) {
    return (
      <FullPageMessage title="Join a workshop">
        {error && <div className="banner banner-warn">{error}</div>}
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) navigate(`/join/${manual.trim().toUpperCase()}`);
          }}
        >
          <label className="field">
            <span>Workshop code</span>
            <input className="input" autoFocus autoCapitalize="characters" autoComplete="off" style={{ letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700 }} value={manual} onChange={(e) => setManual(e.target.value)} />
          </label>
          <button className="btn btn-primary btn-lg" disabled={!manual.trim()}>
            Continue
          </button>
        </form>
      </FullPageMessage>
    );
  }
  if (!found) return <Spinner label="Finding the workshop…" />;

  return (
    <FullPageMessage title={found.title}>
      <p className="muted">What should we call you? The others will see this name.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const joined = await api<{ workshopId: string; participantKey: string }>('/api/join', { body: { code, name } });
            saveKey({ workshopId: joined.workshopId, kind: 'participant', key: joined.participantKey, title: found.title });
            navigate(`/p/${joined.workshopId}`, { replace: true });
          });
        }}
      >
        <label className="field">
          <span>Your name</span>
          <input className="input" autoFocus value={name} maxLength={40} autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-lg" disabled={busy || !name.trim()}>
          Join
        </button>
      </form>
      <p className="muted tiny">This device will remember you, so you can close the tab and come back.</p>
    </FullPageMessage>
  );
}
