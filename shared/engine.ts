/**
 * The workshop engine: one function that applies a command to the state.
 * It checks who is allowed to do what, validates against the current state,
 * and mutates. The server runs it on a copy and keeps the copy only if it
 * succeeds; replaying stored commands through it rebuilds a workshop exactly.
 */
import { getAggregation, resolveAggregationSettings } from './aggregate/registry';
import { getMethod, resolveSettings } from './calc/registry';
import { evaluateMethod, type FormulaEngine, type FormulaProgram, type ParticipantModel } from './calc/types';
import { describeLoop, findLoop, loopIfAdded, type Arrow } from './cycles';
import { buildSynthesisModel, previewSynthesis, SYNTHESIS_PREFIX } from './synthesis';
import type { ClientCommand, Command, SystemCommand } from './commands';
import { parseConfig, ROLES, type AnswerSpec, type WorkshopConfig } from './config';
import { buildParticipantModel } from './model';
import {
  activeLink,
  currentBasis,
  findTemplate,
  knownTemplates,
  latestAnswer,
  linkId,
  matchesFilter,
  nodeLabel,
  questionId,
  renderQuestion,
  syncQuestions,
} from './templates';
import {
  CommandError,
  type Actor,
  type Answer,
  type AnswerSource,
  type AnswerValue,
  type Layer,
  type ModelLink,
  type ModelNode,
  type NodeKind,
  type Question,
  type Relation,
  type WorkshopState,
} from './types';

export interface Env {
  actor: Actor;
  at: string;
  seq: number;
}

const MAX_RUNS = 20;
const MAX_SYNTHESIS_VERSIONS = 30;
/** Answers to a "do you hold this arrow" question that put the arrow in the person's map. */
const HOLDING = new Set(['yes', 'harms', 'conditional']);
const KIND_LAYER: Record<NodeKind, Layer> = { goal: 'goals', state: 'states', action: 'actions' };

export function defaultSettings(mode: 'workshop' | 'solo'): WorkshopState['settings'] {
  const solo = mode === 'solo';
  return {
    shareModels: false,
    layers: {
      // The catalogue of goals, states and actions is shared by default; arrows and estimates start personal.
      goals: { open: solo, pooled: true },
      states: { open: solo, pooled: true },
      actions: { open: solo, pooled: true },
      connections: { open: solo, pooled: false },
      estimates: { open: solo, pooled: false },
    },
  };
}
const MAX_HISTORY = 2000;

export function emptyState(id: string, config: WorkshopConfig): WorkshopState {
  return {
    id,
    title: '',
    createdAt: '',
    seq: 0,
    modelRev: 0,
    isExample: false,
    mode: 'workshop',
    config,
    settings: defaultSettings('workshop'),
    stageId: config.stages[0]!.id,
    goal: { nodeId: null, successDefinition: '', horizon: '', contextRev: 0 },
    participants: {},
    nodes: {},
    links: {},
    questions: {},
    liveQuestionId: null,
    suggestions: {},
    answers: {},
    runs: [],
    syntheses: {},
    history: [],
  };
}

/**
 * Turn a "run calculation" request into a stored record, computing every model's result separately.
 * Asynchronous because the arithmetic is done by a formula engine; the caller must check the
 * workshop has not moved on before storing the record.
 */
export async function prepareRun(state: WorkshopState, cmd: Extract<ClientCommand, { type: 'run_calculation' }>, engine: FormulaEngine): Promise<SystemCommand> {
  const method = getMethod(cmd.methodId);
  if (!method) throw new CommandError('not-found', `There is no calculation method called "${cmd.methodId}".`);
  if (method.requiresAcknowledgement && !cmd.acknowledged)
    throw new CommandError('invalid', 'This method rests on assumptions that must be acknowledged before it runs.');
  const resolved = resolveSettings(method, cmd.settings ?? state.config.calculation.settings[method.id]);
  if (!resolved.ok) throw new CommandError('invalid', `Method settings are not valid: ${resolved.problems.join('; ')}`);
  const outputs: Record<string, import('./calc/types').MethodOutput> = {};
  const programs: Record<string, { code: string; sources: FormulaProgram['sources'] }> = {};
  const evaluate = async (key: string, model: ParticipantModel) => {
    const { output, program } = await evaluateMethod(method, model, resolved.settings, engine);
    outputs[key] = output;
    if (program) programs[key] = { code: program.code, sources: program.sources };
  };
  for (const p of Object.values(state.participants)) await evaluate(p.id, buildParticipantModel(state, p.id));
  // Combined models are calculated from their pooled inputs, as models in their own right — never by averaging the results above.
  const synthesisVersions: Record<string, number> = {};
  for (const syn of Object.values(state.syntheses)) {
    if (syn.archived) continue;
    await evaluate(`${SYNTHESIS_PREFIX}${syn.id}`, buildSynthesisModel(state, syn.id));
    synthesisVersions[syn.id] = syn.version;
  }
  return {
    type: 'record_run',
    methodId: method.id,
    methodVersion: method.version,
    settings: resolved.settings,
    assumptions: method.assumptions,
    outputs,
    synthesisVersions,
    engine: { id: engine.id, version: engine.version, sampling: engine.sampling },
    programs,
    modelRev: state.modelRev,
  };
}

export function who(state: WorkshopState, actor: Actor): string {
  if (actor.type === 'facilitator') return 'Facilitator';
  if (actor.type === 'system') return 'System';
  return state.participants[actor.id]?.name ?? 'Someone';
}

function requireFacilitator(env: Env): void {
  if (env.actor.type === 'participant') throw new CommandError('forbidden', 'Only the facilitator can do that.');
}

/** Whose answer is this? Participants act for themselves; the facilitator must name someone. */
function actingFor(state: WorkshopState, env: Env, named?: string): string {
  if (env.actor.type === 'participant') {
    if (named && named !== env.actor.id) throw new CommandError('forbidden', 'You can only change your own answers.');
    if (!state.participants[env.actor.id]) throw new CommandError('not-found', 'You are not part of this workshop.');
    return env.actor.id;
  }
  if (!named && state.mode === 'solo') {
    const only = Object.keys(state.participants)[0];
    if (only) return only;
  }
  if (!named || !state.participants[named]) throw new CommandError('invalid', 'Say which participant this is for.');
  return named;
}

