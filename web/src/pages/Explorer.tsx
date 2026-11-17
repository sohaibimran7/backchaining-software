/**
 * The model explorer — and, in solo mode, the whole workspace. A map of one
 * model at a time, with an inspector, plus tabs for combining maps, results,
 * history and data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { findBottlenecks } from '@shared/calc/graph';
import { getMethod } from '@shared/calc/registry';
import { ROLES } from '@shared/config';
import { latestAnswer, renderQuestion } from '@shared/templates';
import { AnswerInput } from '../components/AnswerInput';
import { canAnswer } from '../components/Inspector';
import type { ParticipantModel } from '@shared/calc/types';
import { buildParticipantModel } from '@shared/model';
import { buildSynthesisModel } from '@shared/synthesis';
import type { WorkshopView } from '@shared/types';
import { CombinePanel } from '../components/CombinePanel';
import { Inspector } from '../components/Inspector';
import { MapView } from '../components/MapView';
import { ResultsPanel } from '../components/ResultsPanel';
import { absorbKeysFromHash, api, downloadJson, getKey, saveKey, slug, useWorkshop } from '../lib/api';
import { ConnectionDot, Empty, FullPageMessage, Modal, Spinner, themeStyle, useAction, useToast } from '../lib/ui';

type Tab = 'map' | 'combine' | 'results' | 'history' | 'data';
type DrawAs = 'helps' | 'harms' | 'required';

export function Explorer() {
  const { workshopId = '' } = useParams();
  const [params] = useSearchParams();
  const [key] = useState(() => {
    absorbKeysFromHash(workshopId);
    const f = getKey(workshopId, 'facilitator');
    const p = getKey(workshopId, 'participant');
    return params.get('as') === 'me' ? (p ?? f) : (f ?? p);
  });
  const { view, status, send } = useWorkshop(workshopId, key);

  if (status === 'missing-key' || status === 'denied') {
    return (
      <FullPageMessage title="This device cannot open that workshop">
        <p className="muted">Open it from the device you used before, use your personal link, or join with the workshop code.</p>
        <Link className="btn btn-primary" to="/">
          Go to the start
        </Link>
      </FullPageMessage>
    );
  }
  if (!view) return <Spinner label="Opening…" />;
  return <Loaded view={view} status={status} send={send} workshopId={workshopId} accessKey={key!} />;
}

function Loaded({ view, status, send, workshopId, accessKey }: { view: WorkshopView; status: ReturnType<typeof useWorkshop>['status']; send: ReturnType<typeof useWorkshop>['send']; workshopId: string; accessKey: string }) {
  const toast = useToast();
  const isOrganizer = view.role.type === 'facilitator';
  const me = view.role.type === 'participant' ? view.role.id : null;
  const solo = view.mode === 'solo';
  const people = Object.values(view.participants).filter((p) => isOrganizer || p.id === me || view.settings.shareModels);
  const syntheses = Object.values(view.syntheses).filter((s) => !s.archived);

  const [tab, setTab] = useState<Tab>('map');
  const [modelKey, setModelKey] = useState<string>(() => me ?? (solo ? 'me' : (people[0]?.id ?? 'all')));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tapConnect, setTapConnect] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const [drawAs, setDrawAs] = useState<DrawAs>('helps');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusSteps, setFocusSteps] = useState(1);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showUnreviewed, setShowUnreviewed] = useState(true);
  const [showRejected, setShowRejected] = useState(false);
  const [tidy, setTidy] = useState(0);
  const [legend, setLegend] = useState(false);
  const [sideOpen, setSideOpen] = useState(() => window.innerWidth > 900);

  // If the chosen model disappears (e.g. a combined map is put away), fall back sensibly.
  useEffect(() => {
    const ok = modelKey === 'all' || !!view.participants[modelKey] || (modelKey.startsWith('syn:') && !!view.syntheses[modelKey.slice(4)]);
    if (!ok) setModelKey(me ?? people[0]?.id ?? 'all');
  }, [modelKey, view.participants, view.syntheses, me, people]);

  const model: ParticipantModel | null = useMemo(() => {
    if (modelKey === 'all') return null;
    if (modelKey.startsWith('syn:')) return view.syntheses[modelKey.slice(4)] ? buildSynthesisModel(view, modelKey.slice(4)) : null;
    return view.participants[modelKey] ? buildParticipantModel(view, modelKey) : null;
  }, [view, modelKey]);

  const actingId = model && !modelKey.startsWith('syn:') && (isOrganizer || modelKey === me) ? modelKey : null;
  const canDraw = !!actingId && (isOrganizer || view.settings.layers.connections.open);

  const badges = useMemo(() => {
    const result: Record<string, string[]> = {};
    if (!model) return result;
    for (const b of findBottlenecks(model)) {
      if (b.kind === 'required-without-action') (result[b.nodeId] ??= []).push('required, no action');
      if (b.kind === 'chokepoint') (result[b.nodeId] ??= []).push('every route passes here');
    }
    return result;
  }, [model]);

  // One "?" per arrow: the questions the workshop's calculation method still needs answered for it.
  const needed = useMemo(() => {
    const byLink: Record<string, string[]> = {};
    if (!model || !actingId) return byLink;
    const roles = new Set((getMethod(view.config.calculation.methodId)?.consumes ?? []).filter((r) => r !== ROLES.linkStance));
    if (roles.size === 0) return byLink;
    const held = new Set(model.links.filter((l) => l.stance === 'yes').map((l) => l.id));
    for (const q of Object.values(view.questions)) {
      if (q.subject.type !== 'link' || !held.has(q.subject.linkId) || q.status === 'superseded' || q.status === 'dismissed') continue;
      const role = renderQuestion(view, q).role;
      if (role && roles.has(role)) (byLink[q.subject.linkId] ??= []).push(q.id);
    }
    return byLink;
  }, [view, model, actingId]);
  const missing = useMemo(() => {
    const result: Record<string, string> = {};
    for (const [lid, qids] of Object.entries(needed)) {
      if (!actingId || qids.every((qid) => latestAnswer(view, qid, actingId))) continue;
      const l = view.links[lid]!;
      result[lid] = `Missing information for the arrow from “${view.nodes[l.from]?.label}” to “${view.nodes[l.to]?.label}”. Tap to answer.`;
    }
    return result;
  }, [needed, view, actingId]);
  const [asking, setAsking] = useState<string | null>(null);
  const missingCount = Object.keys(missing).length;

  const connect = useCallback(
    (from: string, to: string) => {
      if (!actingId) return;
      const who = isOrganizer ? { participantId: actingId } : {};
      const command = { type: 'hold_link', from, to, hold: true, relation: drawAs === 'required' ? 'requirement' : 'influence', as: drawAs === 'harms' ? 'harms' : 'helps', ...who };
      // The server checks the whole map for loops; if it refuses, nothing has changed and the reason is shown.
      send(command).then(
        () => setSelectedId(`l:${drawAs === 'required' ? 'r' : 'i'}:${from}>${to}`),
        (err: Error) => toast(err.message, 'error'),
      );
    },
    [actingId, isOrganizer, drawAs, send, toast],
  );

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setSideOpen(true);
    else if (window.innerWidth <= 900) setSideOpen(false);
  }, []);
  const jumpTo = useCallback((id: string) => {
    setTab('map');
    setSelectedId(id);
    setSideOpen(true);
  }, []);
  const toggleCollapsed = useCallback((id: string) => setCollapsed((c) => new Set(c.has(id) ? [...c].filter((x) => x !== id) : [...c, id])), []);

  const back = solo ? '/' : isOrganizer ? `/f/${workshopId}` : `/p/${workshopId}`;
  const empty = Object.values(view.nodes).filter((n) => n.status === 'active').length === 0;
  const modelName = modelKey === 'all' ? 'Everything proposed' : modelKey.startsWith('syn:') ? `Combined: ${view.syntheses[modelKey.slice(4)]?.name}` : modelKey === me || solo ? 'My map' : `${view.participants[modelKey]?.name}’s map`;

  return (
    <div className="explorer" style={themeStyle(view.config)}>
      <header className="app-bar">
        <Link className="btn btn-sm btn-ghost" to={back} aria-label="Back">
          ←
        </Link>
        <div className="grow" style={{ minWidth: 120 }}>
          <div className="truncate" style={{ fontWeight: 700 }}>
            {view.title}
          </div>
          <div className="tiny muted truncate">
            {view.isExample ? 'Fictional example · ' : ''}
            {view.goal.nodeId ? `Goal: ${view.nodes[view.goal.nodeId]?.label}${view.goal.horizon ? ` by ${view.goal.horizon}` : ''}` : 'No goal chosen yet'}
          </div>
        </div>
        <div className="tabs" role="tablist">
          {(
            [
              ['map', 'Map'],
              ['combine', 'Combine'],
              ['results', 'Results'],
              ['history', 'History'],
              ['data', 'Save'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <ConnectionDot status={status} />
      </header>

      {tab === 'map' && (
        <div className={`explorer-body ${sideOpen ? '' : 'no-side'}`}>
          <div className="map-wrap">
            <div className="map-tools no-print">
              <div className="card">
                {!solo && (
                  <select className="select" style={{ minHeight: 34, width: 'auto', maxWidth: 220 }} value={modelKey} aria-label="Whose map" onChange={(e) => (setModelKey(e.target.value), setSelectedId(null))}>
                    <optgroup label="One person’s map">
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id === me ? 'My map' : p.name}
                        </option>
                      ))}
                    </optgroup>
                    {syntheses.length > 0 && (
                      <optgroup label="Combined maps">
                        {syntheses.map((s) => (
                          <option key={s.id} value={`syn:${s.id}`}>
                            {s.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Catalogue">
                      <option value="all">Everything proposed</option>
                    </optgroup>
                  </select>
                )}
                <input className="input" style={{ minHeight: 34, width: 170 }} type="search" placeholder="Find an item…" aria-label="Find an item" value={search} onChange={(e) => setSearch(e.target.value)} />
                <button className="btn btn-sm" onClick={() => setTidy((t) => t + 1)} title="Arrange the map automatically">
                  Tidy
                </button>
                <button className="btn btn-sm" aria-pressed={legend} onClick={() => setLegend((l) => !l)}>
                  Key
                </button>
                {!sideOpen && (
                  <button className="btn btn-sm" onClick={() => setSideOpen(true)}>
                    Details
                  </button>
                )}
              </div>
              {canDraw && (
                <div className="card">
                  <label className="switch">
                    <input type="checkbox" checked={tapConnect} onChange={(e) => setTapConnect(e.target.checked)} />
                    Tap to connect
                  </label>
                  <select className="select" style={{ minHeight: 34, width: 'auto' }} value={drawAs} aria-label="New arrows mean" onChange={(e) => setDrawAs(e.target.value as DrawAs)}>
                    <option value="helps">New arrows: makes it more likely</option>
                    <option value="harms">New arrows: makes it less likely</option>
                    <option value="required">New arrows: is required for</option>
                  </select>
                </div>
              )}
              {missingCount > 0 && (
                <div className="card">
                  <button className="btn btn-sm" onClick={() => setAsking(Object.keys(missing)[0]!)}>
                    <span className="ask-badge" aria-hidden>
                      ?
                    </span>
                    {missingCount} arrow{missingCount === 1 ? ' needs' : 's need'} an answer
                  </button>
                </div>
              )}
              {(focusId || collapsed.size > 0) && (
                <div className="card">
                  {focusId && (
                    <>
                      <span className="small">Near “{view.nodes[focusId]?.label}”</span>
                      <select className="select" style={{ minHeight: 34, width: 'auto' }} value={focusSteps} aria-label="How many steps away" onChange={(e) => setFocusSteps(Number(e.target.value))}>
                        <option value={1}>1 step</option>
                        <option value={2}>2 steps</option>
                        <option value={3}>3 steps</option>
                      </select>
                      <button className="btn btn-sm" onClick={() => setFocusId(null)}>
                        Whole map
                      </button>
                    </>
                  )}
                  {collapsed.size > 0 && (
                    <button className="btn btn-sm" onClick={() => setCollapsed(new Set())}>
                      Unfold all ({collapsed.size})
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="map-area">
            {empty ? (
              <div className="page-center">
                <div className="card">
                  <Empty title="The map is empty" icon="◇">
                    {isOrganizer ? 'Add a goal in the panel on the right to begin.' : 'Items appear here as the group proposes them.'}
                  </Empty>
                </div>
              </div>
            ) : (
              <MapView
                view={view}
                model={model}
                selectedId={selectedId}
                onSelect={select}
                canConnect={canDraw}
                tapConnect={tapConnect}
                onConnect={connect}
                search={search}
                focusId={focusId}
                focusSteps={focusSteps}
                collapsed={collapsed}
                showUnreviewed={showUnreviewed}
                showRejected={showRejected}
                badges={badges}
                missing={missing}
                onAsk={setAsking}
                tidySignal={tidy}
                canSaveLayout={isOrganizer && !solo}
                onSaveLayout={(positions) => void send({ type: 'move_nodes', positions }).then(() => toast('Arrangement kept for everyone'))}
              />
            )}

            {legend && (
              <div className="legend card no-print">
                <strong>{modelName}</strong>
                <LegendLine color="#55556a" text="In this map: makes it more likely" />
                <LegendLine color="#c2410c" text="In this map: makes it less likely" />
                <LegendLine color="#b7791f" text="Required for it" width={2.5} />
                <LegendLine color="#7c3aed" dash="8 4" text="Only under some conditions" />
                <LegendLine color="#8a8a99" dash="2 5" text="Not sure" />
                <LegendLine color="#b0b0bf" dash="4 5" text="Proposed by someone, not reviewed" />
                <label className="check tiny">
                  <input type="checkbox" checked={showUnreviewed} onChange={(e) => setShowUnreviewed(e.target.checked)} />
                  <span>Show arrows not reviewed</span>
                </label>
                <label className="check tiny">
                  <input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} />
                  <span>Show rejected arrows</span>
                </label>
                <span className="tiny muted">No arrow between two items means it is not in this map — not that there is no effect.</span>
              </div>
            )}
            </div>
          </div>
          {sideOpen && (
            <aside className="side">
              <div className="side-close no-print">
                <button className="btn btn-sm btn-ghost" onClick={() => setSideOpen(false)}>
                  Hide details
                </button>
              </div>
              <Inspector
                view={view}
                model={model}
                actingId={actingId}
                selectedId={selectedId}
                onSelect={select}
                send={send}
                canDraw={canDraw}
                focusId={focusId}
                setFocus={setFocusId}
                collapsed={collapsed}
                toggleCollapsed={toggleCollapsed}
                badges={badges}
              />
            </aside>
          )}
        </div>
      )}

      {asking && view.links[asking] && actingId && (
        <Modal title={`${view.nodes[view.links[asking]!.from]?.label} → ${view.nodes[view.links[asking]!.to]?.label}`} onClose={() => setAsking(null)}>
          <div className="stack-lg">
            {(needed[asking] ?? []).map((qid) => {
              const q = view.questions[qid]!;
              const r = renderQuestion(view, q);
              return (
                <div key={qid} className="stack">
                  <div className="stack-sm">
                    <h3 style={{ fontSize: '1.15rem' }}>{r.prompt}</h3>
                    {r.help && <p className="small muted">{r.help}</p>}
                  </div>
                  {canAnswer(view, q) ? (
                    <AnswerInput
                      view={view}
                      question={q}
                      participantId={actingId}
                      send={send}
                      via="explorer"
                      onBehalf={isOrganizer}
                      compact
                      onSaved={() => {
                        // Move straight on to the next arrow that still needs an answer, if any.
                        const rest = Object.keys(missing).filter((id) => id !== asking);
                        setAsking((needed[asking] ?? []).length > 1 ? asking : (rest[0] ?? null));
                      }}
                    />
                  ) : (
                    <p className="small muted">Estimates are not open at the moment. The organizer can open them, or ask this question live.</p>
                  )}
                </div>
              );
            })}
            <p className="tiny muted">Asked because the workshop’s calculation method uses it. “{view.config.labels.unsure}” is a valid answer and is never treated as zero.</p>
          </div>
        </Modal>
      )}

      {tab === 'combine' && (
        <div className="panel-scroll">
          <CombinePanel view={view} send={send} onOpenModel={(k) => (setModelKey(k), setTab('map'), setSelectedId(null))} onSelectItem={jumpTo} />
        </div>
      )}
      {tab === 'results' && (
        <div className="panel-scroll">
          <ResultsPanel view={view} send={send} onSelectItem={jumpTo} />
        </div>
      )}
      {tab === 'history' && (
        <div className="panel-scroll">
          <HistoryPanel view={view} workshopId={workshopId} accessKey={accessKey} />
        </div>
      )}
      {tab === 'data' && (
        <div className="panel-scroll">
          <DataPanel view={view} workshopId={workshopId} accessKey={accessKey} model={model} modelName={modelName} modelKey={modelKey} />
        </div>
      )}
    </div>
  );
}

function LegendLine({ color, dash, text, width = 2 }: { color: string; dash?: string; text: string; width?: number }) {
  return (
    <span className="legend-line">
      <svg width="34" height="8" aria-hidden>
        <line x1="1" y1="4" x2="33" y2="4" stroke={color} strokeWidth={width} strokeDasharray={dash} />
      </svg>
      {text}
    </span>
  );
}

function HistoryPanel({ view, workshopId, accessKey }: { view: WorkshopView; workshopId: string; accessKey: string }) {
  const [filter, setFilter] = useState('');
  const { busy, run } = useAction();
  const isOrganizer = view.role.type === 'facilitator';
  const entries = [...view.history].reverse().filter((h) => !filter.trim() || h.summary.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="panel-inner">
      <header className="stack-sm">
        <h1>History</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          Every change, in order. Nothing is overwritten: earlier answers, merged items and set-aside suggestions all stay in the record.
          {isOrganizer ? ' You can open a separate copy of the workshop as it was at any point; the original is left alone.' : ''}
        </p>
      </header>
      <input className="input" style={{ maxWidth: 360 }} type="search" placeholder="Filter…" aria-label="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <section className="card">
        <div className="card-body list">
          {entries.length === 0 && <Empty title="Nothing matches" />}
          {entries.slice(0, 400).map((h) => (
            <div key={h.seq} className="row list-item" style={{ padding: '9px 0' }}>
              <span className="chip">#{h.seq}</span>
              <div className="grow">
                <div className="small">{h.summary}</div>
                <div className="tiny muted">{new Date(h.at).toLocaleString()}</div>
              </div>
              {isOrganizer && (
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const copy = await api<{ workshopId: string; facilitatorKey: string }>(`/api/workshops/${workshopId}/fork`, { body: { seq: h.seq }, key: accessKey });
                      saveKey({ workshopId: copy.workshopId, kind: 'facilitator', key: copy.facilitatorKey, title: `${view.title} (copy at revision ${h.seq})` });
                      window.open(`/x/${copy.workshopId}`, '_blank', 'noopener');
                    }, 'Copy created')
                  }
                >
                  Open a copy as of here
                </button>
              )}
            </div>
          ))}
          {entries.length > 400 && <p className="small muted">Showing the latest 400 of {entries.length}. The full record is in the exported file.</p>}
        </div>
      </section>
    </div>
  );
}

function DataPanel({ view, workshopId, accessKey, model, modelName, modelKey }: { view: WorkshopView; workshopId: string; accessKey: string; model: ParticipantModel | null; modelName: string; modelKey: string }) {
  const { busy, run } = useAction();
  const isOrganizer = view.role.type === 'facilitator';
  const exportModel = () => {
    if (!model) return;
    const label = (id: string) => view.nodes[id]?.label ?? id;
    const answers =
      view.participants[modelKey] !== undefined
        ? Object.fromEntries(
            Object.entries(view.answers)
              .filter(([, by]) => by[modelKey])
              .map(([qid, by]) => [qid, by[modelKey]]),
          )
        : undefined;
    downloadJson(`${slug(view.title)}-${slug(modelName)}.json`, {
      format: 'backchain-model',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      workshop: view.title,
      model: modelName,
      goal: view.goal.nodeId ? { label: label(view.goal.nodeId), successDefinition: view.goal.successDefinition, horizon: view.goal.horizon } : null,
      items: model.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, definition: view.nodes[n.id]?.definition ?? '' })),
      arrows: model.links.map((l) => ({ from: label(l.from), to: label(l.to), fromId: l.from, toId: l.to, relation: l.relation, view: l.stance, direction: l.direction, mechanism: l.mechanism, beliefs: l.beliefs })),
      everyAnswerWithHistory: answers,
    });
  };
  return (
    <div className="panel-inner">
      <header className="stack-sm">
        <h1>Save</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          The workshop is stored on the server and can be reopened from this device at any time. You can also keep your own copy as a file.
        </p>
      </header>
      <div className="cols">
        <section className="card card-pad stack">
          <h2>{modelName}</h2>
          <p className="small muted">The items, the arrows as this map has them, the estimates behind them and the reasoning, as a file you can keep.</p>
          <div className="row-wrap">
            <button className="btn btn-primary" disabled={!model} onClick={exportModel}>
              Download this map
            </button>
            <button className="btn" onClick={() => window.print()}>
              Print
            </button>
          </div>
          {!model && <p className="tiny muted">Choose a person’s map or a combined map on the Map tab first.</p>}
        </section>
        {isOrganizer && (
          <section className="card card-pad stack">
            <h2>The whole workshop</h2>
            <p className="small muted">
              Everything, including the full history, as one file. Import it from the start page to reopen it on this or another server. It contains every participant’s answers, so treat it as private. It does not contain anyone’s
              access links.
            </p>
            <div>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    downloadJson(`${slug(view.title)}-workshop.json`, await api(`/api/workshops/${workshopId}/export`, { key: accessKey }));
                  })
                }
              >
                Download the workshop
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
