/** The organizer's console: join details, one live question at a time, incoming suggestions, the question queue, and the five layers. */
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { buildParticipantModel } from '@shared/model';
import { similarity } from '@shared/synthesis';
import { renderQuestion } from '@shared/templates';
import { LAYERS, type Layer, type Question, type Suggestion, type WorkshopView } from '@shared/types';
import { formatValue } from '../components/AnswerInput';
import { ConfigEditor } from '../components/ConfigEditor';
import { MapView } from '../components/MapView';
import { absorbKeysFromHash, api, getKey, saveKey, useWorkshop } from '../lib/api';
import { ConnectionDot, Empty, FullPageMessage, KindBadge, Modal, Spinner, themeStyle, useAction, useToast } from '../lib/ui';

type Send = (command: Record<string, unknown>) => Promise<void>;
const COLORS = ['#4f46e5', '#0f766e', '#b45309', '#be185d', '#1d4ed8', '#7c3aed', '#15803d', '#b91c1c'];

export function Facilitator() {
  const { workshopId = '' } = useParams();
  const [key] = useState(() => {
    absorbKeysFromHash(workshopId);
    return getKey(workshopId, 'facilitator');
  });
  const { view, status, send } = useWorkshop(workshopId, key);
  // Keep the saved title in step so the start page lists it properly.
  useEffect(() => {
    if (view && key) saveKey({ workshopId, kind: 'facilitator', key, title: view.title });
  }, [view?.title, workshopId, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'missing-key' || status === 'denied') {
    return (
      <FullPageMessage title="This device cannot organize that workshop">
        <p className="muted">Organizer access is held by the browser that created the workshop. Open it there, or use the organizer link copied from its Join panel.</p>
        <Link className="btn btn-primary" to="/">
          Go to the start
        </Link>
      </FullPageMessage>
    );
  }
  if (!view || view.role.type !== 'facilitator') return <Spinner label="Opening the workshop…" />;
  return <Console view={view} status={status} send={send} workshopId={workshopId} accessKey={key!} />;
}

function Console({ view, status, send, workshopId, accessKey }: { view: WorkshopView; status: ReturnType<typeof useWorkshop>['status']; send: Send; workshopId: string; accessKey: string }) {
  const [config, setConfig] = useState(false);
  const [title, setTitle] = useState(view.title);
  const { run } = useAction();
  useEffect(() => setTitle(view.title), [view.title]);
  const stage = view.config.stages.find((s) => s.id === view.stageId);
  const live = view.liveQuestionId ? view.questions[view.liveQuestionId] : undefined;

  return (
    <div style={themeStyle(view.config)}>
      <header className="app-bar">
        <Link className="btn btn-sm btn-ghost" to="/" aria-label="Start page">
          ←
        </Link>
        <input
          className="app-title"
          aria-label="Workshop name"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== view.title && void run(() => send({ type: 'set_title', title: title.trim() }))}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {view.isExample && <span className="chip chip-warn">Fictional example</span>}
        <span className="grow" />
        <ConnectionDot status={status} />
        <button className="btn btn-sm" onClick={() => setConfig(true)}>
          Configure
        </button>
        <Link className="btn btn-sm btn-primary" to={`/x/${workshopId}`}>
          Open the map
        </Link>
      </header>
      <div style={{ padding: '12px 20px 0', maxWidth: 1600, margin: '0 auto' }}>
        <div className="stepper" role="list" aria-label="Stages">
          {view.config.stages.map((s, i) => (
            <button key={s.id} role="listitem" className="step" aria-current={s.id === view.stageId ? 'step' : undefined} onClick={() => void run(() => send({ type: 'set_stage', stageId: s.id }))}>
              <span className="step-n">{i + 1}</span>
              {s.title}
            </button>
          ))}
        </div>
      </div>
      <div className="fac-layout">
        <div className="stack-lg">
          <JoinPanel view={view} workshopId={workshopId} accessKey={accessKey} />
          <People view={view} live={live} send={send} workshopId={workshopId} accessKey={accessKey} />
        </div>
        <div className="stack-lg">
          {stage?.facilitatorHint && (
            <div className="banner banner-accent">
              <strong>{stage.title}.</strong> {stage.facilitatorHint}
            </div>
          )}
          <GoalCard view={view} send={send} />
          <LiveCard view={view} live={live} send={send} />
          <Inbox view={view} send={send} />
          <Queue view={view} send={send} />
        </div>
        <div className="stack-lg fac-right">
          <LayersPanel view={view} send={send} />
          <section className="card">
            <div className="card-head">
              <h2 className="grow">Everything proposed</h2>
              <Link className="btn btn-sm" to={`/x/${workshopId}`}>
                Open
              </Link>
            </div>
            <div className="mini-map map-wrap">
              {Object.values(view.nodes).some((n) => n.status === 'active') ? (
                <MapView
                  view={view}
                  model={null}
                  selectedId={null}
                  onSelect={() => {}}
                  canConnect={false}
                  tapConnect={false}
                  onConnect={() => {}}
                  search=""
                  focusId={null}
                  focusSteps={1}
                  collapsed={new Set()}
                  showUnreviewed
                  showRejected={false}
                  badges={{}}
                  tidySignal={0}
                  canSaveLayout={false}
                  compact
                />
              ) : (
                <Empty title="Nothing on the map yet" icon="◇">
                  Items appear here as you accept suggestions.
                </Empty>
              )}
            </div>
          </section>
        </div>
      </div>
      {config && <ConfigEditor view={view} send={send} onClose={() => setConfig(false)} />}
    </div>
  );
}

