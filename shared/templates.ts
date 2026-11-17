/**
 * Question templates → concrete questions.
 *
 * Questions are never hand-written per object. Whenever the map changes,
 * `syncQuestions` makes sure a draft question exists for every (template,
 * matching object) pair the current configuration asks for. The facilitator
 * then decides which ones to actually ask.
 */
import { listMethods, getMethod } from './calc/registry';
import type { AnswerSpec, QuestionTemplate, SubjectFilter, WorkshopConfig } from './config';
import type { Answer, AnswerBasis, ModelLink, ModelNode, Question, QuestionSubject, WorkshopState } from './types';

export function linkId(relation: 'influence' | 'requirement', from: string, to: string): string {
  return `l:${relation === 'influence' ? 'i' : 'r'}:${from}>${to}`;
}

export function subjectKey(subject: QuestionSubject): string {
  return subject.type === 'workshop' ? 'w' : subject.type === 'node' ? subject.nodeId : subject.linkId;
}

export function questionId(templateId: string, subject: QuestionSubject): string {
  return `q:${templateId}:${subjectKey(subject)}`;
}

/** Every template the app knows how to render: the config's, then those shipped by calculation methods (config wins on id clashes). */
export function knownTemplates(config: WorkshopConfig): QuestionTemplate[] {
  const result = [...config.templates];
  const ids = new Set(result.map((t) => t.id));
  const stageIds = new Set(config.stages.map((s) => s.id));
  const lastStage = config.stages[config.stages.length - 1]!.id;
  const fallbackStage = stageIds.has('estimates') ? 'estimates' : lastStage;
  for (const method of listMethods()) {
    for (const t of method.elicitation) {
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      result.push(stageIds.has(t.stageId) ? t : { ...t, stageId: fallbackStage });
    }
  }
  return result;
}

/** Templates that should currently produce draft questions. */
export function generatingTemplates(config: WorkshopConfig): QuestionTemplate[] {
  const method = getMethod(config.calculation.methodId);
  const consumed = new Set(method?.consumes ?? []);
  const methodTemplateIds = new Set((method?.elicitation ?? []).map((t) => t.id));
  const configIds = new Set(config.templates.map((t) => t.id));
  return knownTemplates(config).filter((t) => {
    // A method's own templates only apply while that method is selected.
    if (!configIds.has(t.id) && !methodTemplateIds.has(t.id)) return false;
    if (t.generate === 'always') return true;
    if (t.generate === 'when-method-requires') return !!t.role && consumed.has(t.role);
    return false;
  });
}

export function findTemplate(config: WorkshopConfig, id: string): QuestionTemplate | undefined {
  return knownTemplates(config).find((t) => t.id === id);
}

function activeNode(state: WorkshopState, id: string): ModelNode | undefined {
  const n = state.nodes[id];
  return n && n.status === 'active' ? n : undefined;
}

export function activeLink(state: WorkshopState, id: string): ModelLink | undefined {
  const l = state.links[id];
  if (!l || l.status !== 'active') return undefined;
  return activeNode(state, l.from) && activeNode(state, l.to) ? l : undefined;
}

export function matchesFilter(state: WorkshopState, filter: SubjectFilter, subject: QuestionSubject): boolean {
  if (filter.type === 'workshop') return subject.type === 'workshop';
  if (filter.type === 'node') {
    if (subject.type !== 'node') return false;
    const n = activeNode(state, subject.nodeId);
    if (!n || !filter.kinds.includes(n.kind)) return false;
    // Goal candidates that were not chosen do not get follow-up questions.
    return n.kind !== 'goal' || state.goal.nodeId === n.id;
  }
  if (subject.type !== 'link') return false;
  const l = activeLink(state, subject.linkId);
  if (!l || !filter.relations.includes(l.relation)) return false;
  return !filter.fromKinds || filter.fromKinds.includes(state.nodes[l.from]!.kind);
}

function subjectsFor(state: WorkshopState, filter: SubjectFilter): QuestionSubject[] {
  if (filter.type === 'workshop') return [{ type: 'workshop' }];
  if (filter.type === 'node')
    return Object.values(state.nodes)
      .map((n): QuestionSubject => ({ type: 'node', nodeId: n.id }))
      .filter((s) => matchesFilter(state, filter, s));
  return Object.values(state.links)
    .map((l): QuestionSubject => ({ type: 'link', linkId: l.id }))
    .filter((s) => matchesFilter(state, filter, s));
}

function subjectStillThere(state: WorkshopState, subject: QuestionSubject): boolean {
  if (subject.type === 'workshop') return true;
  if (subject.type === 'node') return !!activeNode(state, subject.nodeId);
  return !!activeLink(state, subject.linkId);
}

/**
 * Bring the set of questions in line with the map and the configuration.
 * Never deletes a question or an answer: questions whose object has gone are
 * marked superseded and come back if the object does.
 */
export function syncQuestions(state: WorkshopState, at: string): void {
  const generating = generatingTemplates(state.config);
  const generatingIds = new Set(generating.map((t) => t.id));
  const known = new Map(knownTemplates(state.config).map((t) => [t.id, t]));

  for (const t of generating) {
    for (const subject of subjectsFor(state, t.subject)) {
      const id = questionId(t.id, subject);
      if (!state.questions[id]) {
        state.questions[id] = { id, templateId: t.id, subject, status: 'draft', revealed: false, createdAt: at, rounds: 0 };
      }
    }
  }

  for (const q of Object.values(state.questions)) {
    const template = q.custom ? undefined : known.get(q.templateId);
    const valid = q.custom ? subjectStillThere(state, q.subject) : !!template && matchesFilter(state, template.subject, q.subject);
    if (!valid) {
      if (q.status !== 'superseded') {
        if (state.liveQuestionId === q.id) state.liveQuestionId = null;
        q.status = 'superseded';
        delete q.queuedAt;
      }
      continue;
    }
    if (q.status === 'superseded') q.status = q.rounds > 0 ? 'closed' : 'draft';
    // Drafts that only existed because of a previously selected method step aside (and return if it is selected again).
    if (template && template.generate === 'when-method-requires') {
      const wanted = generatingIds.has(template.id);
      if (!wanted && q.status === 'draft' && q.rounds === 0) {
        q.status = 'dismissed';
        q.autoDismissed = true;
        delete q.queuedAt;
      } else if (wanted && q.status === 'dismissed' && q.autoDismissed) {
        q.status = 'draft';
        delete q.autoDismissed;
      }
    }
  }
}

