/** Workshop configuration editor: wording, stages, question templates, methods. Edits a draft; the server validates on save. */
import { useState } from 'react';
import { getAggregation, listAggregations } from '@shared/aggregate/registry';
import { getMethod, listMethods } from '@shared/calc/registry';
import { parseConfig, type QuestionTemplate, type WorkshopConfig } from '@shared/config';
import type { WorkshopView } from '@shared/types';
import { downloadJson, slug } from '../lib/api';
import { Modal, useAction } from '../lib/ui';
import { ExampleDiagram } from './ResultsPanel';
import { MethodNotes, SettingsForm } from './SettingsForm';

type Send = (command: Record<string, unknown>) => Promise<void>;
type Section = 'wording' | 'stages' | 'questions' | 'methods' | 'privacy' | 'advanced';

const SECTIONS: [Section, string][] = [
  ['wording', 'Wording and colours'],
  ['stages', 'Stages'],
  ['questions', 'Questions'],
  ['methods', 'Methods'],
  ['privacy', 'Privacy and limits'],
  ['advanced', 'Advanced'],
];

function newId(prefix: string, taken: string[]): string {
  for (let i = 1; ; i++) if (!taken.includes(`${prefix}-${i}`)) return `${prefix}-${i}`;
}

export function ConfigEditor({ view, send, onClose }: { view: WorkshopView; send: Send; onClose: () => void }) {
  const [draft, setDraft] = useState<WorkshopConfig>(() => structuredClone(view.config));
  const [section, setSection] = useState<Section>('wording');
  const [json, setJson] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const { busy, run } = useAction();
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.config);
  const set = (change: (c: WorkshopConfig) => void) =>
    setDraft((d) => {
      const next = structuredClone(d);
      change(next);
      return next;
    });
  const save = () => {
    const checked = parseConfig(draft);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems([]);
    void run(async () => {
      try {
        await send({ type: 'set_config', config: checked.config });
        onClose();
      } catch (err) {
        setProblems((err as Error).message.split('\n'));
        throw new Error('The configuration was not saved. See the problems listed.');
      }
    }, 'Configuration saved');
  };
  const method = getMethod(draft.calculation.methodId);
  const aggregation = getAggregation(draft.aggregation.methodId);

  return (
    <Modal
      title="Workshop configuration"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="small muted grow">{dirty ? 'Unsaved changes' : 'No changes'}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
            Save configuration
          </button>
        </>
      }
    >
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-label="Configuration sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={section === id} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="stack">
          {problems.length > 0 && (
            <div className="banner banner-warn small">
              <strong>Please fix:</strong>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}

          {section === 'wording' && (
            <>
              <p className="small muted">The words used throughout for this workshop.</p>
              <div className="grid-2">
                {(Object.keys(draft.labels) as (keyof WorkshopConfig['labels'])[]).map((k) => (
                  <label key={k} className="field">
                    <span>{{ appName: 'App name', goal: 'A goal is called', state: 'A state is called', action: 'An action is called', influence: 'An arrow reads as', requirement: 'A requirement reads as', unsure: '“Not sure” button' }[k]}</span>
                    <input className="input" value={draft.labels[k]} onChange={(e) => set((c) => void (c.labels[k] = e.target.value))} />
                  </label>
                ))}
              </div>
              <div className="grid-2">
                {(Object.keys(draft.theme) as (keyof WorkshopConfig['theme'])[]).map((k) => (
                  <label key={k} className="field">
                    <span>{{ accent: 'Accent colour', goalColor: 'Goal colour', stateColor: 'State colour', actionColor: 'Action colour' }[k]}</span>
                    <input type="color" className="input" style={{ padding: 4 }} value={draft.theme[k]} onChange={(e) => set((c) => void (c.theme[k] = e.target.value))} />
                  </label>
                ))}
              </div>
            </>
          )}

          {section === 'stages' && (
            <>
              <p className="small muted">Stages are signposts for the group. They do not lock anything: any question can be asked at any time.</p>
              {draft.stages.map((s, i) => (
                <div key={s.id} className="tpl">
                  <div className="tpl-body" style={{ paddingTop: 14 }}>
                    <div className="row">
                      <span className="chip">{i + 1}</span>
                      <input className="input grow" aria-label="Stage title" value={s.title} onChange={(e) => set((c) => void (c.stages[i]!.title = e.target.value))} />
                      <button className="btn btn-sm" disabled={i === 0} aria-label="Move up" onClick={() => set((c) => void c.stages.splice(i - 1, 2, c.stages[i]!, c.stages[i - 1]!))}>
                        ↑
                      </button>
                      <button className="btn btn-sm" disabled={i === draft.stages.length - 1} aria-label="Move down" onClick={() => set((c) => void c.stages.splice(i, 2, c.stages[i + 1]!, c.stages[i]!))}>
                        ↓
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={draft.stages.length === 1 || draft.templates.some((t) => t.stageId === s.id)}
                        title={draft.templates.some((t) => t.stageId === s.id) ? 'Move its questions to another stage first' : undefined}
                        onClick={() => set((c) => void c.stages.splice(i, 1))}
                      >
                        Remove
                      </button>
                    </div>
                    <label className="field">
                      <span>Shown to participants</span>
                      <input className="input" value={s.description} onChange={(e) => set((c) => void (c.stages[i]!.description = e.target.value))} />
                    </label>
                    <label className="field">
                      <span>Hint for the organizer</span>
                      <textarea className="textarea" style={{ minHeight: 56 }} value={s.facilitatorHint} onChange={(e) => set((c) => void (c.stages[i]!.facilitatorHint = e.target.value))} />
                    </label>
                  </div>
                </div>
              ))}
              <div>
                <button className="btn btn-sm" onClick={() => set((c) => void c.stages.push({ id: newId('stage', c.stages.map((s) => s.id)), title: 'New stage', description: '', facilitatorHint: '' }))}>
                  Add a stage
                </button>
              </div>
            </>
          )}

          {section === 'questions' && (
            <>
              <p className="small muted">
                Question templates. A draft question is created automatically for every item or arrow a template applies to. Placeholders: {'{subject}'} {'{from}'} {'{to}'} {'{goal}'} {'{horizon}'} {'{success}'}.
              </p>
              {draft.templates.map((t, i) => (
                <TemplateEditor key={t.id} template={t} config={draft} onChange={(change) => set((c) => change(c.templates[i]!))} onRemove={() => set((c) => void c.templates.splice(i, 1))} />
              ))}
              <div className="row-wrap">
                {(['text', 'choice', 'probability'] as const).map((type) => (
                  <button
                    key={type}
                    className="btn btn-sm"
                    onClick={() =>
                      set((c) =>
                        void c.templates.push({
                          id: newId('question', c.templates.map((x) => x.id)),
                          title: 'New question',
                          prompt: 'About “{subject}”: …',
                          subject: { type: 'node', kinds: ['state'] },
                          answer: type === 'text' ? { type: 'text' } : type === 'probability' ? { type: 'probability', allowRange: true } : { type: 'choice', options: [{ value: 'a', label: 'First option' }, { value: 'b', label: 'Second option' }] },
                          stageId: c.stages[c.stages.length - 1]!.id,
                          generate: 'manual',
                          allowUnsure: true,
                          version: 1,
                        }),
                      )
                    }
                  >
                    Add a {type} question
                  </button>
                ))}
              </div>
              {method && method.elicitation.length > 0 && (
                <p className="small muted">
                  The selected calculation method also brings its own questions ({method.elicitation.map((t) => `“${t.title}”`).join(', ')}). To reword one, add a template here with the same id via Advanced.
                </p>
              )}
            </>
          )}

          {section === 'methods' && (
            <>
              <h3>Calculation method</h3>
              <p className="small muted">Decides which estimate questions are generated and how results are worked out. It can be changed at any time; answers already given are kept.</p>
              <select className="select" value={draft.calculation.methodId} aria-label="Calculation method" onChange={(e) => set((c) => void (c.calculation.methodId = e.target.value))}>
                {listMethods().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {method && (
                <>
                  <p className="small">{method.summary}</p>
                  <div className="stack-sm">
                    <h4>What it needs from people</h4>
                    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                      {method.requiredInputs.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                    <ExampleDiagram example={method.example} />
                  </div>
                  <MethodNotes assumptions={method.assumptions} limits={method.limits} />
                  <SettingsForm
                    fields={method.settingsFields}
                    value={{ ...(method.defaultSettings as object), ...((draft.calculation.settings[method.id] as object) ?? {}) }}
                    onChange={(next) => set((c) => void (c.calculation.settings[method.id] = next))}
                  />
                </>
              )}
              <hr />
              <h3>Pooling estimates when maps are combined</h3>
              <p className="small muted">The default for new combined maps. Each combined map can choose differently.</p>
              <select className="select" value={draft.aggregation.methodId} aria-label="Aggregation method" onChange={(e) => set((c) => void (c.aggregation = { methodId: e.target.value, settings: {} }))}>
                {listAggregations().map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {aggregation && (
                <>
                  <p className="small">{aggregation.summary}</p>
                  <MethodNotes assumptions={aggregation.assumptions} limits={aggregation.limits} />
                  <SettingsForm
                    fields={aggregation.settingsFields}
                    value={{ ...(aggregation.defaultSettings as object), ...(draft.aggregation.settings as object) }}
                    onChange={(next) => set((c) => void (c.aggregation.settings = next))}
                  />
                </>
              )}
            </>
          )}

          {section === 'privacy' && (
            <>
              <label className="check">
                <input type="checkbox" checked={draft.privacy.revealByDefault} onChange={(e) => set((c) => void (c.privacy.revealByDefault = e.target.checked))} />
                <span>
                  <strong>Show everyone’s answers as soon as a question is asked</strong>
                  <span className="muted small" style={{ display: 'block' }}>
                    Off by default, so people answer before seeing what others said. You can always reveal a question by hand.
                  </span>
                </span>
              </label>
              <label className="field" style={{ maxWidth: 240 }}>
                <span>Most participants allowed</span>
                <input className="input" type="number" min={1} max={50} value={draft.limits.maxParticipants} onChange={(e) => set((c) => void (c.limits.maxParticipants = Number(e.target.value)))} />
              </label>
            </>
          )}

          {section === 'advanced' && (
            <>
              <p className="small muted">The whole configuration as a file: keep it to reuse in another workshop, or edit it directly. It is checked before it is applied.</p>
              <div className="row-wrap">
                <button className="btn btn-sm" onClick={() => downloadJson(`${slug(view.title)}-configuration.json`, draft)}>
                  Download configuration
                </button>
                <button className="btn btn-sm" onClick={() => setJson(JSON.stringify(draft, null, 2))}>
                  Show as text
                </button>
              </div>
              {json && (
                <>
                  <textarea className="textarea code" style={{ minHeight: 320 }} spellCheck={false} value={json} aria-label="Configuration as JSON" onChange={(e) => setJson(e.target.value)} />
                  <div>
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        let parsed: unknown;
                        try {
                          parsed = JSON.parse(json);
                        } catch {
                          return setProblems(['That text is not valid JSON.']);
                        }
                        const checked = parseConfig(parsed);
                        if (!checked.ok) return setProblems(checked.problems);
                        setProblems([]);
                        setDraft(checked.config);
                      }}
                    >
                      Use this text
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const SUBJECT_WORDS = { workshop: 'the whole workshop', node: 'an item', link: 'an arrow' } as const;

function TemplateEditor({ template: t, config, onChange, onRemove }: { template: QuestionTemplate; config: WorkshopConfig; onChange: (change: (t: QuestionTemplate) => void) => void; onRemove: () => void }) {
  const protectedRole = t.role === 'link.stance';
  return (
    <details className="tpl">
      <summary>
        <span className="grow">
          <span style={{ fontWeight: 600 }}>{t.title}</span>
          <span className="small muted" style={{ display: 'block' }}>
            {t.prompt}
          </span>
        </span>
        <span className="chip">{config.stages.find((s) => s.id === t.stageId)?.title}</span>
      </summary>
      <div className="tpl-body">
        <div className="grid-2">
          <label className="field">
            <span>Short title</span>
            <input className="input" value={t.title} onChange={(e) => onChange((x) => void (x.title = e.target.value))} />
          </label>
          <label className="field">
            <span>Stage</span>
            <select className="select" value={t.stageId} onChange={(e) => onChange((x) => void (x.stageId = e.target.value))}>
              {config.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span>Wording</span>
          <textarea className="textarea" style={{ minHeight: 56 }} value={t.prompt} onChange={(e) => onChange((x) => void (x.prompt = e.target.value))} />
        </label>
        <label className="field">
          <span>Help text (optional)</span>
          <textarea className="textarea" style={{ minHeight: 56 }} value={t.help ?? ''} onChange={(e) => onChange((x) => void (x.help = e.target.value || undefined))} />
        </label>
        {t.answer.type === 'choice' && (
          <div className="stack-sm">
            <span className="label">Options {protectedRole ? '(the app relies on “yes” and “no”; “harms” and “conditional” are understood too)' : ''}</span>
            {t.answer.options.map((o, i) => (
              <div key={i} className="row">
                <input className="input code" style={{ maxWidth: 130 }} aria-label="Stored value" value={o.value} disabled={protectedRole && (o.value === 'yes' || o.value === 'no')} onChange={(e) => onChange((x) => void (x.answer.type === 'choice' && (x.answer.options[i]!.value = e.target.value)))} />
                <input className="input grow" aria-label="Shown as" value={o.label} onChange={(e) => onChange((x) => void (x.answer.type === 'choice' && (x.answer.options[i]!.label = e.target.value)))} />
                <button className="btn btn-sm" disabled={t.answer.type === 'choice' && (t.answer.options.length <= 2 || (protectedRole && (o.value === 'yes' || o.value === 'no')))} onClick={() => onChange((x) => void (x.answer.type === 'choice' && x.answer.options.splice(i, 1)))}>
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button className="btn btn-sm" onClick={() => onChange((x) => void (x.answer.type === 'choice' && x.answer.options.push({ value: `option-${x.answer.options.length + 1}`, label: 'Another option' })))}>
                Add option
              </button>
            </div>
          </div>
        )}
        <div className="grid-2">
          <label className="field">
            <span>When to create it</span>
            <select className="select" value={t.generate} onChange={(e) => onChange((x) => void (x.generate = e.target.value as QuestionTemplate['generate']))} disabled={protectedRole}>
              <option value="always">For every matching {t.subject.type === 'link' ? 'arrow' : 'item'}</option>
              <option value="when-method-requires">Only when the calculation method needs it</option>
              <option value="manual">Only when I add it by hand</option>
            </select>
          </label>
          <div className="field">
            <span>About</span>
            <div className="small" style={{ paddingTop: 9 }}>
              {SUBJECT_WORDS[t.subject.type]}
              {t.subject.type === 'node' ? ` (${t.subject.kinds.map((k) => config.labels[k].toLowerCase()).join(', ')})` : ''}
              {t.subject.type === 'link' ? ` (${t.subject.relations.join(', ')})` : ''}
              {' · '}
              {t.answer.type === 'suggestions' ? `collects suggestions for new ${config.labels[t.answer.creates.nodeKind].toLowerCase()}s` : t.answer.type === 'nominate-links' ? 'collects connections' : `${t.answer.type} answer`}
            </div>
          </div>
        </div>
        <label className="check small">
          <input type="checkbox" checked={t.allowUnsure} onChange={(e) => onChange((x) => void (x.allowUnsure = e.target.checked))} />
          <span>Offer “not sure”</span>
        </label>
        <div className="row-wrap">
          <button className="btn btn-sm" title="Use this after changing what the question means. Earlier answers are kept and flagged for review." onClick={() => onChange((x) => void (x.version += 1))}>
            The meaning changed: flag earlier answers (wording version {t.version})
          </button>
          {!protectedRole && (
            <button className="btn btn-sm btn-danger" onClick={onRemove}>
              Remove template
            </button>
          )}
        </div>
        <div className="tiny muted code">
          id: {t.id}
          {t.role ? ` · role: ${t.role}` : ''}
        </div>
      </div>
    </details>
  );
}