// — joining —

function JoinPanel({ view, workshopId, accessKey }: { view: WorkshopView; workshopId: string; accessKey: string }) {
  const toast = useToast();
  const [info, setInfo] = useState<{ publicBaseUrl: string | null; lanAddresses: string[] } | null>(null);
  const [base, setBase] = useState(window.location.origin);
  const [qr, setQr] = useState('');
  const [big, setBig] = useState(false);
  useEffect(() => {
    api<{ publicBaseUrl: string | null; lanAddresses: string[] }>('/api/server-info')
      .then((i) => {
        setInfo(i);
        if (i.publicBaseUrl) setBase(i.publicBaseUrl);
      })
      .catch(() => {});
  }, []);
  const url = `${base}/join/${view.joinCode}`;
  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setQr, () => setQr(''));
  }, [url]);
  const isLocal = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
  const lanOptions = (info?.lanAddresses ?? []).map((a) => `${window.location.protocol}//${a}${window.location.port ? `:${window.location.port}` : ''}`);
  const copy = (text: string, done: string) => void navigator.clipboard?.writeText(text).then(() => toast(done), () => toast('Could not copy', 'error'));

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">Join</h2>
        <button className="btn btn-sm" onClick={() => setBig(true)}>
          Show large
        </button>
      </div>
      <div className="card-body stack">
        {qr && <div className="qr-box" role="img" aria-label="QR code for the join link" dangerouslySetInnerHTML={{ __html: qr }} />}
        <div className="join-code" aria-label="Workshop code">
          {view.joinCode}
        </div>
        <button className="btn btn-sm" onClick={() => copy(url, 'Join link copied')}>
          Copy join link
        </button>
        <div className="tiny muted code" style={{ wordBreak: 'break-all' }}>
          {url}
        </div>
        {isLocal && (
          <div className="banner banner-warn small stack-sm">
            <span>
              This link uses <strong>localhost</strong>, which only works on this computer. Phones need an address they can reach.
            </span>
            {lanOptions.length > 0 ? (
              <>
                <span>On the same Wi-Fi, try:</span>
                {lanOptions.map((o) => (
                  <button key={o} className="btn btn-sm" onClick={() => setBase(o)}>
                    Use {o}
                  </button>
                ))}
              </>
            ) : (
              <span>Set PUBLIC_BASE_URL on the server to the address participants should use.</span>
            )}
          </div>
        )}
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Organize from another device
          </summary>
          <div className="stack-sm" style={{ marginTop: 8 }}>
            <p className="tiny muted">Anyone with this link can run the workshop. Keep it to yourself.</p>
            <button className="btn btn-sm" onClick={() => copy(`${base}/f/${workshopId}#fkey=${accessKey}`, 'Organizer link copied')}>
              Copy organizer link
            </button>
          </div>
        </details>
      </div>
      {big && (
        <Modal title={`Join “${view.title}”`} onClose={() => setBig(false)}>
          <div className="stack" style={{ textAlign: 'center' }}>
            {qr && <div className="qr-box" style={{ padding: 20 }} dangerouslySetInnerHTML={{ __html: qr.replace('<svg', '<svg style="max-width:420px"') }} />}
            <p className="muted">Scan with your phone’s camera, or open</p>
            <div style={{ fontSize: '1.2rem', fontWeight: 650, wordBreak: 'break-all' }}>{base.replace(/^https?:\/\//, '')}/join</div>
            <p className="muted">and enter</p>
            <div className="join-code" style={{ fontSize: '3rem' }}>
              {view.joinCode}
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function People({ view, live, send, workshopId, accessKey }: { view: WorkshopView; live?: Question; send: Send; workshopId: string; accessKey: string }) {
  const toast = useToast();
  const { run, busy } = useAction();
  const people = Object.values(view.participants).sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  const responded = new Set(live ? (view.progress[live.id]?.respondedIds ?? []) : []);
  const arrows = useMemo(() => Object.fromEntries(people.map((p) => [p.id, buildParticipantModel(view, p.id).links.filter((l) => l.stance === 'yes' || l.stance === 'conditional').length])), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">People</h2>
        <span className="chip">{people.filter((p) => p.active).length}</span>
      </div>
      <div className="card-body">
        {people.length === 0 && (
          <Empty title="Nobody has joined yet" icon="☺">
            Share the code or the QR code above.
          </Empty>
        )}
        {people.map((p) => (
          <div key={p.id} className="person" style={{ opacity: p.active ? 1 : 0.55 }}>
            <span className={`avatar ${view.online.includes(p.id) ? 'online' : ''}`} style={{ background: COLORS[p.colorIndex % COLORS.length] }} title={view.online.includes(p.id) ? 'Connected' : 'Not connected right now'}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="grow">
              <div className="truncate" style={{ fontWeight: 600 }}>
                {p.name}
              </div>
              <div className="tiny muted">
                {!p.active ? 'not taking part' : live ? (responded.has(p.id) ? 'responded' : 'thinking…') : `${arrows[p.id]} arrow${arrows[p.id] === 1 ? '' : 's'}`}
              </div>
            </div>
            {live && p.active && <span className={`chip ${responded.has(p.id) ? 'chip-ok' : ''}`}>{responded.has(p.id) ? '✓' : '…'}</span>}
            <details style={{ position: 'relative' }}>
              <summary className="icon-btn" style={{ listStyle: 'none' }} aria-label={`Options for ${p.name}`}>
                ⋯
              </summary>
              <div className="card card-pad stack-sm" style={{ position: 'absolute', right: 0, zIndex: 5, width: 250, padding: 10 }}>
                <Link className="btn btn-sm" to={`/x/${workshopId}`}>
                  See their map
                </Link>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  title="For someone who lost their place (new phone, cleared browser). Their previous link stops working."
                  onClick={() => {
                    if (!window.confirm(`Create a new personal link for ${p.name}?\n\nUse this if they lost their place. Their previous device will be signed out.`)) return;
                    void run(async () => {
                      const r = await api<{ participantKey: string }>(`/api/workshops/${workshopId}/participants/${p.id}/key`, { body: {}, key: accessKey });
                      await navigator.clipboard?.writeText(`${window.location.origin}/p/${workshopId}#pkey=${r.participantKey}`);
                      toast(`Personal link for ${p.name} copied. Send it to them privately.`);
                    });
                  }}
                >
                  New personal link…
                </button>
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'set_participant_active', participantId: p.id, active: !p.active }))}>
                  {p.active ? 'Mark as not taking part' : 'Mark as taking part'}
                </button>
              </div>
            </details>
          </div>
        ))}
      </div>
    </section>
  );
}

