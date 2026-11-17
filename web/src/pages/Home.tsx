import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, forgetKey, saveKey, savedKeys, type SavedKey } from '../lib/api';
import { timeAgo, useAction, useToast } from '../lib/ui';

interface Created {
  workshopId: string;
  joinCode: string;
  facilitatorKey: string;
}
interface ServerInfo {
  createNeedsSecret: boolean;
}

export function Home() {
  const navigate = useNavigate();
  const toast = useToast();
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [keys, setKeys] = useState<SavedKey[]>(() => savedKeys());
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<ServerInfo>('/api/server-info').then(setInfo).catch(() => setInfo(null));
  }, []);

  const open = (created: Created, name: string) => {
    saveKey({ workshopId: created.workshopId, kind: 'facilitator', key: created.facilitatorKey, title: name });
    navigate(`/f/${created.workshopId}`);
  };

  const [soloTitle, setSoloTitle] = useState('');
  const create = (kind: 'workshop' | 'solo' | 'example' | 'unconnected') =>
    run(async () => {
      const name =
        kind === 'example' ? 'Example workshop (fictional)' : kind === 'unconnected' ? 'Example: 52 unconnected items (fictional)' : kind === 'solo' ? soloTitle.trim() || 'My model' : title.trim() || 'Untitled workshop';
      const body = { title: name, secret, solo: kind === 'solo', example: kind === 'example' ? true : kind === 'unconnected' ? 'unconnected' : undefined };
      const created = await api<Created>('/api/workshops', { body });
      saveKey({ workshopId: created.workshopId, kind: 'facilitator', key: created.facilitatorKey, title: name });
      navigate(kind === 'solo' || kind === 'unconnected' ? `/x/${created.workshopId}` : `/f/${created.workshopId}`);
    });

  const importFile = (file: File) =>
    run(async () => {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not valid JSON.');
      }
      const name = `${(data as { title?: string }).title ?? 'Workshop'} (imported)`;
      open(await api<Created>('/api/workshops/import', { body: { data, secret } }), name);
    });

  const mine = keys.filter((k) => k.kind === 'facilitator');
  const joined = keys.filter((k) => k.kind === 'participant');

  return (
    <main className="home">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 32 32">
            <circle cx="9" cy="16" r="4" fill="#fff" />
            <circle cx="24" cy="8" r="3.4" fill="#fff" opacity=".85" />
            <circle cx="24" cy="24" r="3.4" fill="#fff" opacity=".85" />
            <path d="M12 15l9-6M12 17l9 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        Backchain
      </div>

      <header className="hero">
        <h1>Work backwards from a goal, together.</h1>
        <p>
          A small group joins on their phones. One question at a time, they propose a goal, the states of the world that would lead to it, how those connect, and what they could actually do. Everyone keeps their own
          model; maps and estimates are only combined if you choose to, and the originals are always kept.
        </p>
      </header>

      <div className="home-grid">
        <section className="card card-pad stack">
          <h2>Join a workshop</h2>
          <p className="muted small">Enter the code your facilitator is showing.</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.trim()) navigate(`/join/${code.trim().toUpperCase()}`);
            }}
          >
            <input
              className="input grow"
              style={{ letterSpacing: '0.14em', textTransform: 'uppercase', fontWeight: 700 }}
              placeholder="CODE"
              aria-label="Workshop code"
              value={code}
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
            />
            <button className="btn btn-primary" disabled={!code.trim()}>
              Join
            </button>
          </form>
          {joined.length > 0 && (
            <div className="stack-sm">
              <h4>Workshops you joined on this device</h4>
              {joined.map((k) => (
                <Link key={k.workshopId} className="btn btn-sm" style={{ justifyContent: 'space-between' }} to={`/p/${k.workshopId}`}>
                  <span className="truncate">{k.title || 'Workshop'}</span>
                  <span className="muted tiny">{timeAgo(k.savedAt)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="card card-pad stack">
          <h2>Run a workshop</h2>
          <p className="muted small">Starts empty: the group builds the whole model during the session.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void create('workshop');
            }}
          >
            <label className="field">
              <span>Workshop name</span>
              <input className="input" placeholder="e.g. Team strategy, March" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </label>
            {info?.createNeedsSecret && (
              <label className="field">
                <span>Access phrase for this server</span>
                <input className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
              </label>
            )}
            <button className="btn btn-primary" disabled={busy}>
              Create workshop
            </button>
          </form>
          <div className="row-wrap">
            <button className="btn btn-sm" disabled={busy} onClick={() => void create('example')}>
              Open a fictional example
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              Import from a file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
          </div>
          <p className="muted tiny">The example is made up (two actions, two states, one goal, two imaginary people) and is labelled as such throughout.</p>
        </section>

        <section className="card card-pad stack">
          <h2>Work on your own</h2>
          <p className="muted small">Build a model by yourself: goal, states, arrows, estimates and actions. No facilitator or other people needed.</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void create('solo');
            }}
          >
            <label className="field">
              <span>Name</span>
              <input className="input" placeholder="My model" value={soloTitle} maxLength={120} onChange={(e) => setSoloTitle(e.target.value)} />
            </label>
            <button className="btn btn-primary" disabled={busy}>
              Start my own model
            </button>
          </form>
          <button className="btn btn-sm" disabled={busy} onClick={() => void create('unconnected')}>
            Try drawing arrows on a 52-item demo
          </button>
          <p className="muted tiny">The demo items are placeholders with no arrows, for trying out the map.</p>
        </section>
      </div>

      {mine.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Your workshops on this device</h2>
          </div>
          <div className="card-body list">
            {mine.map((k) => (
              <div key={k.workshopId} className="row list-item">
                <div className="grow">
                  <div className="truncate" style={{ fontWeight: 600 }}>
                    {k.title || 'Workshop'}
                  </div>
                  <div className="muted tiny">Opened {timeAgo(k.savedAt)}</div>
                </div>
                <Link className="btn btn-sm" to={`/f/${k.workshopId}`}>
                  Organize
                </Link>
                <Link className="btn btn-sm" to={`/x/${k.workshopId}`}>
                  Explore
                </Link>
                <button
                  className="btn btn-sm btn-ghost"
                  title="Remove from this list. The workshop itself stays on the server."
                  onClick={() => {
                    if (!window.confirm('Remove this workshop from the list on this device?\n\nThe workshop stays on the server, but this browser will lose its facilitator access unless you kept the facilitator link.')) return;
                    forgetKey(k.workshopId, 'facilitator');
                    setKeys(savedKeys());
                    toast('Removed from this device');
                  }}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="muted tiny">
        Access to a workshop is held in this browser. To facilitate from another device, copy the facilitator link from the workshop’s <em>Join</em> panel.
      </p>
    </main>
  );
}
