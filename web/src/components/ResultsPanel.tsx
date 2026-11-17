/** Calculation results: choose a method, see its assumptions, run it, and read each model's result separately. */
import { useState } from 'react';
import { getMethod, listMethods } from '@shared/calc/registry';
import type { ActionResult, MethodExample, MethodOutput } from '@shared/calc/types';
import type { CalculationRun, WorkshopView } from '@shared/types';
import { Empty, timeAgo, useAction } from '../lib/ui';
import { SettingsForm } from './SettingsForm';

type Send = (command: Record<string, unknown>) => Promise<void>;

const STATUS_WORDS: Record<ActionResult['status'], string> = {
  estimated: 'Estimated',
  incomplete: 'Incomplete',
  withheld: 'No number given',
  'not-connected': 'Not connected',
  described: 'Connected',
};

function points(x: number): string {
  const v = Math.round(x * 1000) / 10;
  return `${v > 0 ? '+' : ''}${v}`;
}

export function ResultsPanel({ view, send, onSelectItem }: { view: WorkshopView; send: Send; onSelectItem: (id: string) => void }) {
  const isOrganizer = view.role.type === 'facilitator';
  const { busy, run } = useAction();
  const [methodId, setMethodId] = useState(view.config.calculation.methodId);
  const [settingsBy, setSettingsBy] = useState<Record<string, Record<string, unknown>>>(() => view.config.calculation.settings as Record<string, Record<string, unknown>>);
  const [acknowledged, setAcknowledged] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const method = getMethod(methodId);
  const settings = { ...(method?.defaultSettings as object), ...(settingsBy[methodId] ?? {}) } as Record<string, unknown>;
  const runs = [...view.runs].reverse();
  const shown = runs.find((r) => r.id === runId) ?? runs[0];
  const generating = view.config.calculation.methodId;

  return (
    <div className="panel-inner">
      <header className="stack-sm">
        <h1>Results</h1>
        <p className="muted" style={{ maxWidth: '70ch' }}>
          A calculation method reads one model at a time and reports what follows from it under the method’s own assumptions. Methods can be swapped; none of them is “the” answer. Each person’s model gets its own result.
        </p>
      </header>

      {isOrganizer && (
        <section className="card">
          <div className="card-head">
            <h2>Method</h2>
          </div>
          <div className="card-body stack">
            <label className="field" style={{ maxWidth: 680 }}>
              <span>Calculation method</span>
              <select
                className="select"
                value={methodId}
                onChange={(e) => {
                  setMethodId(e.target.value);
                  setAcknowledged(false);
                }}
              >
                {listMethods().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            {method && (
              <>
                <p className="small">
                  {method.summary} <span className="muted">Version {method.version}.</span>
                </p>
                <div className="cols">
                  <div className="stack-sm">
                    <h4>What it needs from people</h4>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {method.requiredInputs.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                    <ExampleDiagram example={method.example} />
                  </div>
                  <div className="stack-sm">
                    <h4>This method assumes</h4>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {method.assumptions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                    <h4 style={{ marginTop: 8 }}>What it cannot do</h4>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {method.limits.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="stack" style={{ maxWidth: 640 }}>
                  <h4>Settings</h4>
                  <SettingsForm fields={method.settingsFields} value={settings} onChange={(next) => setSettingsBy((s) => ({ ...s, [methodId]: next }))} />
                </div>
                {methodId !== generating && method.elicitation.length > 0 && (
                  <div className="banner banner-warn small stack-sm">
                    <span>
                      This method needs answers to questions that are not being asked yet ({method.elicitation.map((t) => `“${t.title}”`).join(', ')}). Make it the workshop’s method to add those questions for every arrow.
                    </span>
                    <div>
                      <button
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => send({ type: 'set_config', config: { ...view.config, calculation: { methodId, settings: { ...view.config.calculation.settings, [methodId]: settings } } } }),
                            'Questions for this method are now available',
                          )
                        }
                      >
                        Use this method for the workshop
                      </button>
                    </div>
                  </div>
                )}
                {method.requiresAcknowledgement && (
                  <label className="check">
                    <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                    <span>I understand these numbers hold only under the assumptions listed, and that the method gives no number where they visibly fail.</span>
                  </label>
                )}
                <div>
                  <button
                    className="btn btn-primary"
                    disabled={busy || (method.requiresAcknowledgement && !acknowledged)}
                    onClick={() =>
                      void run(async () => {
                        await send({ type: 'run_calculation', methodId, settings, acknowledged });
                        setRunId(null);
                      }, 'Calculated')
                    }
                  >
                    Run on every model
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {!shown ? (
        <section className="card">
          <Empty title="No results yet" icon="∑">
            {isOrganizer ? 'Choose a method above and run it.' : 'Results appear here once the organizer runs a calculation.'}
          </Empty>
        </section>
      ) : (
        <>
          <div className="row-wrap">
            <label className="field" style={{ minWidth: 280 }}>
              <span>Showing run</span>
              <select className="select" value={shown.id} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {getMethod(r.methodId)?.name ?? r.methodId} · {timeAgo(r.at)}
                  </option>
                ))}
              </select>
            </label>
            {shown.modelRev !== view.modelRev && <span className="chip chip-warn">The models have changed since this run</span>}
          </div>
          <RunView view={view} run={shown} onSelectItem={onSelectItem} />
        </>
      )}
    </div>
  );
}

function RunView({ view, run, onSelectItem }: { view: WorkshopView; run: CalculationRun; onSelectItem: (id: string) => void }) {
  const method = getMethod(run.methodId);
  const keys = Object.keys(run.outputs);
  const title = (key: string) => {
    if (key.startsWith('syn:')) {
      const s = view.syntheses[key.slice(4)];
      return `Combined: ${s?.name ?? 'a combined map'}${run.synthesisVersions?.[key.slice(4)] ? ` (version ${run.synthesisVersions[key.slice(4)]})` : ''}`;
    }
    return view.participants[key]?.name ?? 'Someone';
  };
  const max = Math.max(0.05, ...keys.flatMap((k) => run.outputs[k]!.actions.flatMap((a) => (a.effect ? [Math.abs(a.effect.low), Math.abs(a.effect.high)] : []))));
  return (
    <>
      <section className="card card-pad stack-sm">
        <div className="row-wrap">
          <h2>{method?.name ?? run.methodId}</h2>
          <span className="chip">method version {run.methodVersion}</span>
          {run.engine && (
            <span className="chip" title="The engine only does the arithmetic. What counts as valid, missing or unsupported is decided by the method.">
              arithmetic by {run.engine.id} {run.engine.version}
              {run.engine.sampling ? ` · ${run.engine.sampling.sampleCount} samples, seed ${run.engine.sampling.seed}` : ' · exact, no sampling'}
            </span>
          )}
          <span className="chip">{new Date(run.at).toLocaleString()}</span>
        </div>
        <details>
          <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
            Assumptions and settings this run used
          </summary>
          <ul className="small" style={{ paddingLeft: 18 }}>
            {run.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <pre className="code" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
            {JSON.stringify(run.settings, null, 2)}
          </pre>
        </details>
      </section>
      {keys.length === 0 && (
        <section className="card">
          <Empty title="Nothing to show">There were no models to calculate.</Empty>
        </section>
      )}
      <div className="cols">
        {keys.map((key) => (
          <OutputCard key={key} view={view} title={title(key)} combined={key.startsWith('syn:')} output={run.outputs[key]!} program={run.programs?.[key]} max={max} onSelectItem={onSelectItem} />
        ))}
      </div>
      {keys.length > 1 && <p className="tiny muted">Results are shown side by side on the same scale. They are not averaged with each other.</p>}
    </>
  );
}

function OutputCard({ view, title, combined, output, program, max, onSelectItem }: { view: WorkshopView; title: string; combined: boolean; output: MethodOutput; program?: NonNullable<CalculationRun['programs']>[string]; max: number; onSelectItem: (id: string) => void }) {
  const label = (id: string) => view.nodes[id]?.label ?? '(removed)';
  const order = { estimated: 0, described: 1, incomplete: 2, withheld: 3, 'not-connected': 4 } as const;
  const actions = [...output.actions].sort((a, b) => order[a.status] - order[b.status] || (b.effect ? (b.effect.low + b.effect.high) / 2 : 0) - (a.effect ? (a.effect.low + a.effect.high) / 2 : 0));
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="grow">{title}</h2>
        {combined && <span className="chip chip-accent">from pooled inputs</span>}
      </div>
      <div className="card-body stack">
        <p className="small">{output.headline}</p>
        {output.ranking && (
          <div className="stack-sm">
            <h4>Ranking{output.ranking.complete ? '' : ' (partial)'}</h4>
            <div className="rank">
              {output.ranking.tiers.map((tier, i) => (
                <div key={i} className="rank-tier">
                  <span className="rank-n">{i + 1}</span>
                  <span>
                    {tier.map(label).join(' · ')}
                    {tier.length > 1 && <span className="muted small"> — cannot be told apart</span>}
                  </span>
                </div>
              ))}
            </div>
            <p className={`small ${output.ranking.complete ? 'muted' : ''}`} style={output.ranking.complete ? undefined : { color: 'var(--warn)' }}>
              {output.ranking.note}
            </p>
          </div>
        )}
        {!output.ranking && output.status !== 'no-numbers' && output.actions.length > 0 && <div className="banner banner-warn small">No ranking is given: the inputs or assumptions this method needs are not in place for any action. See the reasons below.</div>}
        {actions.map((a) => (
          <div key={a.actionId} className="stack-sm">
            <div className="row-wrap">
              <button className="btn btn-sm btn-ghost" style={{ padding: '2px 4px', fontWeight: 650 }} onClick={() => onSelectItem(a.actionId)}>
                {label(a.actionId)}
              </button>
              <span className={`status-pill st-${a.status}`}>{STATUS_WORDS[a.status]}</span>
            </div>
            {a.effect && (
              <>
                <div className="range" role="img" aria-label={`Changes the chance of the goal by ${points(a.effect.low)} to ${points(a.effect.high)} percentage points`}>
                  <span className="range-zero" style={{ left: '50%' }} />
                  <span className="range-bar" style={{ left: `${50 + (a.effect.low / max) * 50}%`, width: `${Math.max(0.8, ((a.effect.high - a.effect.low) / max) * 50)}%` }} />
                </div>
                <div className="small">
                  Changes the chance of the goal by <strong>{a.effect.low === a.effect.high ? points(a.effect.low) : `${points(a.effect.low)} to ${points(a.effect.high)}`}</strong> percentage points, compared with the same expected
                  course of events without it.
                  {a.clearlyAheadOf.length > 0 && <span className="muted"> Clear of: {a.clearlyAheadOf.map(label).join(', ')}.</span>}
                </div>
              </>
            )}
            {a.status !== 'not-connected' && a.routeCount > 0 && (
              <div className="tiny muted">
                {a.routesCapped ? 'More than ' : ''}
                {a.routeCount} route{a.routeCount === 1 ? '' : 's'} to the goal
                {a.requiredNodeIds.length > 0 ? ` · passes something that requires: ${a.requiredNodeIds.map(label).join(', ')}` : ''}
              </div>
            )}
            {a.reasons.length > 0 && (
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {a.reasons.slice(0, 6).map((r) => (
                  <li key={r}>{r}</li>
                ))}
                {a.reasons.length > 6 && <li>…and {a.reasons.length - 6} more</li>}
              </ul>
            )}
          </div>
        ))}
        {output.bottlenecks.length > 0 && (
          <div className="stack-sm">
            <h4>Bottlenecks</h4>
            {output.bottlenecks.map((b) => (
              <button key={b.kind + b.nodeId} className={`diag ${b.kind === 'required-without-action' ? 'diag-warning' : ''}`} style={{ textAlign: 'left', border: 'none', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => onSelectItem(b.nodeId)}>
                {b.message}
              </button>
            ))}
          </div>
        )}
        {program && (
          <details>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
              How this was worked out
            </summary>
            <div className="stack-sm" style={{ marginTop: 8 }}>
              <p className="tiny muted">The inputs read from this model, then the generated formulas exactly as they were evaluated. Names are generated by the app; ranges are carried as low/high pairs, not turned into distributions.</p>
              <table className="claims-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Stands for</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(program.sources)
                    .filter(([, s]) => s.kind !== 'node')
                    .map(([name, s]) => {
                      const l = s.kind === 'link' ? view.links[s.id] : undefined;
                      return (
                        <tr key={name}>
                          <td className="code">{name}</td>
                          <td>
                            <button className="btn btn-sm btn-ghost" style={{ padding: '0 4px', height: 'auto', minHeight: 0, textAlign: 'left' }} onClick={() => onSelectItem(s.id)}>
                              {l ? `${label(l.from)} → ${label(l.to)}` : label(s.id)}
                            </button>
                            <span className="muted small">
                              {' '}
                              {s.kind === 'link' ? `answer: how much it changes the next thing (${s.bound} end)` : s.note}
                              {s.bound && s.kind === 'action' ? ` (${s.bound} end)` : ''}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              <pre className="code" style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 260, overflow: 'auto', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>
                {program.code}
              </pre>
            </div>
          </details>
        )}
        {output.diagnostics.length > 0 && (
          <div className="stack-sm">
            <h4>Notes</h4>
            {output.diagnostics.map((d, i) => (
              <div key={d.code + i} className={`diag diag-${d.severity}`}>
                {d.message}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** The small illustration every method ships with, drawn from its own description. */
export function ExampleDiagram({ example }: { example: MethodExample }) {
  if (example.nodes.length === 0) return null;
  const columns: Record<string, number> = { action: 0, state: 1, goal: 2 };
  const byColumn: Record<number, string[]> = {};
  for (const n of example.nodes) (byColumn[columns[n.kind]!] ??= []).push(n.id);
  const pos = new Map<string, { x: number; y: number }>();
  const rows = Math.max(...Object.values(byColumn).map((c) => c.length));
  for (const [col, ids] of Object.entries(byColumn)) ids.forEach((id, i) => pos.set(id, { x: 20 + Number(col) * 150, y: 16 + (i + (rows - ids.length) / 2) * 56 }));
  const w = 96;
  const h = 32;
  const colour: Record<string, string> = { action: 'var(--action)', state: 'var(--state)', goal: 'var(--goal)' };
  return (
    <figure className="method-example" style={{ margin: 0 }}>
      <svg viewBox={`0 0 440 ${rows * 56 + 12}`} role="img" aria-label={`Example: ${example.caption} ${example.outcome}`}>
        <defs>
          <marker id="ex-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L10 5L0 10z" fill="currentColor" />
          </marker>
        </defs>
        {example.arrows.map((a) => {
          const p = pos.get(a.from)!;
          const q = pos.get(a.to)!;
          const sameColumn = p.x === q.x;
          const x1 = sameColumn ? p.x + w / 2 : p.x + w;
          const y1 = sameColumn ? p.y + h : p.y + h / 2;
          const x2 = sameColumn ? q.x + w / 2 : q.x - 3;
          const y2 = sameColumn ? q.y - 3 : q.y + h / 2;
          return (
            <g key={a.from + a.to} style={{ color: 'var(--muted)' }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="1.5" markerEnd="url(#ex-arrow)" />
              {a.label && (
                <text x={(x1 + x2) / 2 + (sameColumn ? 16 : 0)} y={(y1 + y2) / 2 - (sameColumn ? -4 : 5)} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--text)">
                  {a.label}
                </text>
              )}
            </g>
          );
        })}
        {example.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id}>
              <rect x={p.x} y={p.y} width={w} height={h} rx={n.kind === 'action' ? 4 : 9} fill="var(--surface)" stroke={colour[n.kind]} strokeWidth="1.5" />
              <text x={p.x + w / 2} y={p.y + h / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="var(--text)">
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="small" style={{ marginTop: 6 }}>
        <span className="muted">{example.caption}</span> {example.outcome}
      </figcaption>
    </figure>
  );
}
