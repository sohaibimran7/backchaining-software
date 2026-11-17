/**
 * One component that knows how to collect every kind of answer. Used on the
 * participant's phone and in the explorer, so the two can never drift apart.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AnswerSpec } from '@shared/config';
import { pct, points } from '@shared/model';
import { latestAnswer, linkId, renderQuestion, type RenderedQuestion } from '@shared/templates';
import type { AnswerValue, Question, WorkshopView } from '@shared/types';
import { KindBadge, useAction } from '../lib/ui';

type Send = (command: Record<string, unknown>) => Promise<void>;

export function formatValue(view: WorkshopView, spec: AnswerSpec, value: AnswerValue): string {
  switch (value.kind) {
    case 'unsure':
      return view.config.labels.unsure;
    case 'done':
      return 'Nothing more to add';
    case 'choice':
      return spec.type === 'choice' ? (spec.options.find((o) => o.value === value.choice)?.label ?? value.choice) : value.choice;
    case 'pick-node':
      return view.nodes[value.nodeId]?.label ?? '(removed)';
    case 'probability':
      return value.low !== undefined && value.high !== undefined ? `${pct(value.p)} (somewhere between ${pct(value.low)} and ${pct(value.high)})` : pct(value.p);
    case 'difference': {
      const word = (d: number) => (d > 0 ? 'more likely' : d < 0 ? 'less likely' : 'no change');
      return value.low !== undefined && value.high !== undefined ? `${points(value.d)} (between ${points(value.low)} and ${points(value.high)})` : `${points(value.d)}, ${word(value.d)}`;
    }
    case 'text':
      return value.text;
  }
}

interface Props {
  view: WorkshopView;
  question: Question;
  participantId: string;
  send: Send;
  via: 'question' | 'explorer';
  /** True when the facilitator is typing in an answer for someone. */
  onBehalf?: boolean;
  compact?: boolean;
  onSaved?: () => void;
}

export function AnswerInput(props: Props) {
  const r = renderQuestion(props.view, props.question);
  if (!r.known) return <p className="muted small">This question’s wording was removed from the configuration, so it cannot be answered.</p>;
  switch (r.answer.type) {
    case 'suggestions':
      return <SuggestionsInput {...props} r={r} placeholder={r.answer.placeholder} />;
    case 'nominate-links':
      return <NominateInput {...props} r={r} spec={r.answer} />;
    default:
      return <ValueInput {...props} r={r} />;
  }
}

function useSubmit({ question, participantId, send, via, onBehalf, onSaved }: Props) {
  const { busy, run } = useAction();
  const who = onBehalf ? { participantId } : {};
  const answer = (value: AnswerValue, reasoning?: string) =>
    run(async () => {
      await send({ type: 'answer', questionId: question.id, value, reasoning: reasoning?.trim() || undefined, via, ...who });
      onSaved?.();
    }, 'Saved');
  return { busy, run, answer, who };
}

// — single-value answers: choice, pick-node, probability, text —