export interface RenderedQuestion {
  title: string;
  prompt: string;
  help?: string;
  answer: AnswerSpec;
  stageId: string;
  allowUnsure: boolean;
  role?: string;
  version: number;
  usesContext: boolean;
  /** Short description of what the question is about, for lists. */
  about: string;
  /** False when the template has gone from the configuration; the question can still be read but not asked. */
  known: boolean;
}

const CONTEXT_PLACEHOLDER = /\{(goal|horizon|success)\}/;

export function nodeLabel(state: WorkshopState, id: string): string {
  return state.nodes[id]?.label ?? '(removed)';
}

export function fillPlaceholders(state: WorkshopState, text: string, subject: QuestionSubject): string {
  const goalLabel = state.goal.nodeId ? nodeLabel(state, state.goal.nodeId) : 'the goal';
  const values: Record<string, string> = {
    goal: goalLabel,
    horizon: state.goal.horizon.trim() || 'the agreed time horizon',
    success: state.goal.successDefinition.trim() || 'the goal is achieved',
  };
  if (subject.type === 'node') values.subject = nodeLabel(state, subject.nodeId);
  if (subject.type === 'link') {
    const l = state.links[subject.linkId];
    values.from = l ? nodeLabel(state, l.from) : '(removed)';
    values.to = l ? nodeLabel(state, l.to) : '(removed)';
    values.subject = `${values.from} → ${values.to}`;
  }
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

export function aboutSubject(state: WorkshopState, subject: QuestionSubject): string {
  if (subject.type === 'workshop') return 'Whole workshop';
  if (subject.type === 'node') return nodeLabel(state, subject.nodeId);
  const l = state.links[subject.linkId];
  return l ? `${nodeLabel(state, l.from)} → ${nodeLabel(state, l.to)}` : '(removed link)';
}

export function renderQuestion(state: WorkshopState, q: Question): RenderedQuestion {
  const about = aboutSubject(state, q.subject);
  if (q.custom) {
    return {
      title: 'Custom question',
      prompt: fillPlaceholders(state, q.custom.prompt, q.subject),
      help: q.custom.help ? fillPlaceholders(state, q.custom.help, q.subject) : undefined,
      answer: q.custom.answer,
      stageId: q.custom.stageId,
      allowUnsure: true,
      version: 1,
      usesContext: CONTEXT_PLACEHOLDER.test(q.custom.prompt),
      about,
      known: true,
    };
  }
  const t = findTemplate(state.config, q.templateId);
  if (!t) {
    return {
      title: 'Retired question',
      prompt: `(This question’s wording was removed from the configuration: ${q.templateId})`,
      answer: { type: 'text' },
      stageId: state.config.stages[0]!.id,
      allowUnsure: true,
      version: 0,
      usesContext: false,
      about,
      known: false,
    };
  }
  return {
    title: t.title,
    prompt: fillPlaceholders(state, t.prompt, q.subject),
    help: t.help ? fillPlaceholders(state, t.help, q.subject) : undefined,
    answer: t.answer,
    stageId: t.stageId,
    allowUnsure: t.allowUnsure,
    role: t.role,
    version: t.version,
    usesContext: CONTEXT_PLACEHOLDER.test(t.prompt) || CONTEXT_PLACEHOLDER.test(t.help ?? ''),
    about,
    known: true,
  };
}

/** What an answer given right now would be "given against". */
export function currentBasis(state: WorkshopState, q: Question): AnswerBasis {
  const r = renderQuestion(state, q);
  const nodes: Record<string, number> = {};
  if (q.subject.type === 'node') {
    const n = state.nodes[q.subject.nodeId];
    if (n) nodes[n.id] = n.meaningRev;
  } else if (q.subject.type === 'link') {
    const l = state.links[q.subject.linkId];
    for (const id of l ? [l.from, l.to] : []) {
      const n = state.nodes[id];
      if (n) nodes[n.id] = n.meaningRev;
    }
  }
  const basis: AnswerBasis = { nodes, template: r.version };
  if (r.usesContext) basis.context = state.goal.contextRev;
  return basis;
}

/** Why an answer should be looked at again, or null if it still stands on current definitions. */
export function staleReason(state: WorkshopState, q: Question, answer: Answer): string | null {
  if (answer.needsReview) return answer.needsReview;
  const now = currentBasis(state, q);
  if (now.template !== answer.basis.template) return 'The wording of this question has changed since this answer.';
  for (const [id, rev] of Object.entries(now.nodes)) {
    if (answer.basis.nodes[id] !== rev) return `The definition of “${nodeLabel(state, id)}” has changed since this answer.`;
  }
  if (now.context !== undefined && answer.basis.context !== now.context) return 'The goal, its success definition or the time horizon has changed since this answer.';
  return null;
}

export function latestAnswer(state: WorkshopState, questionIdValue: string, participantId: string): Answer | undefined {
  const list = state.answers[questionIdValue]?.[participantId];
  return list && list.length ? list[list.length - 1] : undefined;
}