// — layers —

const LAYER_WORDS: Record<Layer, { name: string; open: string; pooled: string }> = {
  goals: { name: 'Goals', open: 'People can add goals themselves', pooled: 'Everyone sees all goals' },
  states: { name: 'States', open: 'People can add states themselves', pooled: 'Everyone sees all states' },
  actions: { name: 'Actions', open: 'People can add actions themselves', pooled: 'Everyone sees all actions' },
  connections: { name: 'Connections', open: 'People can draw their own arrows on the map', pooled: 'Everyone sees every proposed arrow (not who holds it)' },
  estimates: { name: 'Estimates', open: 'People can give estimates without being asked one by one', pooled: 'Everyone sees each other’s estimates' },
};

function LayersPanel({ view, send }: { view: WorkshopView; send: Send }) {
  const { run } = useAction();
  const set = (layer: Layer, change: { open?: boolean; pooled?: boolean }) => void run(() => send({ type: 'set_settings', layers: { [layer]: change } }));
  return (
    <section className="card">
      <div className="card-head">
        <h2>Own work and pooling</h2>
      </div>
      <div className="card-body stack">
        <div className="layer-grid">
          <span className="head">Layer</span>
          <span className="head">Own work</span>
          <span className="head">Pooled</span>
          {LAYERS.map((layer) => (
            <LayerRow key={layer} layer={layer} view={view} set={set} />
          ))}
        </div>
        <p className="tiny muted">
          <strong>Own work</strong> lets people work on that layer by themselves. <strong>Pooled</strong> shows everyone the combined catalogue for it. Pooling never makes people agree: everyone can see the same states and still draw
          different arrows over them. Both switches can be changed at any time, and nothing personal is overwritten.
        </p>
        <hr />
        <label className="switch">
          <input type="checkbox" checked={view.settings.shareModels} onChange={(e) => void run(() => send({ type: 'set_settings', shareModels: e.target.checked }))} />
          Let people see each other’s whole maps
        </label>
        <p className="tiny muted">
          Shows who holds which arrows and their reasoning, and lets people compare or combine their map with someone else’s. Combined maps are saved separately from everyone’s own; see <em>Combine</em> on the map screen.
        </p>
      </div>
    </section>
  );
}