function ValueInput(props: Props & { r: RenderedQuestion }) {
  const { view, question, participantId, r, compact } = props;
  const { busy, answer } = useSubmit(props);
  const existing = latestAnswer(view, question.id, participantId);
  const [value, setValue] = useState<AnswerValue | null>(existing?.value ?? null);
  const [reasoning, setReasoning] = useState(existing?.reasoning ?? '');
  // If the saved answer changes underneath us (another device), follow it.
  useEffect(() => {
    setValue(existing?.value ?? null);
    setReasoning(existing?.reasoning ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id, participantId, existing?.revision]);

  const spec = r.answer;
  const unsure = value?.kind === 'unsure';
  const changed = JSON.stringify(value) !== JSON.stringify(existing?.value ?? null) || reasoning.trim() !== (existing?.reasoning ?? '');
  const size = compact ? '' : 'btn-lg';
  const reasoningLabel = value?.kind === 'choice' && value.choice === 'conditional' ? 'Under what conditions?' : spec.type === 'choice' ? 'How does it work? (optional)' : 'Your reasoning (optional)';

  return (
    <div className="stack">
      {spec.type === 'choice' && (
        <div className="stack-sm" role="radiogroup" aria-label={r.prompt}>
          {spec.options.map((o) => (
            <button key={o.value} type="button" role="radio" className="option-btn" aria-checked={value?.kind === 'choice' && value.choice === o.value} onClick={() => setValue({ kind: 'choice', choice: o.value })}>
              <span className="option-radio" aria-hidden />
              {o.label}
            </button>
          ))}
        </div>
      )}
      {spec.type === 'pick-node' && <PickNode view={view} kinds={spec.kinds} value={value} onChange={setValue} prompt={r.prompt} />}
      {spec.type === 'probability' && <Probability value={value} onChange={setValue} allowRange={spec.allowRange} />}
      {spec.type === 'difference' && <Difference value={value} onChange={setValue} allowRange={spec.allowRange} />}
      {spec.type === 'text' && (
        <textarea
          className="textarea"
          aria-label={r.prompt}
          placeholder={spec.placeholder}
          maxLength={2000}
          value={value?.kind === 'text' ? value.text : ''}
          onChange={(e) => setValue(e.target.value ? { kind: 'text', text: e.target.value } : null)}
        />
      )}
      {r.allowUnsure && (
        <button type="button" className="option-btn unsure" aria-pressed={unsure} onClick={() => setValue(unsure ? null : { kind: 'unsure' })}>
          <span className="option-radio" aria-hidden />
          {view.config.labels.unsure}
        </button>
      )}
      {spec.type !== 'text' && value && (
        <label className="field">
          <span>{reasoningLabel}</span>
          <textarea className="textarea" style={{ minHeight: 60 }} maxLength={1000} value={reasoning} onChange={(e) => setReasoning(e.target.value)} />
        </label>
      )}
      <button
        type="button"
        className={`btn btn-primary ${size} btn-block`}
        disabled={busy || !value || !changed || (value.kind === 'text' && !value.text.trim())}
        onClick={() => value && void answer(value, spec.type === 'text' ? undefined : reasoning)}
      >
        {existing ? (changed ? 'Save change' : 'Saved') : 'Save answer'}
      </button>
    </div>
  );
}

function PickNode({ view, kinds, value, onChange, prompt }: { view: WorkshopView; kinds: string[]; value: AnswerValue | null; onChange: (v: AnswerValue) => void; prompt: string }) {
  const options = Object.values(view.nodes).filter((n) => n.status === 'active' && kinds.includes(n.kind));
  if (options.length === 0) return <p className="muted">There is nothing to choose from yet.</p>;
  return (
    <div className="stack-sm" role="radiogroup" aria-label={prompt}>
      {options.map((n) => (
        <button key={n.id} type="button" role="radio" className="option-btn" aria-checked={value?.kind === 'pick-node' && value.nodeId === n.id} onClick={() => onChange({ kind: 'pick-node', nodeId: n.id })}>
          <span className="option-radio" aria-hidden />
          {n.label}
        </button>
      ))}
    </div>
  );
}

function Probability({ value, onChange, allowRange }: { value: AnswerValue | null; onChange: (v: AnswerValue) => void; allowRange: boolean }) {
  const current = value?.kind === 'probability' ? value : null;
  const p = current ? Math.round(current.p * 100) : 50;
  const hasRange = current?.low !== undefined && current?.high !== undefined;
  const low = hasRange ? Math.round(current!.low! * 100) : Math.max(0, p - 10);
  const high = hasRange ? Math.round(current!.high! * 100) : Math.min(100, p + 10);
  const set = (np: number, nl?: number, nh?: number) => {
    if (nl === undefined || nh === undefined) return onChange({ kind: 'probability', p: np / 100 });
    const lo = Math.min(nl, np);
    const hi = Math.max(nh, np);
    onChange({ kind: 'probability', p: np / 100, low: lo / 100, high: hi / 100 });
  };
  return (
    <div className="prob">
      <div className="prob-value" aria-live="polite">
        {current ? `${p}%` : '—'}
        <small>{current ? (hasRange ? `somewhere between ${low}% and ${high}%` : 'your best guess') : 'move the slider'}</small>
      </div>
      <input type="range" min={0} max={100} step={1} value={p} aria-label="Best guess, percent" onChange={(e) => set(Number(e.target.value), hasRange ? low : undefined, hasRange ? high : undefined)} onPointerDown={() => !current && set(p)} />
      <div className="prob-scale" aria-hidden>
        <span>0% never</span>
        <span>50%</span>
        <span>100% certain</span>
      </div>
      {allowRange && current && (
        <>
          <label className="check small">
            <input type="checkbox" checked={hasRange} onChange={(e) => (e.target.checked ? set(p, low, high) : set(p))} />
            <span>Give a range as well (how far off could you be?)</span>
          </label>
          {hasRange && (
            <div className="grid-2">
              <label className="field">
                <span>At least {low}%</span>
                <input type="range" min={0} max={p} step={1} value={low} onChange={(e) => set(p, Number(e.target.value), high)} />
              </label>
              <label className="field">
                <span>At most {high}%</span>
                <input type="range" min={p} max={100} step={1} value={high} onChange={(e) => set(p, low, Number(e.target.value))} />
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** A change in a chance, in percentage points: left of centre is less likely, right is more likely. */
function Difference({ value, onChange, allowRange }: { value: AnswerValue | null; onChange: (v: AnswerValue) => void; allowRange: boolean }) {
  const current = value?.kind === 'difference' ? value : null;
  const d = current ? Math.round(current.d * 100) : 0;
  const hasRange = current?.low !== undefined && current?.high !== undefined;
  const low = hasRange ? Math.round(current!.low! * 100) : Math.max(-100, d - 10);
  const high = hasRange ? Math.round(current!.high! * 100) : Math.min(100, d + 10);
  const set = (nd: number, nl?: number, nh?: number) => {
    if (nl === undefined || nh === undefined) return onChange({ kind: 'difference', d: nd / 100 });
    onChange({ kind: 'difference', d: nd / 100, low: Math.min(nl, nd) / 100, high: Math.max(nh, nd) / 100 });
  };
  const sign = (n: number) => `${n > 0 ? '+' : ''}${n}`;
  return (
    <div className="prob">
      <div className="prob-value" aria-live="polite">
        {current ? `${sign(d)}` : '—'}
        <small>{current ? `percentage points: ${d > 0 ? 'more likely' : d < 0 ? 'less likely' : 'no change'}${hasRange ? `, somewhere between ${sign(low)} and ${sign(high)}` : ''}` : 'move the slider'}</small>
      </div>
      <input type="range" min={-100} max={100} step={1} value={d} aria-label="Change in percentage points" onChange={(e) => set(Number(e.target.value), hasRange ? low : undefined, hasRange ? high : undefined)} onPointerDown={() => !current && set(d)} />
      <div className="prob-scale" aria-hidden>
        <span>much less likely</span>
        <span>no change</span>
        <span>much more likely</span>
      </div>
      <div className="row-wrap">
        {[-20, -5, 0, 5, 10, 20, 40].map((n) => (
          <button key={n} type="button" className="btn btn-sm" aria-pressed={current !== null && d === n} onClick={() => set(n, hasRange ? low : undefined, hasRange ? high : undefined)}>
            {sign(n)}
          </button>
        ))}
      </div>
      <p className="tiny muted">Example: from a 30% chance to a 50% chance is +20 points. You do not need to say what the chance is, only how much it changes.</p>
      {allowRange && current && (
        <>
          <label className="check small">
            <input type="checkbox" checked={hasRange} onChange={(e) => (e.target.checked ? set(d, low, high) : set(d))} />
            <span>Give a range as well (how far off could you be?)</span>
          </label>
          {hasRange && (
            <div className="grid-2">
              <label className="field">
                <span>At least {sign(low)}</span>
                <input type="range" min={-100} max={d} step={1} value={low} onChange={(e) => set(d, Number(e.target.value), high)} />
              </label>
              <label className="field">
                <span>At most {sign(high)}</span>
                <input type="range" min={d} max={100} step={1} value={high} onChange={(e) => set(d, low, Number(e.target.value))} />
              </label>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// — open-ended: suggestions —

function MySuggestions({ view, question, participantId, send }: Pick<Props, 'view' | 'question' | 'participantId' | 'send'>) {
  const { run } = useAction();
  const mine = Object.values(view.suggestions)
    .filter((s) => s.questionId === question.id && s.participantId === participantId && s.status !== 'withdrawn')
    .sort((a, b) => a.at.localeCompare(b.at));
  if (mine.length === 0) return null;
  const statusWords: Record<string, string> = { pending: 'Sent', accepted: 'Added to the map', merged: 'Combined with a similar one', declined: 'Set aside for now' };
  return (
    <div className="stack-sm">
      <h4>Your suggestions</h4>
      {mine.map((s) => (
        <div key={s.id} className="response row">
          <div className="grow">
            <div>{s.text}</div>
            <div className="tiny muted">
              {statusWords[s.status]}
              {s.status === 'merged' && s.nodeId && view.nodes[s.nodeId] ? `: “${view.nodes[s.nodeId]!.label}”` : ''}
            </div>
          </div>
          {s.status === 'pending' && (
            <button className="btn btn-sm btn-ghost" onClick={() => void run(() => send({ type: 'withdraw_suggestion', suggestionId: s.id }))}>
              Take back
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function DoneButtons(props: Props & { r: RenderedQuestion; hasContent: boolean }) {
  const { view, question, participantId, r, hasContent } = props;
  const { busy, answer } = useSubmit(props);
  const existing = latestAnswer(view, question.id, participantId);
  if (existing?.value.kind === 'done' || existing?.value.kind === 'unsure') {
    return <div className="banner banner-ok small">You said: {existing.value.kind === 'done' ? 'nothing more to add' : view.config.labels.unsure.toLowerCase()}. You can still add more.</div>;
  }
  return (
    <div className="row-wrap">
      <button type="button" className="btn grow" disabled={busy} onClick={() => void answer({ kind: 'done' })}>
        {hasContent ? 'That’s all from me' : 'Nothing to add'}
      </button>
      {r.allowUnsure && !hasContent && (
        <button type="button" className="btn grow" disabled={busy} onClick={() => void answer({ kind: 'unsure' })}>
          {view.config.labels.unsure}
        </button>
      )}
    </div>
  );
}

function SuggestionsInput(props: Props & { r: RenderedQuestion; placeholder?: string }) {
  const { view, question, participantId, send, placeholder } = props;
  const { busy, run, who } = useSubmit(props);
  const [text, setText] = useState('');
  const count = Object.values(view.suggestions).filter((s) => s.questionId === question.id && s.participantId === participantId && s.status !== 'withdrawn').length;
  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void run(async () => {
            await send({ type: 'suggest', questionId: question.id, text, ...who });
            setText('');
          });
        }}
      >
        <input className="input grow" value={text} maxLength={200} placeholder={placeholder ?? 'Type a suggestion'} aria-label="Your suggestion" enterKeyHint="send" onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>
          Add
        </button>
      </form>
      <MySuggestions view={view} question={question} participantId={participantId} send={send} />
      <DoneButtons {...props} hasContent={count > 0} />
    </div>
  );
}

// — open-ended: connection discovery —

type PickAs = 'helps' | 'harms' | 'required';

function NominateInput(props: Props & { r: RenderedQuestion; spec: Extract<AnswerSpec, { type: 'nominate-links' }> }) {
  const { view, question, participantId, send, spec } = props;
  const { busy, run, who } = useSubmit(props);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [as, setAs] = useState<PickAs>('helps');
  const [mechanism, setMechanism] = useState('');
  const [missing, setMissing] = useState('');
  const targetId = question.subject.type === 'node' ? question.subject.nodeId : '';

  /** What this person currently holds about each possible source → this target. */
  const mine = useMemo(() => {
    const result = new Map<string, { as: PickAs | 'conditional'; mechanism?: string }>();
    for (const n of Object.values(view.nodes)) {
      for (const relation of ['influence', 'requirement'] as const) {
        const link = view.links[linkId(relation, n.id, targetId)];
        if (!link || link.status !== 'active') continue;
        const stanceQ = Object.values(view.questions).find((q) => q.subject.type === 'link' && q.subject.linkId === link.id && renderQuestion(view, q).role === 'link.stance');
        const a = stanceQ ? latestAnswer(view, stanceQ.id, participantId) : undefined;
        if (a?.value.kind !== 'choice') continue;
        const c = a.value.choice;
        if (c === 'yes') result.set(n.id, { as: relation === 'requirement' ? 'required' : 'helps', mechanism: a.reasoning });
        else if (c === 'harms') result.set(n.id, { as: 'harms', mechanism: a.reasoning });
        else if (c === 'conditional') result.set(n.id, { as: 'conditional', mechanism: a.reasoning });
      }
    }
    return result;
  }, [view, targetId, participantId]);

  const candidates = Object.values(view.nodes)
    .filter((n) => n.status === 'active' && n.id !== targetId && spec.sourceKinds.includes(n.kind))
    .filter((n) => !search.trim() || n.label.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(mine.has(b.id)) - Number(mine.has(a.id)) || a.label.localeCompare(b.label));
  const shown = candidates.slice(0, 40);
  const words: Record<string, string> = { helps: 'Makes it more likely', harms: 'Makes it less likely', required: 'Required for it', conditional: 'Only under some conditions' };

  return (
    <div className="stack">
      <p className="small muted">
        Pick the few that matter most{spec.suggestedMax ? ` (around ${spec.suggestedMax} is plenty)` : ''}. You have picked <strong>{mine.size}</strong>.
      </p>
      <input className="input" type="search" placeholder="Search the map…" aria-label="Search the map" value={search} onChange={(e) => setSearch(e.target.value)} />
      <div>
        {shown.length === 0 && <p className="muted small">Nothing on the map matches.</p>}
        {shown.map((n) => {
          const picked = mine.get(n.id);
          const isOpen = open === n.id;
          return (
            <div key={n.id} className={`pick ${picked ? 'picked' : ''}`}>
              <button
                type="button"
                className="pick-head"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? null : n.id);
                  setAs(picked && picked.as !== 'conditional' ? picked.as : 'helps');
                  setMechanism(picked?.mechanism ?? '');
                }}
              >
                <KindBadge kind={n.kind} config={view.config} />
                <span className="grow">
                  <span style={{ fontWeight: 600 }}>{n.label}</span>
                  {picked && <span className="tiny muted" style={{ display: 'block' }}>{words[picked.as]}{picked.mechanism ? ` — ${picked.mechanism}` : ''}</span>}
                </span>
                <span className="muted" aria-hidden>
                  {picked ? '✓' : '+'}
                </span>
              </button>
              {isOpen && (
                <div className="pick-body">
                  <div className="seg" role="group" aria-label="How does it affect it?">
                    <button type="button" aria-pressed={as === 'helps'} onClick={() => setAs('helps')}>
                      Makes it more likely
                    </button>
                    {spec.allowHarmful && (
                      <button type="button" aria-pressed={as === 'harms'} onClick={() => setAs('harms')}>
                        Makes it less likely
                      </button>
                    )}
                    {spec.allowRequirement && (
                      <button type="button" aria-pressed={as === 'required'} onClick={() => setAs('required')}>
                        Required for it
                      </button>
                    )}
                  </div>
                  <input className="input" placeholder="How, in a few words? (optional)" aria-label="How, in a few words" maxLength={300} value={mechanism} onChange={(e) => setMechanism(e.target.value)} />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-primary grow"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await send({ type: 'nominate_link', questionId: question.id, sourceNodeId: n.id, as, mechanism: mechanism.trim() || undefined, ...who });
                          setOpen(null);
                        })
                      }
                    >
                      {picked ? 'Update' : 'Add this connection'}
                    </button>
                    {picked && (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await send({ type: 'nominate_link', questionId: question.id, sourceNodeId: n.id, as: 'withdraw', ...who });
                            setOpen(null);
                          })
                        }
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {candidates.length > shown.length && <p className="muted tiny" style={{ marginTop: 8 }}>Showing {shown.length} of {candidates.length}. Search to narrow down.</p>}
      </div>
      {spec.allowNew && (
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (!missing.trim()) return;
            void run(async () => {
              await send({ type: 'suggest', questionId: question.id, text: missing, ...who });
              setMissing('');
            }, 'Sent to the facilitator');
          }}
        >
          <span className="label">Something missing from the map?</span>
          <div className="row">
            <input className="input grow" value={missing} maxLength={200} placeholder="Name it" aria-label="Suggest something missing" onChange={(e) => setMissing(e.target.value)} />
            <button className="btn" disabled={busy || !missing.trim()}>
              Suggest
            </button>
          </div>
        </form>
      )}
      <MySuggestions view={view} question={question} participantId={participantId} send={send} />
      <DoneButtons {...props} hasContent={mine.size > 0} />
    </div>
  );
}
