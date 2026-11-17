/** Side panel of the explorer: details and editing for whatever is selected on the map. */
import { useEffect, useState } from 'react';
import type { ParticipantModel } from '@shared/calc/types';
import { questionLayer } from '@shared/engine';
import { STANCE_WORDS } from '@shared/model';
import { latestAnswer, renderQuestion, staleReason } from '@shared/templates';
import type { ModelLink, ModelNode, NodeKind, Question, WorkshopView } from '@shared/types';
import { KindBadge, useAction } from '../lib/ui';
import { AnswerInput, formatValue } from './AnswerInput';

type Send = (command: Record<string, unknown>) => Promise<void>;

export interface InspectorProps {
  view: WorkshopView;
  model: ParticipantModel | null;
  /** The person whose claims are being shown and edited, if any. */
  actingId: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  send: Send;
  canDraw: boolean;
  focusId: string | null;
  setFocus: (id: string | null) => void;
  collapsed: Set<string>;
  toggleCollapsed: (id: string) => void;
  badges: Record<string, string[]>;
}

const KIND_LAYER = { goal: 'goals', state: 'states', action: 'actions' } as const;

export function canAnswer(view: WorkshopView, q: Question): boolean {
  if (q.status === 'superseded' || q.status === 'dismissed') return false;
  if (view.role.type === 'facilitator') return true;
  return q.status === 'live' || (q.status === 'closed' && q.rounds > 0) || view.settings.layers[questionLayer(view, q)].open;
}

export function Inspector(props: InspectorProps) {
  const { view, selectedId } = props;
  const node = selectedId ? view.nodes[selectedId] : undefined;
  const link = selectedId ? view.links[selectedId] : undefined;
  if (node) return <NodePanel key={node.id} {...props} node={node} />;
  if (link) return <LinkPanel key={link.id} {...props} link={link} />;
  return <Overview {...props} />;
}

// — nothing selected —