function getQuestion(state: WorkshopState, id: string): Question {
  const q = state.questions[id];
  if (!q) throw new CommandError('not-found', 'That question no longer exists.');
  return q;
}

function getNode(state: WorkshopState, id: string, mustBeActive = true): ModelNode {
  const n = state.nodes[id];
  if (!n) throw new CommandError('not-found', 'That item is not on the map.');
  if (mustBeActive && n.status !== 'active') throw new CommandError('conflict', `“${n.label}” is no longer active on the map.`);
  return n;
}

/** Can this actor respond to this question right now? */
function requireOpenFor(state: WorkshopState, env: Env, q: Question): void {
  if (q.status === 'superseded') throw new CommandError('conflict', 'That question is about something that has been merged or removed.');
  if (env.actor.type !== 'participant') return;
  if (q.status === 'live' || (q.status === 'closed' && q.rounds > 0)) return;
  if (state.settings.layers[questionLayer(state, q)].open && q.status !== 'dismissed') return;
  throw new CommandError('forbidden', 'That question is not open yet.');
}

/** Which of the organizer's five layers a question belongs to. */
export function questionLayer(state: WorkshopState, q: Question): Layer {
  const r = renderQuestion(state, q);
  if (r.role === ROLES.linkStance || r.answer.type === 'nominate-links') return 'connections';
  if (r.answer.type === 'suggestions') return KIND_LAYER[r.answer.creates.nodeKind];
  return 'estimates';
}

/** The arrows one person currently holds, across the whole map (nothing hidden or collapsed is skipped). */
export function heldArrows(state: WorkshopState, participantId: string, exceptLinkId?: string): Arrow[] {
  const result: Arrow[] = [];
  for (const link of Object.values(state.links)) {
    if (link.id === exceptLinkId || !activeLink(state, link.id)) continue;
    const q = stanceQuestion(state, link);
    const a = q ? latestAnswer(state, q.id, participantId) : undefined;
    if (a?.value.kind === 'choice' && HOLDING.has(a.value.choice)) result.push({ from: link.from, to: link.to });
  }
  return result;
}

function refuseLoop(state: WorkshopState, loop: string[], whose: string): never {
  throw new CommandError(
    'conflict',
    `That would make a loop in ${whose} map: ${describeLoop(loop, (id) => nodeLabel(state, id))}. Loops are not supported yet, so nothing was changed.`,
  );
}

function validateValue(state: WorkshopState, spec: AnswerSpec, allowUnsure: boolean, value: AnswerValue): void {
  if (value.kind === 'unsure') {
    if (!allowUnsure) throw new CommandError('invalid', 'This question needs an answer.');
    return;
  }
  const openEnded = spec.type === 'suggestions' || spec.type === 'nominate-links';
  if (value.kind === 'done') {
    if (!openEnded) throw new CommandError('invalid', 'That kind of answer does not fit this question.');
    return;
  }
  if (openEnded) throw new CommandError('invalid', 'Add your ideas one at a time for this question.');
  if (value.kind !== spec.type) throw new CommandError('invalid', 'That kind of answer does not fit this question.');
  if (value.kind === 'choice' && spec.type === 'choice') {
    if (!spec.options.some((o) => o.value === value.choice)) throw new CommandError('invalid', 'That is not one of the options.');
  } else if (value.kind === 'pick-node' && spec.type === 'pick-node') {
    const n = state.nodes[value.nodeId];
    if (!n || n.status !== 'active' || !spec.kinds.includes(n.kind)) throw new CommandError('invalid', 'That is not one of the options.');
  } else if (value.kind === 'probability' && spec.type === 'probability') {
    const hasLow = value.low !== undefined;
    const hasHigh = value.high !== undefined;
    if (hasLow !== hasHigh) throw new CommandError('invalid', 'A range needs both a low and a high end.');
    if (hasLow && !spec.allowRange) throw new CommandError('invalid', 'This question takes a single number.');
    if (hasLow && !(value.low! <= value.p && value.p <= value.high!)) throw new CommandError('invalid', 'The best guess must sit inside the range.');
  } else if (value.kind === 'difference' && spec.type === 'difference') {
    const hasLow = value.low !== undefined;
    if (hasLow !== (value.high !== undefined)) throw new CommandError('invalid', 'A range needs both a low and a high end.');
    if (hasLow && !spec.allowRange) throw new CommandError('invalid', 'This question takes a single number.');
    if (hasLow && !(value.low! <= value.d && value.d <= value.high!)) throw new CommandError('invalid', 'The best guess must sit inside the range.');
  }
}

function pushAnswer(
  state: WorkshopState,
  env: Env,
  q: Question,
  participantId: string,
  value: AnswerValue,
  source: AnswerSource,
  reasoning?: string,
  extra?: Partial<Answer>,
): Answer {
  // Holding an arrow must never close a loop in that person's map — whatever route the answer arrives by.
  if (q.subject.type === 'link' && value.kind === 'choice' && HOLDING.has(value.choice) && renderQuestion(state, q).role === ROLES.linkStance) {
    const link = state.links[q.subject.linkId];
    const loop = link ? loopIfAdded(heldArrows(state, participantId, link.id), link) : null;
    if (loop) refuseLoop(state, loop, env.actor.type === 'participant' ? 'your' : `${state.participants[participantId]?.name ?? 'this person'}’s`);
  }
  const byParticipant = (state.answers[q.id] ??= {});
  const list = (byParticipant[participantId] ??= []);
  const answer: Answer = {
    questionId: q.id,
    participantId,
    revision: list.length + 1,
    value,
    reasoning: reasoning || undefined,
    basis: currentBasis(state, q),
    source,
    enteredBy: env.actor,
    at: env.at,
    ...extra,
  };
  list.push(answer);
  state.modelRev++;
  return answer;
}