function LayerRow({ layer, view, set }: { layer: Layer; view: WorkshopView; set: (layer: Layer, change: { open?: boolean; pooled?: boolean }) => void }) {
  const s = view.settings.layers[layer];
  const w = LAYER_WORDS[layer];
  return (
    <>
      <span style={{ fontWeight: 600 }}>{w.name}</span>
      <label className="switch" title={w.open}>
        <input type="checkbox" checked={s.open} aria-label={`${w.name}: ${w.open}`} onChange={(e) => set(layer, { open: e.target.checked })} />
      </label>
      <label className="switch" title={w.pooled}>
        <input type="checkbox" checked={s.pooled} aria-label={`${w.name}: ${w.pooled}`} onChange={(e) => set(layer, { pooled: e.target.checked })} />
      </label>
    </>
  );
}

// — goal —

function GoalCard({ view, send }: { view: WorkshopView; send: Send }) {
  const { run, busy } = useAction();
  const candidates = Object.values(view.nodes).filter((n) => n.kind === 'goal' && n.status === 'active');
  const [nodeId, setNodeId] = useState(view.goal.nodeId ?? '');
  const [success, setSuccess] = useState(view.goal.successDefinition);
  const [horizon, setHorizon] = useState(view.goal.horizon);
  const [newGoal, setNewGoal] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setNodeId(view.goal.nodeId ?? '');
    setSuccess(view.goal.successDefinition);
    setHorizon(view.goal.horizon);
  }, [view.goal.nodeId, view.goal.successDefinition, view.goal.horizon]);
  const chosen = view.goal.nodeId ? view.nodes[view.goal.nodeId] : undefined;
  const preferenceQ = Object.values(view.questions).find((q) => q.templateId === 'goal-preference');
  const votes: Record<string, number> = {};
  for (const list of Object.values(preferenceQ ? (view.answers[preferenceQ.id] ?? {}) : {})) {
    const v = list[list.length - 1]?.value;
    if (v?.kind === 'pick-node') votes[v.nodeId] = (votes[v.nodeId] ?? 0) + 1;
  }
  const showForm = open || (!chosen && candidates.length > 0) || view.stageId === 'choose-goal';
  if (candidates.length === 0 && !showForm && view.stageId !== 'goals') {
    return (
      <section className="card card-pad stack-sm">
        <h2>Goal</h2>
        <p className="small muted">No goals proposed yet. Ask the goal question below, or add one directly.</p>
        <AddGoal value={newGoal} setValue={setNewGoal} send={send} />
      </section>
    );
  }
  if (candidates.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">Goal</h2>
        {chosen && !showForm && (
          <button className="btn btn-sm" onClick={() => setOpen(true)}>
            Change
          </button>
        )}
      </div>
      <div className="card-body stack">
        {chosen && !showForm ? (
          <div className="stack-sm">
            <div style={{ fontWeight: 650, fontSize: '1.1rem' }}>{chosen.label}</div>
            <div className="small muted">
              {view.goal.successDefinition || 'No success definition yet'} · {view.goal.horizon ? `by ${view.goal.horizon}` : 'no time horizon yet'}
            </div>
          </div>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await send({ type: 'select_goal', nodeId, successDefinition: success, horizon });
                setOpen(false);
              }, 'Goal recorded');
            }}
          >
            <div className="stack-sm" role="radiogroup" aria-label="Which goal">
              {candidates.map((g) => (
                <button key={g.id} type="button" role="radio" aria-checked={nodeId === g.id} className="option-btn" style={{ minHeight: 46, padding: '9px 14px' }} onClick={() => setNodeId(g.id)}>
                  <span className="option-radio" aria-hidden />
                  <span className="grow">{g.label}</span>
                  {votes[g.id] ? <span className="chip">{votes[g.id]} prefer this</span> : null}
                </button>
              ))}
            </div>
            <AddGoal value={newGoal} setValue={setNewGoal} send={send} />
            <div className="grid-2">
              <label className="field">
                <span>What counts as success</span>
                <input className="input" value={success} maxLength={600} placeholder="It would be true that…" onChange={(e) => setSuccess(e.target.value)} />
              </label>
              <label className="field">
                <span>By when</span>
                <input className="input" value={horizon} maxLength={120} placeholder="e.g. the end of 2027" onChange={(e) => setHorizon(e.target.value)} />
              </label>
            </div>
            <div className="row-wrap">
              <button className="btn btn-primary" disabled={busy || !nodeId}>
                {chosen ? 'Update the goal' : 'Record this as the goal'}
              </button>
              {open && (
                <button type="button" className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              )}
              {chosen && <span className="tiny muted">Changing the goal or time horizon flags answers that depend on it for review.</span>}
            </div>
          </form>
        )}
      </div>
    </section>
  );
}