function Overview({ view, model, actingId, send, onSelect, canDraw }: InspectorProps) {
  const isOrganizer = view.role.type === 'facilitator';
  const canAdd = (kind: NodeKind) => isOrganizer || view.settings.layers[KIND_LAYER[kind]].open;
  const kinds = (['goal', 'state', 'action'] as const).filter(canAdd);
  const held = model?.links.filter((l) => l.stance === 'yes' || l.stance === 'conditional').length ?? 0;
  const unreviewed = model?.links.filter((l) => l.stance === 'unstated').length ?? 0;
  const items = Object.values(view.nodes).filter((n) => n.status === 'active');
  const hasGoal = !!view.goal.nodeId;
  const estimates = actingId
    ? Object.values(view.questions).filter((q) => q.subject.type === 'link' && ['probability', 'difference'].includes(renderQuestion(view, q).answer.type) && latestAnswer(view, q.id, actingId)).length
    : 0;
  const steps = [
    { done: hasGoal, text: 'Name the goal and choose it', hint: 'Add a goal below, select it, then “Choose as the goal”.' },
    { done: items.some((n) => n.kind === 'state'), text: 'Add the states that would lead to it', hint: 'Work backwards: what would make the goal more likely? And those?' },
    { done: held > 0, text: 'Draw the arrows', hint: 'Drag from a cause to what it affects, or switch on “Tap to connect”.' },
    { done: items.some((n) => n.kind === 'action'), text: 'Add actions you could take', hint: 'Then connect each to the state it would help bring about.' },
    { done: estimates > 0, text: 'Give estimates where the method needs them', hint: 'Select an arrow to see its questions. “Not sure” is fine.' },
    { done: view.runs.length > 0, text: 'Look at the results', hint: 'Open the Results tab.' },
  ];
  return (
    <>
      {view.mode === 'solo' && (
        <section className="side-section">
          <h3>Building your model</h3>
          <ol className="checklist">
            {steps.map((s) => (
              <li key={s.text}>
                <span className={`tick ${s.done ? 'done' : ''}`} aria-hidden>
                  {s.done ? '✓' : ''}
                </span>
                <span>
                  <span style={{ fontWeight: 600 }}>{s.text}</span>
                  {!s.done && <span className="muted small" style={{ display: 'block' }}>{s.hint}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="side-section">
        <h3>{model ? 'This map' : 'Everything proposed'}</h3>
        <p className="small muted">
          {items.length} item{items.length === 1 ? '' : 's'}
          {model ? ` · ${held} arrow${held === 1 ? '' : 's'}` : ` · ${Object.values(view.links).filter((l) => l.status === 'active').length} proposed arrows`}
          {model && unreviewed > 0 ? ` · ${unreviewed} proposed by others, not reviewed` : ''}
        </p>
        {!hasGoal && <div className="banner banner-warn small">No goal has been chosen yet{isOrganizer ? '. Add or select a goal and choose it.' : '.'}</div>}
        {hasGoal && (
          <button className="btn btn-sm" onClick={() => onSelect(view.goal.nodeId)}>
            Go to the goal: {view.nodes[view.goal.nodeId!]?.label}
          </button>
        )}
        {model && canDraw && <p className="small muted">Drag from the right edge of an item to another item to draw an arrow. An arrow you do not draw is simply not in your map — it is not a claim that there is no effect.</p>}
        {model && !canDraw && view.role.type === 'participant' && <p className="small muted">Drawing arrows is not open at the moment. You can still look around and review what you have said.</p>}
      </section>
      {kinds.length > 0 && <AddItem view={view} send={send} kinds={kinds} onAdded={onSelect} />}
    </>
  );
}

function AddItem({ view, send, kinds, onAdded, under }: { view: WorkshopView; send: Send; kinds: NodeKind[]; onAdded: (id: string | null) => void; under?: ModelNode }) {
  const { busy, run } = useAction();
  const [kind, setKind] = useState<NodeKind>(kinds.includes('state') ? 'state' : kinds[0]!);
  const [label, setLabel] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  // Select the new item once it arrives from the server.
  useEffect(() => {
    if (!pending) return;
    const created = Object.values(view.nodes).find((n) => n.label === pending && n.status === 'active');
    if (created) {
      onAdded(under ? under.id : created.id);
      setPending(null);
    }
  }, [view.nodes, pending, onAdded, under]);
  return (
    <section className="side-section">
      <h3>{under ? `Add something that leads to “${under.label}”` : 'Add to the map'}</h3>
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          const text = label.trim();
          if (!text) return;
          void run(async () => {
            await send({ type: 'add_node', kind, label: text, elicitedFor: under?.id });
            setPending(text);
            setLabel('');
          });
        }}
      >
        {kinds.length > 1 && (
          <div className="seg" role="group" aria-label="Kind of item">
            {kinds.map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {view.config.labels[k]}
              </button>
            ))}
          </div>
        )}
        <div className="row">
          <input className="input grow" value={label} maxLength={120} placeholder={kind === 'action' ? 'Something that could be done' : kind === 'goal' ? 'A goal' : 'A state of the world'} aria-label="Name" onChange={(e) => setLabel(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !label.trim()}>
            Add
          </button>
        </div>
        {under && <p className="tiny muted">No arrow is drawn for you. Connect it when you are ready.</p>}
      </form>
    </section>
  );
}

function QuestionBlock({ view, question, actingId, send, open }: { view: WorkshopView; question: Question; actingId: string; send: Send; open?: boolean }) {
  const r = renderQuestion(view, question);
  const a = latestAnswer(view, question.id, actingId);
  const stale = a ? staleReason(view, question, a) : null;
  const { run, busy } = useAction();
  const who = view.role.type === 'facilitator' ? { participantId: actingId } : {};
  const history = view.answers[question.id]?.[actingId] ?? [];
  return (
    <details className="tpl" open={open}>
      <summary>
        <span className="grow">
          <span style={{ fontWeight: 600 }}>{r.title}</span>
          <span className="small muted" style={{ display: 'block' }}>
            {a ? formatValue(view, r.answer, a.value) : 'No answer yet'}
          </span>
        </span>
        {stale && <span className="chip chip-warn">review</span>}
      </summary>
      <div className="tpl-body">
        <p className="small">{r.prompt}</p>
        {r.help && <p className="small muted">{r.help}</p>}
        {stale && (
          <div className="banner banner-warn small stack-sm">
            {stale}
            <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'confirm_answer', questionId: question.id, ...who }), 'Kept')}>
              It still stands
            </button>
          </div>
        )}
        {canAnswer(view, question) ? (
          <AnswerInput view={view} question={question} participantId={actingId} send={send} via="explorer" onBehalf={view.role.type === 'facilitator'} compact />
        ) : (
          <p className="small muted">This question is not open for changes right now.</p>
        )}
        {history.length > 1 && (
          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>
              Earlier versions ({history.length - 1})
            </summary>
            <div className="stack-sm" style={{ marginTop: 6 }}>
              {history
                .slice(0, -1)
                .reverse()
                .map((h) => (
                  <div key={h.revision} className="small muted">
                    v{h.revision} · {new Date(h.at).toLocaleString()} · {formatValue(view, r.answer, h.value)}
                    {h.reasoning ? ` — “${h.reasoning}”` : ''}
                  </div>
                ))}
            </div>
          </details>
        )}
      </div>
    </details>
  );
}