/** The question through which people say whether they hold a given link. */
function stanceQuestion(state: WorkshopState, link: ModelLink): Question | undefined {
  for (const t of knownTemplates(state.config)) {
    if (t.role !== ROLES.linkStance || !matchesFilter(state, t.subject, { type: 'link', linkId: link.id })) continue;
    const q = state.questions[questionId(t.id, { type: 'link', linkId: link.id })];
    if (q) return q;
  }
  return undefined;
}

/**
 * Proposing a link is itself a claim by the proposer — and by nobody else.
 * Everyone else stays "not reviewed" until they say otherwise.
 */
function recordProposerStance(state: WorkshopState, env: Env, link: ModelLink, participantId: string, choice: string, mechanism?: string, overwrite = false): void {
  const q = stanceQuestion(state, link);
  if (!q) return;
  const existing = latestAnswer(state, q.id, participantId);
  if (existing && !overwrite) return;
  const t = findTemplate(state.config, q.templateId);
  const allowed = t?.answer.type === 'choice' ? t.answer.options.map((o) => o.value) : ['yes'];
  pushAnswer(state, env, q, participantId, { kind: 'choice', choice: allowed.includes(choice) ? choice : 'yes' }, 'proposal', mechanism);
}

function ensureLink(state: WorkshopState, env: Env, from: string, to: string, relation: Relation, detail: Record<string, string>): ModelLink {
  if (from === to) throw new CommandError('invalid', 'Something cannot be linked to itself.');
  const id = linkId(relation, from, to);
  const existing = state.links[id];
  if (existing) {
    if (existing.status !== 'active') {
      existing.status = 'active';
      delete existing.mergedInto;
      existing.provenance.push({ at: env.at, actor: env.actor, event: 'restored', detail });
    } else if (detail.suggestionId) {
      existing.provenance.push({ at: env.at, actor: env.actor, event: 'from-suggestion', detail });
    }
    return existing;
  }
  const link: ModelLink = {
    id,
    from,
    to,
    relation,
    status: 'active',
    createdAt: env.at,
    provenance: [{ at: env.at, actor: env.actor, event: 'created', detail }],
  };
  state.links[id] = link;
  state.modelRev++;
  return link;
}

function createNode(state: WorkshopState, env: Env, k: number, kind: NodeKind, label: string, definition: string, provenance: ModelNode['provenance']): ModelNode {
  const id = `n${env.seq}${k ? `_${k}` : ''}`;
  const node: ModelNode = { id, kind, label, definition, status: 'active', meaningRev: 1, createdAt: env.at, updatedAt: env.at, provenance };
  state.nodes[id] = node;
  state.modelRev++;
  return node;
}

function closeLive(state: WorkshopState, env: Env): void {
  const live = state.liveQuestionId ? state.questions[state.liveQuestionId] : undefined;
  if (live && live.status === 'live') {
    live.status = 'closed';
    live.closedAt = env.at;
  }
  state.liveQuestionId = null;
}

/** What kind of thing, and which link, a suggestion on this question turns into. */
function suggestionTarget(spec: AnswerSpec): { nodeKind: NodeKind; linkRelation?: Relation } | null {
  if (spec.type === 'suggestions') return spec.creates;
  if (spec.type === 'nominate-links' && spec.allowNew) return { nodeKind: spec.allowNew, linkRelation: 'influence' };
  return null;
}

/**
 * Apply one command. Throws CommandError without side effects that matter
 * (callers run it on a copy). Returns a one-line, content-free summary for the history.
 */
export function execute(state: WorkshopState, env: Env, cmd: Command): string {
  const summary = apply(state, env, cmd);
  state.seq = env.seq;
  syncQuestions(state, env.at);
  if (cmd.type !== 'move_nodes') {
    state.history.push({ seq: env.seq, at: env.at, actor: env.actor, type: cmd.type, summary });
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
  }
  return summary;
}