function AddGoal({ value, setValue, send }: { value: string; setValue: (v: string) => void; send: Send }) {
  const { run, busy } = useAction();
  return (
    <div className="row">
      <input className="input grow" value={value} maxLength={120} placeholder="Add a goal directly…" aria-label="Add a goal directly" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} />
      <button
        type="button"
        className="btn"
        disabled={busy || !value.trim()}
        onClick={() =>
          void run(async () => {
            await send({ type: 'add_node', kind: 'goal', label: value.trim() });
            setValue('');
          })
        }
      >
        Add
      </button>
    </div>
  );
}

// — the live question —

function LiveCard({ view, live, send }: { view: WorkshopView; live?: Question; send: Send }) {
  const { run, busy } = useAction();
  const queued = Object.values(view.questions)
    .filter((q) => q.queuedAt && q.status !== 'live' && q.status !== 'dismissed' && q.status !== 'superseded')
    .sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!));
  const next = queued[0];
  if (!live) {
    return (
      <section className="card card-pad stack-sm">
        <h2>No question is live</h2>
        <p className="small muted">Participants see a calm waiting screen. Pick a question below to put it on everyone’s phone.</p>
        {next && (
          <div>
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => send({ type: 'publish_question', questionId: next.id }))}>
              Ask next: {renderQuestion(view, next).prompt}
            </button>
          </div>
        )}
      </section>
    );
  }
  const r = renderQuestion(view, live);
  const progress = view.progress[live.id] ?? { responded: 0, total: 0 };
  const answers = Object.entries(view.answers[live.id] ?? {});
  const suggestions = Object.values(view.suggestions).filter((s) => s.questionId === live.id && s.status !== 'withdrawn');
  return (
    <section className="card live-card">
      <div className="card-head">
        <span className="live-tag">LIVE</span>
        <span className="chip">{r.title}</span>
        <span className="grow" />
        <span className="small muted">
          {progress.responded} of {progress.total} responded
        </span>
      </div>
      <div className="card-body stack">
        <div className="stack-sm">
          <h2 style={{ fontSize: '1.3rem' }}>{r.prompt}</h2>
          {r.help && <p className="small muted">{r.help}</p>}
        </div>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.responded}>
          <span style={{ width: `${progress.total ? (progress.responded / progress.total) * 100 : 0}%` }} />
        </div>
        <div className="row-wrap">
          <label className="switch">
            <input type="checkbox" checked={live.revealed} onChange={(e) => void run(() => send({ type: 'reveal_question', questionId: live.id, revealed: e.target.checked }))} />
            Show participants each other’s answers
          </label>
          <span className="grow" />
          <button className="btn" disabled={busy} onClick={() => void run(() => send({ type: 'close_question' }))}>
            Close question
          </button>
          {next && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void run(() => send({ type: 'publish_question', questionId: next.id }))}>
              Next question →
            </button>
          )}
        </div>
        {!live.revealed && <p className="tiny muted">Answers are hidden from other participants until you choose to show them, so nobody is steered by what others said. You can see them here.</p>}
        {(r.answer.type === 'suggestions' || r.answer.type === 'nominate-links') && <p className="small muted">{suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'} so far. Deal with them under “Suggestions to sort” below.</p>}
        {answers.length > 0 && r.answer.type !== 'suggestions' && r.answer.type !== 'nominate-links' && (
          <div className="stack-sm">
            <h4>Answers (only you see these{live.revealed ? ' — and participants, now' : ''})</h4>
            {answers.map(([pid, list]) => {
              const a = list[list.length - 1]!;
              return (
                <div key={pid} className="response">
                  <span className="tiny muted">
                    {view.participants[pid]?.name}
                    {a.revision > 1 ? ` · changed ${a.revision - 1}×` : ''}
                  </span>
                  <span className="answer-value">{formatValue(view, r.answer, a.value)}</span>
                  {a.reasoning && <span className="small muted">“{a.reasoning}”</span>}
                </div>
              );
            })}
            <p className="tiny muted">Shown one by one on purpose. Nothing here is averaged.</p>
          </div>
        )}
      </div>
    </section>
  );
}