function provenanceLines(view: WorkshopView, item: ModelNode | ModelLink): string[] {
  const name = (a: { type: string; id?: string }) => (a.type === 'participant' ? (view.participants[a.id ?? '']?.name ?? 'someone') : a.type === 'facilitator' ? (view.mode === 'solo' ? 'you' : 'the facilitator') : 'the system');
  return item.provenance.map((p) => {
    const when = new Date(p.at).toLocaleString();
    switch (p.event) {
      case 'created':
        return `Added by ${name(p.actor)} · ${when}`;
      case 'from-suggestion':
        return `Suggested by ${name(p.actor)}${p.detail?.originalText ? ` as “${p.detail.originalText}”` : ''} · ${when}`;
      case 'merged-in':
        return p.detail?.originalText ? `${name(p.actor)} suggested the similar “${p.detail.originalText}”, combined into this · ${when}` : `“${p.detail?.label ?? 'another item'}” was merged into this · ${when}`;
      case 'renamed':
        return `Reworded${p.detail?.previousLabel ? ` from “${p.detail.previousLabel}”` : ''} (same meaning) · ${when}`;
      case 'redefined':
        return `Meaning changed${p.detail?.previousLabel ? ` (was “${p.detail.previousLabel}”)` : ''} · ${when}`;
      case 'archived':
        return `Removed from the map · ${when}`;
      default:
        return `Restored · ${when}`;
    }
  });
}

// — an item —