function apply(state: WorkshopState, env: Env, cmd: Command): string {
  const actorName = who(state, env.actor);
  switch (cmd.type) {
    case 'create': {
      if (env.actor.type !== 'system') throw new CommandError('forbidden', 'Not allowed.');
      state.title = cmd.title;
      state.createdAt = env.at;
      state.config = cmd.config;
      state.isExample = cmd.isExample;
      state.mode = cmd.mode ?? 'workshop';
      state.settings = defaultSettings(state.mode);
      state.stageId = cmd.config.stages[0]!.id;
      return `Workshop “${cmd.title}” created`;
    }
    case 'join': {
      if (env.actor.type !== 'system') throw new CommandError('forbidden', 'Not allowed.');
      if (state.participants[cmd.participantId]) throw new CommandError('conflict', 'Already joined.');
      state.participants[cmd.participantId] = {
        id: cmd.participantId,
        name: cmd.name,
        joinedAt: env.at,
        active: cmd.active ?? true,
        colorIndex: Object.keys(state.participants).length,
      };
      state.modelRev++;
      return `${cmd.name} joined`;
    }
    case 'record_run': {
      if (env.actor.type === 'participant') throw new CommandError('forbidden', 'Only the facilitator can run a calculation.');
      state.runs.push({
        id: `r${env.seq}`,
        at: env.at,
        by: env.actor,
        methodId: cmd.methodId,
        methodVersion: cmd.methodVersion,
        settings: cmd.settings,
        assumptions: cmd.assumptions,
        modelRev: cmd.modelRev ?? state.modelRev,
        outputs: cmd.outputs,
        synthesisVersions: cmd.synthesisVersions,
        engine: cmd.engine,
        programs: cmd.programs,
      });
      if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
      return `Calculation run with “${getMethod(cmd.methodId)?.name ?? cmd.methodId}” (version ${cmd.methodVersion})`;
    }

    case 'answer': {
      const pid = actingFor(state, env, cmd.participantId);
      const q = getQuestion(state, cmd.questionId);
      requireOpenFor(state, env, q);
      const r = renderQuestion(state, q);
      if (!r.known) throw new CommandError('conflict', 'That question’s wording has been removed from the configuration.');
      validateValue(state, r.answer, r.allowUnsure, cmd.value);
      const source: AnswerSource =
        env.actor.type !== 'participant' ? (state.mode === 'solo' ? 'explorer' : 'on-behalf') : cmd.via === 'explorer' ? 'explorer' : q.status === 'live' ? 'live' : 'revisit';
      pushAnswer(state, env, q, pid, cmd.value, source, cmd.reasoning);
      const name = state.participants[pid]!.name;
      return env.actor.type === 'participant' || state.mode === 'solo' ? `${name} answered “${r.title}” (${r.about})` : `Facilitator entered an answer for ${name} on “${r.title}” (${r.about})`;
    }
    case 'confirm_answer': {
      const pid = actingFor(state, env, cmd.participantId);
      const q = getQuestion(state, cmd.questionId);
      if (q.status === 'superseded') throw new CommandError('conflict', 'That question is about something that has been merged or removed.');
      const last = latestAnswer(state, q.id, pid);
      if (!last) throw new CommandError('not-found', 'There is no answer to confirm.');
      pushAnswer(state, env, q, pid, last.value, 'confirmed', last.reasoning);
      return `${state.participants[pid]!.name} confirmed an earlier answer still stands (${renderQuestion(state, q).about})`;
    }
    case 'suggest': {
      const pid = actingFor(state, env, cmd.participantId);
      const q = getQuestion(state, cmd.questionId);
      requireOpenFor(state, env, q);
      if (!suggestionTarget(renderQuestion(state, q).answer)) throw new CommandError('invalid', 'This question does not take suggestions.');
      const duplicate = Object.values(state.suggestions).some(
        (s) => s.questionId === q.id && s.participantId === pid && s.status === 'pending' && s.text.toLowerCase() === cmd.text.toLowerCase(),
      );
      if (duplicate) throw new CommandError('conflict', 'You have already suggested that.');
      const id = `s${env.seq}`;
      state.suggestions[id] = { id, questionId: q.id, participantId: pid, text: cmd.text, status: 'pending', at: env.at };
      return `${state.participants[pid]!.name} added a suggestion`;
    }
    case 'edit_suggestion':
    case 'withdraw_suggestion': {
      const s = state.suggestions[cmd.suggestionId];
      if (!s) throw new CommandError('not-found', 'That suggestion no longer exists.');
      if (env.actor.type === 'participant' && s.participantId !== env.actor.id) throw new CommandError('forbidden', 'You can only change your own suggestions.');
      if (s.status !== 'pending') throw new CommandError('conflict', 'That suggestion has already been dealt with.');
      if (cmd.type === 'edit_suggestion') s.text = cmd.text;
      else s.status = 'withdrawn';
      return `${actorName} ${cmd.type === 'edit_suggestion' ? 'reworded' : 'withdrew'} a suggestion`;
    }
    case 'nominate_link': {
      const pid = actingFor(state, env, cmd.participantId);
      const q = getQuestion(state, cmd.questionId);
      requireOpenFor(state, env, q);
      const spec = renderQuestion(state, q).answer;
      if (spec.type !== 'nominate-links' || q.subject.type !== 'node') throw new CommandError('invalid', 'This question does not take connections.');
      const target = getNode(state, q.subject.nodeId);
      const source = getNode(state, cmd.sourceNodeId);
      if (cmd.as === 'withdraw') {
        for (const relation of ['influence', 'requirement'] as const) {
          const existing = activeLink(state, linkId(relation, source.id, target.id));
          const sq = existing ? stanceQuestion(state, existing) : undefined;
          if (sq && latestAnswer(state, sq.id, pid)) pushAnswer(state, env, sq, pid, { kind: 'choice', choice: 'no' }, 'revisit');
        }
        return `${state.participants[pid]!.name} took back a proposed connection into “${target.label}”`;
      }
      if (!spec.sourceKinds.includes(source.kind)) throw new CommandError('invalid', 'That kind of item cannot be picked here.');
      if (cmd.as === 'harms' && !spec.allowHarmful) throw new CommandError('invalid', 'This question does not take harmful connections.');
      if (cmd.as === 'required' && !spec.allowRequirement) throw new CommandError('invalid', 'This question does not take requirements.');
      const relation: Relation = cmd.as === 'required' ? 'requirement' : 'influence';
      const link = ensureLink(state, env, source.id, target.id, relation, { nominatedBy: pid, questionId: q.id });
      syncQuestions(state, env.at);
      // Proposing it is this person's claim only; it can be changed later like any answer.
      recordProposerStance(state, env, link, pid, cmd.as === 'harms' ? 'harms' : 'yes', cmd.mechanism, true);
      return `${state.participants[pid]!.name} proposed a connection into “${target.label}”`;
    }
    case 'rename_participant': {
      const pid = actingFor(state, env, cmd.participantId);
      state.participants[pid]!.name = cmd.name;
      return `A participant is now called ${cmd.name}`;
    }

    case 'add_node': {
      if (env.actor.type === 'participant' && !state.settings.layers[KIND_LAYER[cmd.kind]].open)
        throw new CommandError('forbidden', `Adding ${cmd.kind}s yourself is not open right now. Suggest it when the facilitator asks.`);
      const node = createNode(state, env, 0, cmd.kind, cmd.label, cmd.definition, [{ at: env.at, actor: env.actor, event: 'created' }]);
      // Something a participant adds is theirs first; it joins the shared catalogue when that layer is pooled.
      if (env.actor.type === 'participant') node.owner = env.actor.id;
      if (cmd.elicitedFor && state.nodes[cmd.elicitedFor]) node.elicitedFor = cmd.elicitedFor;
      return `${actorName} added ${cmd.kind} “${node.label}”`;
    }
    case 'add_link': {
      // A candidate arrow with no holder: something for people to consider, not a claim by anyone.
      requireFacilitator(env);
      const { from, to } = checkArrowEnds(state, cmd.from, cmd.to);
      const existing = state.links[linkId(cmd.relation, from.id, to.id)];
      if (existing?.status === 'active') throw new CommandError('conflict', 'That link is already on the map.');
      ensureLink(state, env, from.id, to.id, cmd.relation, {});
      return `${actorName} proposed a link: “${from.label}” ${cmd.relation === 'influence' ? '→' : 'is required for'} “${to.label}”`;
    }
    case 'hold_link': {
      const pid = actingFor(state, env, cmd.participantId);
      if (env.actor.type === 'participant' && !state.settings.layers.connections.open)
        throw new CommandError('forbidden', 'Drawing connections is not open right now.');
      const { from, to } = checkArrowEnds(state, cmd.from, cmd.to);
      const name = state.participants[pid]!.name;
      const source: AnswerSource = env.actor.type === 'participant' || state.mode === 'solo' ? 'explorer' : 'on-behalf';
      if (!cmd.hold) {
        const existing = activeLink(state, linkId(cmd.relation, from.id, to.id));
        const q = existing ? stanceQuestion(state, existing) : undefined;
        if (!q || !latestAnswer(state, q.id, pid)) throw new CommandError('not-found', 'That arrow is not in this map.');
        pushAnswer(state, env, q, pid, { kind: 'choice', choice: 'no' }, source);
        return `${name} removed an arrow from their map`;
      }
      const link = ensureLink(state, env, from.id, to.id, cmd.relation, {});
      syncQuestions(state, env.at);
      const q = stanceQuestion(state, link);
      if (!q) throw new CommandError('conflict', 'The configuration has no way to record who holds this kind of link.');
      const t = findTemplate(state.config, q.templateId);
      const allowed = t?.answer.type === 'choice' ? t.answer.options.map((o) => o.value) : ['yes'];
      const wanted = cmd.as === 'harms' && cmd.relation === 'influence' ? 'harms' : cmd.as === 'conditional' ? 'conditional' : 'yes';
      pushAnswer(state, env, q, pid, { kind: 'choice', choice: allowed.includes(wanted) ? wanted : 'yes' }, source, cmd.mechanism);
      return `${name} drew an arrow in their map`;
    }
    case 'save_synthesis': {
      const mine = env.actor.type === 'participant' ? env.actor.id : null;
      for (const c of cmd.contributors) {
        if (!state.participants[c]) throw new CommandError('not-found', 'One of those people is not in this workshop.');
        if (mine && c !== mine && !state.settings.shareModels) throw new CommandError('forbidden', 'You can only combine your map with someone else’s once models have been shared.');
      }
      const contributors = [...new Set(cmd.contributors)];
      const method = getAggregation(cmd.aggregation.methodId);
      if (!method) throw new CommandError('not-found', `There is no aggregation method called "${cmd.aggregation.methodId}".`);
      const settings = resolveAggregationSettings(method, cmd.aggregation.settings);
      if (!settings.ok) throw new CommandError('invalid', `Aggregation settings are not valid: ${settings.problems.join('; ')}`);
      const spec = { name: cmd.name, contributors, decisions: cmd.decisions, aggregation: { methodId: method.id, settings: settings.settings } };
      // Two maps without loops can make one when combined. Never save that as if it were a usable map.
      const loop = previewSynthesis(state, spec).includedLoop;
      if (loop)
        throw new CommandError(
          'conflict',
          `Together these arrows make a loop: ${describeLoop(loop, (id) => nodeLabel(state, id))}. Leave one of them out of the combined map, then save again.`,
        );
      if (cmd.synthesisId) {
        const syn = state.syntheses[cmd.synthesisId];
        if (!syn) throw new CommandError('not-found', 'That combined model no longer exists.');
        if (mine && !(syn.createdBy.type === 'participant' && syn.createdBy.id === mine)) throw new CommandError('forbidden', 'You can only change combined models you made.');
        const { id: _id, createdBy: _c, createdAt: _a, archived: _r, previous, ...current } = syn;
        previous.push(current);
        if (previous.length > MAX_SYNTHESIS_VERSIONS) previous.splice(0, previous.length - MAX_SYNTHESIS_VERSIONS);
        Object.assign(syn, spec, { version: syn.version + 1, at: env.at, by: env.actor });
        state.modelRev++;
        return `Saved version ${syn.version} of the combined model “${syn.name}”`;
      }
      const id = `y${env.seq}`;
      state.syntheses[id] = { id, ...spec, version: 1, at: env.at, by: env.actor, createdBy: env.actor, createdAt: env.at, archived: false, previous: [] };
      state.modelRev++;
      return `${actorName} made a combined model “${cmd.name}” from ${contributors.length} ${contributors.length === 1 ? 'person' : 'people'}`;
    }
    case 'revert_synthesis':
    case 'set_synthesis_archived': {
      const syn = state.syntheses[cmd.synthesisId];
      if (!syn) throw new CommandError('not-found', 'That combined model no longer exists.');
      if (env.actor.type === 'participant' && !(syn.createdBy.type === 'participant' && syn.createdBy.id === env.actor.id))
        throw new CommandError('forbidden', 'You can only change combined models you made.');
      state.modelRev++;
      if (cmd.type === 'set_synthesis_archived') {
        syn.archived = cmd.archived;
        return cmd.archived ? `Put the combined model “${syn.name}” away (personal models are unaffected)` : `Brought back the combined model “${syn.name}”`;
      }
      const old = syn.previous.find((v) => v.version === cmd.version);
      if (!old) throw new CommandError('not-found', 'That version is not available.');
      const { id: _id, createdBy: _c, createdAt: _a, archived: _r, previous, ...current } = syn;
      previous.push(current);
      Object.assign(syn, { ...old, version: syn.version + 1, at: env.at, by: env.actor });
      return `Went back to version ${cmd.version} of “${syn.name}” (saved as version ${syn.version})`;
    }

    case 'set_title':
      requireFacilitator(env);
      state.title = cmd.title;
      return `Workshop renamed to “${cmd.title}”`;
    case 'set_stage':
      requireFacilitator(env);
      if (!state.config.stages.some((s) => s.id === cmd.stageId)) throw new CommandError('not-found', 'That stage does not exist.');
      state.stageId = cmd.stageId;
      return `Moved to stage “${state.config.stages.find((s) => s.id === cmd.stageId)!.title}”`;
    case 'set_config': {
      requireFacilitator(env);
      const parsed = parseConfig(cmd.config);
      if (!parsed.ok) throw new CommandError('invalid', parsed.problems.join('\n'));
      const method = getMethod(parsed.config.calculation.methodId);
      if (!method) throw new CommandError('invalid', `There is no calculation method called "${parsed.config.calculation.methodId}".`);
      const settings = resolveSettings(method, parsed.config.calculation.settings[method.id]);
      if (!settings.ok) throw new CommandError('invalid', `Method settings are not valid: ${settings.problems.join('; ')}`);
      const aggregation = getAggregation(parsed.config.aggregation.methodId);
      if (!aggregation) throw new CommandError('invalid', `There is no aggregation method called "${parsed.config.aggregation.methodId}".`);
      const aggSettings = resolveAggregationSettings(aggregation, parsed.config.aggregation.settings);
      if (!aggSettings.ok) throw new CommandError('invalid', `Aggregation settings are not valid: ${aggSettings.problems.join('; ')}`);
      state.config = parsed.config;
      if (!state.config.stages.some((s) => s.id === state.stageId)) state.stageId = state.config.stages[0]!.id;
      state.modelRev++;
      return 'Workshop configuration updated';
    }
    case 'set_settings':
      requireFacilitator(env);
      if (cmd.shareModels !== undefined) state.settings.shareModels = cmd.shareModels;
      // Pooling is a visibility choice, not a one-way door: it can be switched at any time and nothing personal is overwritten.
      for (const [layer, change] of Object.entries(cmd.layers ?? {}) as [Layer, { open?: boolean; pooled?: boolean }][]) {
        if (change.open !== undefined) state.settings.layers[layer].open = change.open;
        if (change.pooled !== undefined) state.settings.layers[layer].pooled = change.pooled;
      }
      return 'Sharing and pooling settings changed';

    case 'publish_question': {
      requireFacilitator(env);
      const q = getQuestion(state, cmd.questionId);
      if (q.status === 'superseded' || q.status === 'dismissed') throw new CommandError('conflict', 'That question has been set aside. Restore it first.');
      const r = renderQuestion(state, q);
      if (!r.known) throw new CommandError('conflict', 'That question’s wording has been removed from the configuration.');
      if (state.liveQuestionId !== q.id) closeLive(state, env);
      q.status = 'live';
      q.publishedAt = env.at;
      q.rounds += 1;
      if (q.rounds === 1) q.revealed = state.config.privacy.revealByDefault;
      delete q.queuedAt;
      state.liveQuestionId = q.id;
      if (state.config.stages.some((s) => s.id === r.stageId)) state.stageId = r.stageId;
      return `${q.rounds > 1 ? 'Reopened' : 'Asked'}: “${r.prompt}”`;
    }
    case 'close_question':
      requireFacilitator(env);
      closeLive(state, env);
      return 'Closed the live question';
    case 'queue_question': {
      requireFacilitator(env);
      const q = getQuestion(state, cmd.questionId);
      if (cmd.queued) q.queuedAt = env.at;
      else delete q.queuedAt;
      return cmd.queued ? 'Lined up a question' : 'Took a question out of the line-up';
    }
    case 'dismiss_question': {
      requireFacilitator(env);
      const q = getQuestion(state, cmd.questionId);
      if (q.status === 'superseded') throw new CommandError('conflict', 'That question is about something that has been merged or removed.');
      if (cmd.dismissed) {
        if (state.liveQuestionId === q.id) closeLive(state, env);
        q.status = 'dismissed';
        delete q.autoDismissed;
        delete q.queuedAt;
      } else if (q.status === 'dismissed') {
        q.status = q.rounds > 0 ? 'closed' : 'draft';
        delete q.autoDismissed;
      }
      return cmd.dismissed ? 'Set a question aside' : 'Restored a question';
    }
    case 'reveal_question': {
      requireFacilitator(env);
      const q = getQuestion(state, cmd.questionId);
      q.revealed = cmd.revealed;
      return cmd.revealed ? `Answers revealed for “${renderQuestion(state, q).about}”` : `Answers hidden again for “${renderQuestion(state, q).about}”`;
    }
    case 'add_custom_question': {
      requireFacilitator(env);
      if (cmd.subject.type === 'node') getNode(state, cmd.subject.nodeId);
      if (cmd.subject.type === 'link' && !activeLink(state, cmd.subject.linkId)) throw new CommandError('not-found', 'That link is not on the map.');
      const stageId = cmd.stageId && state.config.stages.some((s) => s.id === cmd.stageId) ? cmd.stageId : state.stageId;
      const id = `q:custom:${env.seq}`;
      state.questions[id] = {
        id,
        templateId: 'custom',
        subject: cmd.subject,
        status: 'draft',
        revealed: false,
        createdAt: env.at,
        rounds: 0,
        custom: { prompt: cmd.prompt, help: cmd.help || undefined, answer: cmd.answer, stageId },
      };
      return 'Facilitator wrote a custom question';
    }
    case 'add_template_question': {
      requireFacilitator(env);
      const t = findTemplate(state.config, cmd.templateId);
      if (!t) throw new CommandError('not-found', 'That question template does not exist.');
      if (!matchesFilter(state, t.subject, cmd.subject)) throw new CommandError('invalid', 'That template does not apply to this item.');
      const id = questionId(t.id, cmd.subject);
      const existing = state.questions[id];
      if (existing) {
        if (existing.status === 'dismissed') {
          existing.status = existing.rounds > 0 ? 'closed' : 'draft';
          delete existing.autoDismissed;
        }
      } else {
        state.questions[id] = { id, templateId: t.id, subject: cmd.subject, status: 'draft', revealed: false, createdAt: env.at, rounds: 0 };
      }
      return `Added question “${t.title}”`;
    }

    case 'resolve_suggestion': {
      requireFacilitator(env);
      const s = state.suggestions[cmd.suggestionId];
      if (!s) throw new CommandError('not-found', 'That suggestion no longer exists.');
      if (cmd.resolution === 'reopen') {
        if (s.status !== 'declined') throw new CommandError('conflict', 'Only suggestions that were set aside can be brought back.');
        s.status = 'pending';
        delete s.resolvedAt;
        return 'Brought a suggestion back for another look';
      }
      if (s.status !== 'pending') throw new CommandError('conflict', 'That suggestion has already been dealt with.');
      s.resolvedAt = env.at;
      if (cmd.resolution === 'decline') {
        s.status = 'declined';
        return 'Set a suggestion aside';
      }
      const q = getQuestion(state, s.questionId);
      const target = suggestionTarget(renderQuestion(state, q).answer);
      if (!target) throw new CommandError('conflict', 'The question this suggestion belongs to no longer takes suggestions.');
      const subjectNode = q.subject.type === 'node' ? state.nodes[q.subject.nodeId] : undefined;
      const detail = { suggestionId: s.id, originalText: s.text, participantId: s.participantId, questionId: q.id };
      let node: ModelNode;
      if (cmd.resolution === 'accept') {
        node = createNode(state, env, 0, target.nodeKind, cmd.label ?? s.text, '', [{ at: env.at, actor: { type: 'participant', id: s.participantId }, event: 'from-suggestion', detail }]);
        // Remember where it came up, for a rough layout only. No arrow is implied.
        if (subjectNode) node.elicitedFor = subjectNode.id;
        s.status = 'accepted';
      } else {
        if (!cmd.confirm) throw new CommandError('invalid', 'Merging a suggestion into an existing item needs to be confirmed.');
        if (!cmd.intoNodeId) throw new CommandError('invalid', 'Choose the existing item this suggestion matches.');
        node = getNode(state, cmd.intoNodeId);
        if (node.kind !== target.nodeKind) throw new CommandError('invalid', `That suggestion is a ${target.nodeKind}; it can only be merged into another ${target.nodeKind}.`);
        // Authorship is recorded; it does not mean everyone who suggested something similar agrees on the rest.
        node.provenance.push({ at: env.at, actor: { type: 'participant', id: s.participantId }, event: 'merged-in', detail });
        s.status = 'merged';
      }
      s.nodeId = node.id;
      if (target.linkRelation && subjectNode && subjectNode.status === 'active' && subjectNode.id !== node.id) {
        const link = ensureLink(state, env, node.id, subjectNode.id, target.linkRelation, detail);
        s.linkId = link.id;
        syncQuestions(state, env.at);
        recordProposerStance(state, env, link, s.participantId, 'yes');
      }
      state.modelRev++;
      return cmd.resolution === 'accept' ? `Accepted a suggestion as ${target.nodeKind} “${node.label}”` : `Merged a suggestion into “${node.label}”`;
    }

    case 'edit_node': {
      requireFacilitator(env);
      const node = getNode(state, cmd.nodeId, false);
      const before = node.label;
      const labelChanged = cmd.label !== undefined && cmd.label !== node.label;
      const definitionChanged = cmd.definition !== undefined && cmd.definition !== node.definition;
      if (!labelChanged && !definitionChanged) return `No change to “${node.label}”`;
      if (cmd.label !== undefined) node.label = cmd.label;
      if (cmd.definition !== undefined) node.definition = cmd.definition;
      node.updatedAt = env.at;
      if (cmd.meaningChanged) {
        node.meaningRev += 1;
        if (state.goal.nodeId === node.id) state.goal.contextRev += 1;
      }
      node.provenance.push({
        at: env.at,
        actor: env.actor,
        event: cmd.meaningChanged ? 'redefined' : 'renamed',
        detail: labelChanged ? { previousLabel: before } : {},
      });
      state.modelRev++;
      return cmd.meaningChanged
        ? `Redefined “${before}”${labelChanged ? ` as “${node.label}”` : ''}; earlier answers about it are flagged for review`
        : `Reworded “${before}”${labelChanged ? ` to “${node.label}”` : ''} (meaning unchanged)`;
    }
    case 'merge_nodes': {
      requireFacilitator(env);
      const from = getNode(state, cmd.fromNodeId);
      const into = getNode(state, cmd.intoNodeId);
      if (from.id === into.id) throw new CommandError('invalid', 'Choose two different items.');
      if (from.kind !== into.kind) throw new CommandError('invalid', `A ${from.kind} can only be merged into another ${from.kind}.`);
      mergeNodes(state, env, from, into);
      return `Merged “${from.label}” into “${into.label}”; answers were carried over and flagged for review`;
    }
    case 'set_node_status': {
      requireFacilitator(env);
      const node = getNode(state, cmd.nodeId, false);
      if (node.status === 'merged') throw new CommandError('conflict', 'That item was merged into another one.');
      if (node.status === cmd.status) return `No change to “${node.label}”`;
      if (cmd.status === 'archived' && state.goal.nodeId === node.id) throw new CommandError('conflict', 'Choose a different goal before removing this one.');
      node.status = cmd.status;
      node.updatedAt = env.at;
      node.provenance.push({ at: env.at, actor: env.actor, event: cmd.status === 'archived' ? 'archived' : 'restored' });
      state.modelRev++;
      return cmd.status === 'archived' ? `Removed “${node.label}” from the map (kept in the record)` : `Restored “${node.label}” to the map`;
    }
    case 'move_nodes': {
      requireFacilitator(env);
      for (const [id, pos] of Object.entries(cmd.positions)) {
        const n = state.nodes[id];
        if (n) n.position = pos;
      }
      return 'Rearranged the map';
    }
    case 'set_link_status': {
      requireFacilitator(env);
      const link = state.links[cmd.linkId];
      if (!link) throw new CommandError('not-found', 'That link is not on the map.');
      if (link.status === 'merged') throw new CommandError('conflict', 'That link was merged into another one.');
      link.status = cmd.status;
      link.provenance.push({ at: env.at, actor: env.actor, event: cmd.status === 'archived' ? 'archived' : 'restored' });
      state.modelRev++;
      return cmd.status === 'archived'
        ? `Removed the link “${nodeLabel(state, link.from)}” → “${nodeLabel(state, link.to)}” (kept in the record)`
        : `Restored the link “${nodeLabel(state, link.from)}” → “${nodeLabel(state, link.to)}”`;
    }
    case 'select_goal': {
      requireFacilitator(env);
      const node = getNode(state, cmd.nodeId);
      if (node.kind !== 'goal') throw new CommandError('invalid', 'Only a goal can be chosen as the goal.');
      const changed = state.goal.nodeId !== node.id || state.goal.successDefinition !== cmd.successDefinition || state.goal.horizon !== cmd.horizon;
      if (changed) {
        state.goal = { nodeId: node.id, successDefinition: cmd.successDefinition, horizon: cmd.horizon, contextRev: state.goal.contextRev + 1 };
        state.modelRev++;
      }
      return `Goal set to “${node.label}”${cmd.horizon ? ` by ${cmd.horizon}` : ''}`;
    }
    case 'set_participant_active': {
      requireFacilitator(env);
      const p = state.participants[cmd.participantId];
      if (!p) throw new CommandError('not-found', 'That participant is not in this workshop.');
      p.active = cmd.active;
      return cmd.active ? `${p.name} is taking part again` : `${p.name} is no longer counted as taking part`;
    }
  }
}