// — suggestions —

function Inbox({ view, send }: { view: WorkshopView; send: Send }) {
  const pending = Object.values(view.suggestions)
    .filter((s) => s.status === 'pending')
    .sort((a, b) => a.at.localeCompare(b.at));
  const declined = Object.values(view.suggestions).filter((s) => s.status === 'declined');
  const { run, busy } = useAction();
  if (pending.length === 0 && declined.length === 0) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">Suggestions to sort</h2>
        {pending.length > 0 && <span className="chip chip-accent">{pending.length}</span>}
      </div>
      <div className="card-body stack">
        {pending.length === 0 && <p className="small muted">All sorted.</p>}
        {pending.map((s) => (
          <SuggestionCard key={s.id} view={view} suggestion={s} send={send} />
        ))}
        {declined.length > 0 && (
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              Set aside ({declined.length})
            </summary>
            <div className="stack-sm" style={{ marginTop: 8 }}>
              {declined.map((s) => (
                <div key={s.id} className="row small">
                  <span className="grow">
                    {s.text} <span className="muted">— {view.participants[s.participantId]?.name}</span>
                  </span>
                  <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'resolve_suggestion', suggestionId: s.id, resolution: 'reopen' }))}>
                    Bring back
                  </button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function SuggestionCard({ view, suggestion: s, send }: { view: WorkshopView; suggestion: Suggestion; send: Send }) {
  const { run, busy } = useAction();
  const [label, setLabel] = useState(s.text);
  const [picking, setPicking] = useState(false);
  const question = view.questions[s.questionId];
  const r = question ? renderQuestion(view, question) : undefined;
  const kind = r?.answer.type === 'suggestions' ? r.answer.creates.nodeKind : r?.answer.type === 'nominate-links' ? (r.answer.allowNew ?? 'state') : 'state';
  const sameKind = Object.values(view.nodes).filter((n) => n.status === 'active' && n.kind === kind);
  const similar = sameKind
    .map((n) => ({ n, score: similarity(n.label, s.text) }))
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const merge = (nodeId: string) => {
    const into = view.nodes[nodeId]!;
    if (!window.confirm(`Treat “${s.text}” as the same as “${into.label}”?\n\nThe suggestion is folded into the existing item. ${view.participants[s.participantId]?.name ?? 'The person'} stays on record as having suggested it in their own words. This does not mean they agree with anything else about that item.`)) return;
    void run(() => send({ type: 'resolve_suggestion', suggestionId: s.id, resolution: 'merge', intoNodeId: nodeId, confirm: true }), 'Combined');
  };
  return (
    <div className="sugg">
      <div className="row-wrap">
        <KindBadge kind={kind} config={view.config} />
        <span className="small muted">
          from {view.participants[s.participantId]?.name ?? 'someone'}
          {r ? ` · ${r.about === 'Whole workshop' ? r.title : `for “${r.about}”`}` : ''}
        </span>
      </div>
      <input className="input" value={label} maxLength={120} aria-label="Wording to put on the map" onChange={(e) => setLabel(e.target.value)} />
      {label.trim() !== s.text && <div className="tiny muted">Original wording “{s.text}” is kept in the record.</div>}
      {similar.length > 0 && (
        <div className="stack-sm">
          <span className="tiny muted">Looks similar to something already on the map:</span>
          <div className="row-wrap">
            {similar.map(({ n }) => (
              <button key={n.id} className="btn btn-sm" disabled={busy} onClick={() => merge(n.id)}>
                Same as “{n.label}”…
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="row-wrap">
        <button className="btn btn-primary btn-sm" disabled={busy || !label.trim()} onClick={() => void run(() => send({ type: 'resolve_suggestion', suggestionId: s.id, resolution: 'accept', label: label.trim() }), 'Added to the map')}>
          Add to the map
        </button>
        {sameKind.length > 0 && (
          <button className="btn btn-sm" onClick={() => setPicking((p) => !p)}>
            Same as another item…
          </button>
        )}
        <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => send({ type: 'resolve_suggestion', suggestionId: s.id, resolution: 'decline' }))}>
          Set aside
        </button>
      </div>
      {picking && (
        <select className="select" defaultValue="" aria-label="Existing item this matches" onChange={(e) => e.target.value && merge(e.target.value)}>
          <option value="">Choose the existing item…</option>
          {sameKind
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
        </select>
      )}
    </div>
  );
}

// — the queue —

function Queue({ view, send }: { view: WorkshopView; send: Send }) {
  const { run, busy } = useAction();
  const [stageId, setStageId] = useState(view.stageId);
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [custom, setCustom] = useState(false);
  useEffect(() => setStageId(view.stageId), [view.stageId]);
  const all = Object.values(view.questions).filter((q) => q.status !== 'superseded' && q.status !== 'live');
  const rendered = useMemo(() => new Map(all.map((q) => [q.id, renderQuestion(view, q)])), [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const age = (q: Question) => (q.subject.type === 'node' ? (view.nodes[q.subject.nodeId]?.createdAt ?? '') : q.subject.type === 'link' ? (view.links[q.subject.linkId]?.createdAt ?? '') : '');
  const inStage = all.filter((q) => rendered.get(q.id)!.stageId === stageId && (!filter.trim() || rendered.get(q.id)!.prompt.toLowerCase().includes(filter.trim().toLowerCase())));
  const queued = all.filter((q) => q.queuedAt && q.status !== 'dismissed').sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!));
  // Oldest items first: that walks outwards from the goal, level by level.
  const drafts = inStage.filter((q) => q.status === 'draft' && !q.queuedAt).sort((a, b) => age(a).localeCompare(age(b)) || a.id.localeCompare(b.id));
  const asked = inStage.filter((q) => q.status === 'closed').sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const aside = inStage.filter((q) => q.status === 'dismissed' && !q.autoDismissed);
  const counts = Object.fromEntries(view.config.stages.map((s) => [s.id, all.filter((q) => rendered.get(q.id)!.stageId === s.id && q.status === 'draft').length]));
  const row = (q: Question, actions: React.ReactNode) => {
    const r = rendered.get(q.id)!;
    const p = view.progress[q.id];
    return (
      <div key={q.id} className="q-row">
        <div className="grow">
          <div className="q-text">{r.prompt}</div>
          <div className="tiny muted">
            {r.title}
            {p && q.rounds > 0 ? ` · ${p.responded} of ${p.total} responded` : ''}
            {q.revealed ? ' · answers shown to participants' : ''}
          </div>
        </div>
        <div className="row-wrap" style={{ justifyContent: 'flex-end' }}>
          {actions}
        </div>
      </div>
    );
  };
  const ask = (q: Question, label = 'Ask now') => (
    <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => send({ type: 'publish_question', questionId: q.id }))}>
      {label}
    </button>
  );
  const shownDrafts = showAll ? drafts : drafts.slice(0, 8);
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">Questions</h2>
        <button className="btn btn-sm" onClick={() => setCustom(true)}>
          Write your own
        </button>
      </div>
      <div className="card-body stack">
        {queued.length > 0 && (
          <div>
            <h4>Lined up</h4>
            <div className="list">
              {queued.map((q) =>
                row(
                  q,
                  <>
                    {ask(q)}
                    <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => send({ type: 'queue_question', questionId: q.id, queued: false }))}>
                      Remove
                    </button>
                  </>,
                ),
              )}
            </div>
          </div>
        )}
        <div className="tabs" role="tablist" aria-label="Stage">
          {view.config.stages.map((s) => (
            <button key={s.id} role="tab" className="tab" aria-selected={stageId === s.id} onClick={() => (setStageId(s.id), setShowAll(false))}>
              {s.title}
              {counts[s.id] ? ` · ${counts[s.id]}` : ''}
            </button>
          ))}
        </div>
        {inStage.length + (filter ? 1 : 0) > 8 && <input className="input" type="search" placeholder="Filter questions…" aria-label="Filter questions" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <div>
          <h4>Ready to ask</h4>
          {drafts.length === 0 ? (
            <p className="small muted" style={{ padding: '8px 0' }}>
              Nothing waiting in this stage. New questions appear automatically as items and arrows are added.
            </p>
          ) : (
            <div className="list">
              {shownDrafts.map((q) =>
                row(
                  q,
                  <>
                    {ask(q)}
                    <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'queue_question', questionId: q.id, queued: true }))}>
                      Line up
                    </button>
                    <button className="btn btn-sm btn-ghost" disabled={busy} title="Hide this question. It can be restored." onClick={() => void run(() => send({ type: 'dismiss_question', questionId: q.id, dismissed: true }))}>
                      Skip
                    </button>
                  </>,
                ),
              )}
            </div>
          )}
          {drafts.length > shownDrafts.length && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShowAll(true)}>
              Show all {drafts.length}
            </button>
          )}
        </div>
        {asked.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer' }}>
              <h4 style={{ display: 'inline' }}>Already asked ({asked.length})</h4>
            </summary>
            <div className="list">
              {asked.map((q) =>
                row(
                  q,
                  <>
                    {ask(q, 'Reopen')}
                    <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'reveal_question', questionId: q.id, revealed: !q.revealed }))}>
                      {q.revealed ? 'Hide answers' : 'Show answers to all'}
                    </button>
                  </>,
                ),
              )}
            </div>
          </details>
        )}
        {aside.length > 0 && (
          <details>
            <summary style={{ cursor: 'pointer' }}>
              <h4 style={{ display: 'inline' }}>Skipped ({aside.length})</h4>
            </summary>
            <div className="list">
              {aside.map((q) =>
                row(
                  q,
                  <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'dismiss_question', questionId: q.id, dismissed: false }))}>
                    Restore
                  </button>,
                ),
              )}
            </div>
          </details>
        )}
        <ManualTemplates view={view} send={send} stageId={stageId} />
      </div>
      {custom && <CustomQuestion view={view} send={send} onClose={() => setCustom(false)} />}
    </section>
  );
}