function NodePanel(props: InspectorProps & { node: ModelNode }) {
  const { view, model, node, actingId, send, onSelect, canDraw, focusId, setFocus, collapsed, toggleCollapsed, badges } = props;
  const isOrganizer = view.role.type === 'facilitator';
  const { busy, run } = useAction();
  const [label, setLabel] = useState(node.label);
  const [definition, setDefinition] = useState(node.definition);
  const [meaningChanged, setMeaningChanged] = useState(false);
  const [success, setSuccess] = useState(view.goal.nodeId === node.id ? view.goal.successDefinition : '');
  const [horizon, setHorizon] = useState(view.goal.nodeId === node.id ? view.goal.horizon : view.goal.horizon);
  const [target, setTarget] = useState('');
  const [mergeInto, setMergeInto] = useState('');
  const who = isOrganizer && actingId ? { participantId: actingId } : {};
  const dirty = label.trim() !== node.label || definition.trim() !== node.definition;
  const isGoal = view.goal.nodeId === node.id;
  const links = model?.links ?? Object.values(view.links).filter((l) => l.status === 'active').map((l) => ({ ...l, stance: 'catalogue' as const }));
  const incoming = links.filter((l) => l.to === node.id && l.stance !== 'no');
  const outgoing = links.filter((l) => l.from === node.id && l.stance !== 'no');
  const others = Object.values(view.nodes).filter((n) => n.status === 'active' && n.id !== node.id);
  const questions = actingId ? Object.values(view.questions).filter((q) => q.subject.type === 'node' && q.subject.nodeId === node.id && q.status !== 'superseded' && q.status !== 'dismissed') : [];
  const canAddUnder = (kind: NodeKind) => isOrganizer || view.settings.layers[KIND_LAYER[kind]].open;
  const addKinds = (['state', 'action'] as const).filter(canAddUnder);

  const arrowRow = (l: (typeof links)[number], otherId: string, direction: 'in' | 'out') => (
    <button key={l.id} className="btn btn-sm" style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto' }} onClick={() => onSelect(l.id)}>
      <span className="grow">
        {direction === 'in' ? '← ' : '→ '}
        {view.nodes[otherId]?.label}
        <span className="tiny muted" style={{ display: 'block' }}>
          {l.relation === 'requirement' ? 'required · ' : ''}
          {l.stance === 'catalogue' ? 'proposed' : l.stance === 'yes' && 'direction' in l && l.direction === 'harms' ? 'makes it less likely' : STANCE_WORDS[l.stance]}
        </span>
      </span>
    </button>
  );

  return (
    <>
      <section className="side-section">
        <div className="row">
          <KindBadge kind={node.kind} config={view.config} />
          {isGoal && <span className="chip chip-accent">the chosen goal</span>}
          {node.status !== 'active' && <span className="chip chip-warn">{node.status}</span>}
          <button className="icon-btn right" onClick={() => onSelect(null)} aria-label="Close">
            ✕
          </button>
        </div>
        {isOrganizer ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await send({ type: 'edit_node', nodeId: node.id, label: label.trim(), definition: definition.trim(), meaningChanged });
                setMeaningChanged(false);
              }, 'Saved');
            }}
          >
            <label className="field">
              <span>Name</span>
              <input className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="field">
              <span>What it means</span>
              <textarea className="textarea" value={definition} maxLength={1000} placeholder="A sentence that pins down what this means" onChange={(e) => setDefinition(e.target.value)} />
            </label>
            {dirty && (
              <>
                <label className="check small">
                  <input type="checkbox" checked={meaningChanged} onChange={(e) => setMeaningChanged(e.target.checked)} />
                  <span>
                    This changes what it means
                    <span className="muted" style={{ display: 'block' }}>
                      Earlier answers about it are kept and flagged for review. Leave unticked for a spelling or wording fix.
                    </span>
                  </span>
                </label>
                <button className="btn btn-primary btn-sm" disabled={busy || !label.trim()}>
                  Save
                </button>
              </>
            )}
          </form>
        ) : (
          <>
            <h2>{node.label}</h2>
            {node.definition && <p className="small">{node.definition}</p>}
          </>
        )}
        {(badges[node.id] ?? []).map((b) => (
          <div key={b} className="banner banner-warn small">
            {b === 'required, no action' ? 'This is marked as required on the way to the goal, and no action in this map leads to it.' : b === 'every route passes here' ? 'Every route from an action to the goal in this map passes through here.' : b}
          </div>
        ))}
        <div className="row-wrap">
          <button className="btn btn-sm" onClick={() => setFocus(focusId === node.id ? null : node.id)}>
            {focusId === node.id ? 'Show whole map' : 'Show only what is near this'}
          </button>
          <button className="btn btn-sm" onClick={() => toggleCollapsed(node.id)}>
            {collapsed.has(node.id) ? 'Unfold what leads here' : 'Fold away what leads here'}
          </button>
        </div>
      </section>

      {isOrganizer && node.kind === 'goal' && node.status === 'active' && (
        <section className="side-section">
          <h3>{isGoal ? 'The goal' : 'Choose as the goal'}</h3>
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => send({ type: 'select_goal', nodeId: node.id, successDefinition: success, horizon }), 'Goal set');
            }}
          >
            <label className="field">
              <span>What counts as success</span>
              <textarea className="textarea" style={{ minHeight: 60 }} value={success} maxLength={600} onChange={(e) => setSuccess(e.target.value)} />
            </label>
            <label className="field">
              <span>By when</span>
              <input className="input" value={horizon} maxLength={120} placeholder="e.g. the end of 2027" onChange={(e) => setHorizon(e.target.value)} />
            </label>
            <button className="btn btn-sm btn-primary" disabled={busy || (isGoal && success === view.goal.successDefinition && horizon === view.goal.horizon)}>
              {isGoal ? 'Update' : 'Choose this goal'}
            </button>
            {isGoal && <p className="tiny muted">Changing the time horizon flags estimates that depend on it for review.</p>}
          </form>
        </section>
      )}

      <section className="side-section">
        <h3>Arrows</h3>
        {incoming.length === 0 && outgoing.length === 0 && <p className="small muted">Nothing is connected to this{model ? ' in this map' : ''} yet.</p>}
        {incoming.length > 0 && (
          <div className="stack-sm">
            <h4>What leads here</h4>
            {incoming.map((l) => arrowRow(l, l.from, 'in'))}
          </div>
        )}
        {outgoing.length > 0 && (
          <div className="stack-sm">
            <h4>What this leads to</h4>
            {outgoing.map((l) => arrowRow(l, l.to, 'out'))}
          </div>
        )}
        {canDraw && actingId && node.kind !== 'goal' && (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!target) return;
              void run(async () => {
                await send({ type: 'hold_link', from: node.id, to: target, hold: true, ...who });
                setTarget('');
              }, 'Arrow drawn');
            }}
          >
            <span className="label">Draw an arrow from this to…</span>
            <div className="row">
              <select className="select grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="What this affects">
                <option value="">Choose…</option>
                {others
                  .filter((n) => n.kind !== 'action' && (model ? model.nodes.some((m) => m.id === n.id) : true))
                  .sort((a, b) => a.label.localeCompare(b.label))
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.label}
                    </option>
                  ))}
              </select>
              <button className="btn" disabled={busy || !target}>
                Draw
              </button>
            </div>
          </form>
        )}
      </section>

      {addKinds.length > 0 && node.kind !== 'action' && node.status === 'active' && <AddItem view={view} send={send} kinds={[...addKinds]} onAdded={onSelect} under={node} />}

      {actingId && questions.length > 0 && (
        <section className="side-section">
          <h3>Questions about this</h3>
          {questions.map((q) => (
            <QuestionBlock key={q.id} view={view} question={q} actingId={actingId} send={send} />
          ))}
        </section>
      )}

      <section className="side-section">
        <h3>Where it came from</h3>
        <div className="stack-sm">
          {provenanceLines(view, node).map((line, i) => (
            <div key={i} className="small muted">
              {line}
            </div>
          ))}
        </div>
        <p className="tiny muted">Who suggested something says nothing about who agrees with it.</p>
      </section>

      {isOrganizer && (
        <section className="side-section">
          <h3>Tidy up</h3>
          {node.status === 'active' && (
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                const into = view.nodes[mergeInto];
                if (!into) return;
                if (!window.confirm(`Merge “${node.label}” into “${into.label}”?\n\nThey will be treated as the same item. Arrows and answers are carried over and flagged for review; who suggested what is kept. This is refused if it would create a loop.`)) return;
                void run(async () => {
                  await send({ type: 'merge_nodes', fromNodeId: node.id, intoNodeId: into.id, confirm: true });
                  onSelect(into.id);
                }, 'Merged');
              }}
            >
              <span className="label">Same thing as another item? Merge into…</span>
              <div className="row">
                <select className="select grow" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} aria-label="Merge into">
                  <option value="">Choose…</option>
                  {others
                    .filter((n) => n.kind === node.kind)
                    .sort((a, b) => a.label.localeCompare(b.label))
                    .map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                </select>
                <button className="btn" disabled={busy || !mergeInto}>
                  Merge…
                </button>
              </div>
            </form>
          )}
          {node.status === 'active' ? (
            <button
              className="btn btn-sm btn-danger"
              disabled={busy || isGoal}
              title={isGoal ? 'Choose a different goal first' : undefined}
              onClick={() => void run(() => send({ type: 'set_node_status', nodeId: node.id, status: 'archived' }).then(() => onSelect(null)), 'Removed from the map (kept in the record)')}
            >
              Remove from the map
            </button>
          ) : node.status === 'archived' ? (
            <button className="btn btn-sm" disabled={busy} onClick={() => void run(() => send({ type: 'set_node_status', nodeId: node.id, status: 'active' }), 'Restored')}>
              Restore to the map
            </button>
          ) : null}
        </section>
      )}
    </>
  );
}