/**
 * Fold one item into another. Nothing is deleted: the merged item, its links,
 * its questions and every answer stay in the record. Answers that have no
 * counterpart on the surviving item are carried over and flagged, because the
 * two definitions may not have meant exactly the same thing.
 */
function mergeNodes(state: WorkshopState, env: Env, from: ModelNode, into: ModelNode): void {
  // Remember which question maps to which before the map changes.
  const carry: { oldQ: Question; templateId: string; newSubject: Question['subject'] }[] = [];
  const affectedLinks = Object.values(state.links).filter((l) => l.status === 'active' && (l.from === from.id || l.to === from.id));
  for (const q of Object.values(state.questions)) {
    if (q.custom) continue;
    if (q.subject.type === 'node' && q.subject.nodeId === from.id) carry.push({ oldQ: q, templateId: q.templateId, newSubject: { type: 'node', nodeId: into.id } });
  }

  from.status = 'merged';
  from.mergedInto = into.id;
  from.updatedAt = env.at;
  into.updatedAt = env.at;
  into.provenance.push({ at: env.at, actor: env.actor, event: 'merged-in', detail: { nodeId: from.id, label: from.label } });
  if (state.goal.nodeId === from.id) {
    state.goal.nodeId = into.id;
    state.goal.contextRev += 1;
  }

  for (const old of affectedLinks) {
    const newFrom = old.from === from.id ? into.id : old.from;
    const newTo = old.to === from.id ? into.id : old.to;
    old.status = 'merged';
    if (newFrom === newTo) continue; // a link between the two merged items has nothing to point at
    const target = ensureLink(state, env, newFrom, newTo, old.relation, { mergedFromLink: old.id });
    old.mergedInto = target.id;
    for (const q of Object.values(state.questions)) {
      if (!q.custom && q.subject.type === 'link' && q.subject.linkId === old.id) carry.push({ oldQ: q, templateId: q.templateId, newSubject: { type: 'link', linkId: target.id } });
    }
  }
  for (const s of Object.values(state.suggestions)) {
    if (s.nodeId === from.id && s.status === 'accepted') s.status = 'merged';
  }

  syncQuestions(state, env.at);

  for (const { oldQ, templateId, newSubject } of carry) {
    // Wording can differ by source kind, so look for any template with the same role (or the same template) on the new subject.
    const oldTemplate = findTemplate(state.config, templateId);
    const candidates = knownTemplates(state.config).filter(
      (t) => (t.id === templateId || (!!oldTemplate?.role && t.role === oldTemplate.role)) && matchesFilter(state, t.subject, newSubject),
    );
    const newQ = candidates.map((t) => state.questions[questionId(t.id, newSubject)]).find((q): q is Question => !!q);
    if (!newQ) continue;
    newQ.rounds = Math.max(newQ.rounds, oldQ.rounds > 0 ? 1 : 0);
    if (newQ.status === 'draft' && newQ.rounds > 0) newQ.status = 'closed';
    for (const [pid, list] of Object.entries(state.answers[oldQ.id] ?? {})) {
      const last = list[list.length - 1];
      if (!last || latestAnswer(state, newQ.id, pid)) continue;
      const byParticipant = (state.answers[newQ.id] ??= {});
      (byParticipant[pid] ??= []).push({
        ...last,
        questionId: newQ.id,
        revision: 1,
        source: 'merged',
        enteredBy: env.actor,
        at: env.at,
        needsReview: `Carried over from “${from.label}”, which was merged into “${into.label}”. Check it still says what you mean.`,
      });
    }
  }
  // Merging two items can join arrows into a loop in someone's map. Refuse rather than leave a map that cannot be used.
  for (const p of Object.values(state.participants)) {
    const loop = findLoop(heldArrows(state, p.id));
    if (loop)
      throw new CommandError(
        'conflict',
        `Merging these would make a loop in ${p.name}’s map: ${describeLoop(loop, (id) => nodeLabel(state, id))}. Nothing was merged. Remove one of those arrows first if they really are the same item.`,
      );
  }
  state.modelRev++;
}

function checkArrowEnds(state: WorkshopState, fromId: string, toId: string): { from: ModelNode; to: ModelNode } {
  if (fromId === toId) throw new CommandError('invalid', 'An item cannot be connected to itself.');
  const from = getNode(state, fromId);
  const to = getNode(state, toId);
  if (to.kind === 'action') throw new CommandError('invalid', 'Arrows run from actions and states towards states and the goal, not into an action.');
  if (from.kind === 'goal') throw new CommandError('invalid', 'Arrows run towards the goal, not out of it.');
  return { from, to };
}
