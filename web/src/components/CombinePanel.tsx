/**
 * Bringing maps together. Always a preview first; saving makes a separate,
 * versioned combined model and never touches anyone's own map.
 */
import { useMemo, useState } from 'react';
import { getAggregation, listAggregations } from '@shared/aggregate/registry';
import { describeLoop } from '@shared/cycles';
import { pct, points } from '@shared/model';
import { previewSynthesis, type ArrowReview } from '@shared/synthesis';
import type { Synthesis, WorkshopView } from '@shared/types';
import { Empty, useAction } from '../lib/ui';
import { MethodNotes, SettingsForm } from './SettingsForm';

type Send = (command: Record<string, unknown>) => Promise<void>;

export function CombinePanel({ view, send, onOpenModel, onSelectItem }: { view: WorkshopView; send: Send; onOpenModel: (key: string) => void; onSelectItem: (id: string) => void }) {
  const me = view.role.type === 'participant' ? view.role.id : null;
  const people = Object.values(view.participants).filter((p) => !me || p.id === me || view.settings.shareModels);
  const saved = Object.values(view.syntheses).sort((a, b) => b.at.localeCompare(a.at));
  const [editing, setEditing] = useState<Synthesis | 'new' | null>(null);

  return (
    <div className="panel-inner">
      <header className="stack-sm">
        <h1>Combine maps</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          Put two or more people’s maps side by side, see exactly where they differ, and — if you want — save a combined map. A combined map is its own thing: everyone’s own map stays as it is, each save is a new version, and you can
          put it away at any time. Nothing is merged or averaged unless you choose it here.
        </p>
      </header>

      {me && !view.settings.shareModels && <div className="banner small">You can prepare a combined map from your own map now. Combining with other people’s maps becomes possible once the organizer shares models.</div>}

      {editing ? (
        <Builder key={editing === 'new' ? 'new' : editing.id + editing.version} view={view} send={send} people={people} existing={editing === 'new' ? null : editing} onDone={() => setEditing(null)} onSelectItem={onSelectItem} />
      ) : (
        <>
          <div>
            <button className="btn btn-primary" disabled={people.length === 0} onClick={() => setEditing('new')}>
              Start a combined map
            </button>
          </div>
          <section className="card">
            <div className="card-head">
              <h2>Saved combined maps</h2>
            </div>
            <div className="card-body">
              {saved.length === 0 ? (
                <Empty title="None yet">Combined maps you save appear here.</Empty>
              ) : (
                <div className="list">
                  {saved.map((s) => (
                    <SavedRow key={s.id} view={view} send={send} synthesis={s} onEdit={() => setEditing(s)} onOpen={() => onOpenModel(`syn:${s.id}`)} />
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SavedRow({ view, send, synthesis: s, onEdit, onOpen }: { view: WorkshopView; send: Send; synthesis: Synthesis; onEdit: () => void; onOpen: () => void }) {
  const { busy, run } = useAction();
  const mine = view.role.type === 'facilitator' || (s.createdBy.type === 'participant' && s.createdBy.id === view.role.id);
  const names = s.contributors.map((id) => view.participants[id]?.name ?? 'someone').join(', ');
  return (
    <div className="list-item stack-sm">
      <div className="row-wrap">
        <strong>{s.name}</strong>
        <span className="chip">version {s.version}</span>
        {s.archived && <span className="chip chip-warn">put away</span>}
        <span className="right row-wrap">
          <button className="btn btn-sm" onClick={onOpen}>
            Show on the map
          </button>
          {mine && (
            <>
              <button className="btn btn-sm" onClick={onEdit}>
                Review and change
              </button>
              <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => send({ type: 'set_synthesis_archived', synthesisId: s.id, archived: !s.archived }))}>
                {s.archived ? 'Bring back' : 'Put away'}
              </button>
            </>
          )}
        </span>
      </div>
      <div className="small muted">
        From: {names} · Estimates: {getAggregation(s.aggregation.methodId)?.name ?? s.aggregation.methodId} · saved {new Date(s.at).toLocaleString()}
      </div>
      {mine && s.previous.length > 0 && (
        <details>
          <summary className="small muted" style={{ cursor: 'pointer' }}>
            Earlier versions ({s.previous.length})
          </summary>
          <div className="stack-sm" style={{ marginTop: 6 }}>
            {[...s.previous].reverse().map((v) => (
              <div key={v.version} className="row small">
                <span className="grow muted">
                  Version {v.version} · {new Date(v.at).toLocaleString()} · {v.contributors.length} {v.contributors.length === 1 ? 'person' : 'people'}
                </span>
                <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'revert_synthesis', synthesisId: s.id, version: v.version }), `Back to version ${v.version}`)}>
                  Go back to this
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Who({ view, ids }: { view: WorkshopView; ids: string[] }) {
  if (ids.length === 0) return <span className="muted">—</span>;
  return <span>{ids.map((id) => view.participants[id]?.name ?? '?').join(', ')}</span>;
}

function Builder({ view, send, people, existing, onDone, onSelectItem }: { view: WorkshopView; send: Send; people: WorkshopView['participants'][string][]; existing: Synthesis | null; onDone: () => void; onSelectItem: (id: string) => void }) {
  const { busy, run } = useAction();
  const [name, setName] = useState(existing?.name ?? 'Combined map');
  const [contributors, setContributors] = useState<string[]>(existing?.contributors.filter((id) => people.some((p) => p.id === id)) ?? people.slice(0, 2).map((p) => p.id));
  const [decisions, setDecisions] = useState<Record<string, 'include' | 'exclude'>>(existing?.decisions ?? {});
  const [methodId, setMethodId] = useState(existing?.aggregation.methodId ?? view.config.aggregation.methodId);
  const [settingsBy, setSettingsBy] = useState<Record<string, Record<string, unknown>>>(() => ({
    [existing?.aggregation.methodId ?? view.config.aggregation.methodId]: (existing?.aggregation.settings ?? view.config.aggregation.settings) as Record<string, unknown>,
  }));
  const method = getAggregation(methodId);
  const settings = { ...(method?.defaultSettings as object), ...(settingsBy[methodId] ?? {}) } as Record<string, unknown>;
  const spec = useMemo(() => ({ contributors, decisions, aggregation: { methodId, settings } }), [contributors, decisions, methodId, JSON.stringify(settings)]); // eslint-disable-line react-hooks/exhaustive-deps
  const preview = useMemo(() => previewSynthesis(view, spec), [view, spec]);
  const label = (id: string) => view.nodes[id]?.label ?? '(removed)';
  const disputed = preview.arrows.filter((a) => !a.agreed);
  const agreed = preview.arrows.filter((a) => a.agreed);
  const undecided = disputed.filter((a) => a.decision === 'undecided').length;
  const setDecision = (a: ArrowReview, value: string) =>
    setDecisions((d) => {
      const next = { ...d };
      if (value === 'undecided' || (a.agreed && value === 'include')) delete next[a.linkId];
      else next[a.linkId] = value as 'include' | 'exclude';
      return next;
    });

  const arrowRow = (a: ArrowReview) => (
    <tr key={a.linkId}>
      <td>
        <button className="btn btn-sm btn-ghost" style={{ textAlign: 'left', height: 'auto', padding: '2px 4px' }} onClick={() => onSelectItem(a.linkId)}>
          {label(a.from)} → {label(a.to)}
        </button>
        {a.relation === 'requirement' && <span className="chip chip-warn">required</span>}
        {a.helps.length > 0 && a.harms.length > 0 && <div className="tiny" style={{ color: 'var(--warn)' }}>They disagree on direction: more likely vs less likely.</div>}
      </td>
      <td>
        <Who view={view} ids={a.holds} />
        {a.conditional.length > 0 && (
          <div className="small muted">
            only under some conditions: <Who view={view} ids={a.conditional} />
          </div>
        )}
      </td>
      <td>
        <Who view={view} ids={a.rejects} />
      </td>
      <td>
        <Who view={view} ids={[...a.unsure, ...a.unreviewed]} />
        {a.unreviewed.length > 0 && <div className="tiny muted">{a.unsure.length ? 'some ' : ''}have not looked at it</div>}
      </td>
      <td>
        <select className="select" style={{ minWidth: 150 }} value={a.decision} aria-label={`Decision for ${label(a.from)} to ${label(a.to)}`} onChange={(e) => setDecision(a, e.target.value)}>
          {!a.agreed && <option value="undecided">Undecided (left out)</option>}
          <option value="include">Include</option>
          <option value="exclude">Leave out</option>
        </select>
      </td>
    </tr>
  );

  return (
    <>
      <section className="card card-pad stack">
        <h2>{existing ? `Reviewing “${existing.name}” (version ${existing.version})` : 'New combined map'}</h2>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="field">
            <span>Whose maps to bring together</span>
            <div className="row-wrap">
              {people.map((p) => (
                <label key={p.id} className="check" style={{ alignItems: 'center' }}>
                  <input type="checkbox" checked={contributors.includes(p.id)} onChange={(e) => setContributors((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))} />
                  <span>{p.name}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </section>

      {contributors.length === 0 ? (
        <section className="card">
          <Empty title="Choose at least one person" />
        </section>
      ) : (
        <>
          {preview.unionLoop && (
            <div className="banner banner-warn">
              <strong>Simply putting everyone’s arrows together would make a loop:</strong> {describeLoop(preview.unionLoop, label)}. Each person’s own map is loop-free, but together they are not, so the arrows below need a decision.
            </div>
          )}
          {preview.includedLoop && (
            <div className="banner banner-warn">
              <strong>The arrows currently included make a loop:</strong> {describeLoop(preview.includedLoop, label)}. Leave one of them out before saving.
            </div>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Where the maps differ</h2>
              <span className="chip right">{disputed.length} arrows</span>
              {undecided > 0 && <span className="chip chip-warn">{undecided} undecided</span>}
            </div>
            <div className="card-body">
              {disputed.length === 0 ? (
                <p className="muted small">{contributors.length === 1 ? 'With one person there is nothing to reconcile.' : 'Everyone holds exactly the same arrows.'}</p>
              ) : (
                <div className="table-scroll">
                  <table className="claims-table">
                    <thead>
                      <tr>
                        <th>Arrow</th>
                        <th>Includes it</th>
                        <th>Rejects it</th>
                        <th>Unsure / not reviewed</th>
                        <th>In the combined map?</th>
                      </tr>
                    </thead>
                    <tbody>{disputed.map(arrowRow)}</tbody>
                  </table>
                </div>
              )}
              <p className="tiny muted" style={{ marginTop: 10 }}>
                “Not reviewed” is not rejection. An arrow left out of the combined map is an approximation, not a claim of no effect. No arrow is included or dropped by majority.
              </p>
            </div>
          </section>

          {agreed.length > 0 && (
            <details className="card">
              <summary className="card-head" style={{ cursor: 'pointer' }}>
                <h2>Arrows everyone holds</h2>
                <span className="chip chip-ok right">{agreed.length} included by default</span>
              </summary>
              <div className="card-body table-scroll">
                <table className="claims-table">
                  <thead>
                    <tr>
                      <th>Arrow</th>
                      <th>Includes it</th>
                      <th>Rejects it</th>
                      <th>Unsure / not reviewed</th>
                      <th>In the combined map?</th>
                    </tr>
                  </thead>
                  <tbody>{agreed.map(arrowRow)}</tbody>
                </table>
              </div>
            </details>
          )}

          {preview.possibleDuplicates.length > 0 && (
            <section className="card card-pad stack-sm">
              <h2>Possibly the same thing said twice</h2>
              <p className="small muted">Similar names. If two items mean the same, the organizer can merge them from the map; if they only sound alike, leave them.</p>
              {preview.possibleDuplicates.slice(0, 12).map((d) => (
                <div key={d.a + d.b} className="row-wrap small">
                  <button className="btn btn-sm" onClick={() => onSelectItem(d.a)}>
                    {label(d.a)}
                  </button>
                  <span className="muted">and</span>
                  <button className="btn btn-sm" onClick={() => onSelectItem(d.b)}>
                    {label(d.b)}
                  </button>
                </div>
              ))}
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>Estimates</h2>
            </div>
            <div className="card-body stack">
              <label className="field" style={{ maxWidth: 480 }}>
                <span>How to pool estimates</span>
                <select className="select" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  {listAggregations().map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {method && (
                <>
                  <p className="small">{method.summary}</p>
                  <MethodNotes assumptions={method.assumptions} limits={method.limits} />
                  <div style={{ maxWidth: 640 }}>
                    <SettingsForm fields={method.settingsFields} value={settings} onChange={(next) => setSettingsBy((s) => ({ ...s, [methodId]: next }))} />
                  </div>
                </>
              )}
              {preview.aggregationProblems.map((p) => (
                <div key={p} className="banner banner-warn small">
                  {p}
                </div>
              ))}
              {preview.estimates.length === 0 ? (
                <p className="small muted">No estimates have been given yet for the arrows in this combined map.</p>
              ) : (
                <div className="table-scroll">
                  <table className="claims-table">
                    <thead>
                      <tr>
                        <th>Arrow</th>
                        <th>Question</th>
                        <th>Each person</th>
                        <th>Pooled</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.estimates.map((e) => {
                        const arrow = preview.arrows.find((a) => a.linkId === e.linkId)!;
                        const show = e.unit === 'difference' ? points : pct;
                        return (
                          <tr key={e.linkId + e.role}>
                            <td>
                              {label(arrow.from)} → {label(arrow.to)}
                            </td>
                            <td>{e.roleLabel}</td>
                            <td>
                              {e.individual.map((c) => (
                                <div key={c.participantId} className="small">
                                  {view.participants[c.participantId]?.name}:{' '}
                                  {c.state === 'unsure' ? <em>not sure</em> : c.state === 'unanswered' ? <em className="muted">no answer</em> : c.low !== undefined && c.high !== undefined ? `${show(c.p!)} (${show(c.low)} to ${show(c.high)})` : show(c.p!)}
                                  {c.state === 'needs-review' && <span className="chip chip-warn" style={{ marginLeft: 6 }}>given before a change</span>}
                                  {e.result.weights?.[c.participantId] !== undefined && <span className="muted"> · counts {Math.round(e.result.weights[c.participantId]! * 100)}%</span>}
                                </div>
                              ))}
                            </td>
                            <td>
                              {e.result.value ? (
                                <strong>
                                  {show(e.result.value.p)}
                                  {e.result.spread && e.result.spread.min !== e.result.spread.max ? ` (individuals from ${show(e.result.spread.min)} to ${show(e.result.spread.max)})` : ''}
                                </strong>
                              ) : (
                                <span className="muted">no pooled number</span>
                              )}
                              <div className="small muted">{e.result.note}</div>
                              {e.result.flagged && <span className="chip chip-warn">ask again against the combined map</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.reviewCount > 0 && (
                <div className="banner banner-warn small">
                  {preview.reviewCount} estimate{preview.reviewCount === 1 ? '' : 's'} should be asked again: the people answering had different things feeding into the target, or answered before a definition or the time horizon changed, so they were
                  not answering the same question.
                </div>
              )}
              <p className="tiny muted">Pooling inputs is not the same as averaging results. Results for a combined map are calculated from these pooled inputs; people’s individual results are never averaged together.</p>
            </div>
          </section>

          <div className="row-wrap">
            <button
              className="btn btn-primary"
              disabled={busy || !name.trim() || !!preview.includedLoop || preview.aggregationProblems.length > 0}
              onClick={() =>
                void run(async () => {
                  await send({ type: 'save_synthesis', synthesisId: existing?.id, name: name.trim(), contributors, decisions, aggregation: { methodId, settings } });
                  onDone();
                }, existing ? 'Saved as a new version' : 'Combined map saved')
              }
            >
              {existing ? 'Save as a new version' : 'Save combined map'}
            </button>
            <button className="btn" onClick={onDone}>
              Cancel
            </button>
            <span className="small muted">Saving does not change anyone’s own map.</span>
          </div>
        </>
      )}
    </>
  );
}