// — an arrow —

function LinkPanel(props: InspectorProps & { link: ModelLink }) {
  const { view, model, link, actingId, send, onSelect, canDraw } = props;
  const isOrganizer = view.role.type === 'facilitator';
  const { busy, run } = useAction();
  const who = isOrganizer && actingId ? { participantId: actingId } : {};
  const mine = model?.links.find((l) => l.id === link.id);
  const questions = Object.values(view.questions).filter((q) => q.subject.type === 'link' && q.subject.linkId === link.id && q.status !== 'superseded' && q.status !== 'dismissed');
  const stanceQ = questions.find((q) => renderQuestion(view, q).role === 'link.stance');
  const from = view.nodes[link.from];
  const to = view.nodes[link.to];
  const othersViews = stanceQ ? Object.entries(view.answers[stanceQ.id] ?? {}).filter(([pid]) => pid !== actingId) : [];
  const isSynthesis = model?.participantId.startsWith('syn:');

  return (
    <>
      <section className="side-section">
        <div className="row">
          <span className="chip">{link.relation === 'requirement' ? 'Requirement' : 'Arrow'}</span>
          {mine && <span className={`chip ${mine.stance === 'yes' ? 'chip-ok' : ''}`}>{isSynthesis ? 'in the combined map' : STANCE_WORDS[mine.stance]}</span>}
          <button className="icon-btn right" onClick={() => onSelect(null)} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="stack-sm">
          <button className="btn btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => onSelect(link.from)}>
            {from?.label}
          </button>
          <div className="muted small" style={{ paddingLeft: 12 }}>
            ↓ {link.relation === 'requirement' ? view.config.labels.requirement : view.config.labels.influence}
          </div>
          <button className="btn btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => onSelect(link.to)}>
            {to?.label}
          </button>
        </div>
        {mine?.mechanism && <p className="small">“{mine.mechanism}”</p>}
        {actingId && canDraw && mine && (mine.stance === 'yes' || mine.stance === 'conditional') && (
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => send({ type: 'hold_link', from: link.from, to: link.to, relation: link.relation, hold: false, ...who }), 'Removed from this map')}>
            Remove this arrow from {isOrganizer && view.mode !== 'solo' ? `${view.participants[actingId]?.name}’s` : 'my'} map
          </button>
        )}
        {actingId && canDraw && mine && mine.stance !== 'yes' && mine.stance !== 'conditional' && (
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void run(() => send({ type: 'hold_link', from: link.from, to: link.to, relation: link.relation, hold: true, ...who }), 'Added to this map')}>
            Add this arrow to {isOrganizer && view.mode !== 'solo' ? `${view.participants[actingId]?.name}’s` : 'my'} map
          </button>
        )}
        <p className="tiny muted">The arrow points from cause to effect. Evidence that runs the other way (“if this happened, that probably happened too”) is not an arrow.</p>
      </section>

      {actingId && !isSynthesis && questions.length > 0 && (
        <section className="side-section">
          <h3>{isOrganizer && view.mode !== 'solo' ? `${view.participants[actingId]?.name}’s answers` : 'Your answers'}</h3>
          {questions.map((q) => (
            <QuestionBlock key={q.id} view={view} question={q} actingId={actingId} send={send} />
          ))}
        </section>
      )}

      {othersViews.length > 0 && stanceQ && (
        <section className="side-section">
          <h3>Other people on this arrow</h3>
          <table className="claims-table">
            <tbody>
              {othersViews.map(([pid, list]) => {
                const a = list[list.length - 1]!;
                return (
                  <tr key={pid}>
                    <td>{view.participants[pid]?.name ?? 'Someone'}</td>
                    <td>
                      {formatValue(view, renderQuestion(view, stanceQ).answer, a.value)}
                      {a.reasoning && <div className="small muted">“{a.reasoning}”</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="tiny muted">Shown side by side. Nobody is outvoted.</p>
        </section>
      )}

      <section className="side-section">
        <h3>Where it came from</h3>
        <div className="stack-sm">
          {provenanceLines(view, link).map((line, i) => (
            <div key={i} className="small muted">
              {line}
            </div>
          ))}
        </div>
      </section>

      {isOrganizer && link.status === 'active' && (
        <section className="side-section">
          <button
            className="btn btn-sm btn-danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Remove this arrow from the catalogue for everyone?\n\nIt stays in the record and can be restored, and everyone’s answers about it are kept.')) return;
              void run(() => send({ type: 'set_link_status', linkId: link.id, status: 'archived' }).then(() => onSelect(null)), 'Removed (kept in the record)');
            }}
          >
            Remove from the catalogue for everyone
          </button>
        </section>
      )}
    </>
  );
}