/** Templates set to "only when I add it by hand": offer them against a chosen item. */
function ManualTemplates({ view, send, stageId }: { view: WorkshopView; send: Send; stageId: string }) {
  const { run, busy } = useAction();
  const templates = view.config.templates.filter((t) => t.generate === 'manual' && t.stageId === stageId && t.subject.type === 'node');
  const [templateId, setTemplateId] = useState('');
  const [nodeId, setNodeId] = useState('');
  if (templates.length === 0) return null;
  const t = templates.find((x) => x.id === templateId) ?? templates[0]!;
  const kinds = t.subject.type === 'node' ? t.subject.kinds : [];
  const nodes = Object.values(view.nodes).filter((n) => n.status === 'active' && kinds.includes(n.kind) && (n.kind !== 'goal' || n.id === view.goal.nodeId));
  return (
    <details>
      <summary style={{ cursor: 'pointer' }}>
        <h4 style={{ display: 'inline' }}>Optional questions for this stage</h4>
      </summary>
      <div className="stack-sm" style={{ marginTop: 8 }}>
        <div className="grid-2">
          <select className="select" value={t.id} aria-label="Question" onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
          <select className="select" value={nodeId} aria-label="About which item" onChange={(e) => setNodeId(e.target.value)}>
            <option value="">About which item…</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button className="btn btn-sm" disabled={busy || !nodeId} onClick={() => void run(() => send({ type: 'add_template_question', templateId: t.id, subject: { type: 'node', nodeId } }), 'Added to “Ready to ask”')}>
            Add this question
          </button>
        </div>
      </div>
    </details>
  );
}

function CustomQuestion({ view, send, onClose }: { view: WorkshopView; send: Send; onClose: () => void }) {
  const { run, busy } = useAction();
  const [prompt, setPrompt] = useState('');
  const [help, setHelp] = useState('');
  const [type, setType] = useState<'text' | 'choice' | 'probability'>('text');
  const [options, setOptions] = useState('Yes\nNo');
  const lines = options.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <Modal
      title="Write your own question"
      onClose={onClose}
      footer={
        <button
          className="btn btn-primary"
          disabled={busy || !prompt.trim() || (type === 'choice' && lines.length < 2)}
          onClick={() =>
            void run(async () => {
              const answer = type === 'text' ? { type } : type === 'probability' ? { type, allowRange: true } : { type, options: lines.slice(0, 8).map((label, i) => ({ value: `option-${i + 1}`, label })) };
              await send({ type: 'add_custom_question', prompt: prompt.trim(), help: help.trim() || undefined, answer, stageId: view.stageId });
              onClose();
            }, 'Added to “Ready to ask”')
          }
        >
          Add question
        </button>
      }
    >
      <div className="stack">
        <label className="field">
          <span>Question</span>
          <textarea className="textarea" value={prompt} maxLength={400} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <label className="field">
          <span>Help text (optional)</span>
          <input className="input" value={help} maxLength={600} onChange={(e) => setHelp(e.target.value)} />
        </label>
        <div className="field">
          <span>Kind of answer</span>
          <div className="seg">
            {(
              [
                ['text', 'Free text'],
                ['choice', 'Pick one'],
                ['probability', 'A chance (0–100%)'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={type === id} onClick={() => setType(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {type === 'choice' && (
          <label className="field">
            <span>Options, one per line</span>
            <textarea className="textarea" value={options} onChange={(e) => setOptions(e.target.value)} />
          </label>
        )}
        <p className="tiny muted">“Not sure” is always offered. The question is added to the current stage.</p>
      </div>
    </Modal>
  );
}
