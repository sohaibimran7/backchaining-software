/**
 * Local additive approximation (opt-in): ranks actions by estimated change in
 * the chance of the goal, in percentage points.
 *
 * For every arrow X → Y the person gives ONE number: how many percentage
 * points X changes the chance of Y by the time horizon, compared with the same
 * expected course of events (including what others are likely to do anyway)
 * without X. It is a difference, not a conditional probability, and no
 * absolute chance of anything is asked for or reported.
 *
 * Under the declared assumptions (stable direct changes that add up; no
 * interactions that are not on the map), the change in the chance of the goal
 * from an action is the sum, over every route from the action to the goal, of
 * the product of the changes along the route — each route counted once.
 *
 * Where the assumptions visibly fail — a loop, something marked REQUIRED, an
 * arrow that holds only under some conditions — the number and the rank are
 * withheld. Missing answers make a result "incomplete", never zero.
 */
import { z } from 'zod';
import { ROLES, type QuestionTemplate } from '../config';
import { ancestors, countRoutes, descendants, findBottlenecks, incoming, outgoing, topoOrder } from './graph';
import { blank } from './structureDiagnostic';
import type { ActionResult, Belief, CalculationMethod, Diagnostic, EngineResult, FormulaProgram, MethodOutput, ModelLinkInput, ParticipantModel, PreparedCalculation, Ranking, SourceRef } from './types';

const settingsSchema = z.object({
  requirementPolicy: z.enum(['withhold-all', 'withhold-when-routes-combine']).default('withhold-all'),
  unstatedLinks: z.enum(['leave-out', 'treat-as-missing']).default('leave-out'),
  staleAnswers: z.enum(['treat-as-missing', 'use-with-warning']).default('treat-as-missing'),
  /** Added either side of a single-number estimate, in percentage points. 0 = take single numbers at face value. */
  pointEstimateMargin: z.number().min(0).max(50).default(0),
});
export type LocalAdditiveSettings = z.infer<typeof settingsSchema>;

interface Range {
  low: number;
  high: number;
}

const CONTEXT_HELP =
  'Compare two versions of the same expected future: everything goes the way you expect — including what people outside this room are likely to do anyway — and the only difference is this one thing. Count only its direct push on “{to}”, not what it does by way of other items on the map.';

const elicitation: QuestionTemplate[] = [
  {
    id: 'change-from-action',
    title: 'How much the action changes it',
    prompt: 'If people in this room do “{from}”, how much more or less likely is “{to}” by {horizon}, compared with not doing it?',
    help: CONTEXT_HELP,
    subject: { type: 'link', relations: ['influence'], fromKinds: ['action'] },
    answer: { type: 'difference', allowRange: true },
    stageId: 'estimates',
    generate: 'when-method-requires',
    role: ROLES.directChange,
    allowUnsure: true,
    version: 1,
  },
  {
    id: 'change-from-state',
    title: 'How much it changes the next thing',
    prompt: 'If “{from}” happens, how much more or less likely is “{to}” by {horizon}, compared with “{from}” not happening?',
    help: CONTEXT_HELP,
    subject: { type: 'link', relations: ['influence'], fromKinds: ['state', 'goal'] },
    answer: { type: 'difference', allowRange: true },
    stageId: 'estimates',
    generate: 'when-method-requires',
    role: ROLES.directChange,
    allowUnsure: true,
    version: 1,
  },
];

export const localAdditive: CalculationMethod<LocalAdditiveSettings> = {
  id: 'local-additive',
  version: '2.0.0',
  name: 'Rank actions by added-up probability changes (local additive approximation)',
  summary:
    'Ranks actions by how many percentage points each is estimated to change the chance of the goal, compared with the same expected course of events without it. Worked out separately for each model. It never states the chance of the goal itself, and it gives no number or rank wherever its assumptions visibly fail.',
  requiresAcknowledgement: true,
  assumptions: [
    'Every answer is a difference against one common reference: the future you expect anyway, including what others are likely to do, changed in one respect only.',
    'Each arrow has a stable direct change: the same number of percentage points whatever else on the map happens.',
    'Changes add up. How much one thing helps does not depend on whether other things on the map also happen.',
    'Nothing important is missing from the map that connects two of its items or interacts with them.',
    'A change passes along a route by multiplying the changes on it; an action’s total is the sum over its distinct routes to the goal, each counted once.',
    'Each answer covers only the direct push along its own arrow. If a person folded longer routes into an answer, those routes are counted twice.',
    'A single-number answer is taken at face value unless a range was given (or a margin is set below).',
  ],
  limits: [
    'Differences between pairs of items do not, in general, pin down how things interact. This is an approximation for ranking, not a causal model.',
    'It does not give the chance of the goal, only estimated changes to it.',
    'Something marked as required, or an arrow marked as holding only under some conditions, is an interaction this approximation cannot represent; affected actions get no number and no rank.',
    'Actions whose ranges overlap are placed in the same tier: the method cannot tell them apart.',
    'An arrow nobody drew is left out. That is an approximation of the model, not evidence of no effect.',
  ],
  requiredInputs: [
    'For each arrow from an action: how many percentage points doing it changes the chance of the state it points at.',
    'For each other arrow: how many percentage points the first item happening changes the chance of the next.',
    'No starting chances are asked for. “Not sure” is accepted and leaves the affected actions unranked.',
  ],
  example: {
    caption: 'Changes in percentage points, written on the arrows.',
    nodes: [
      { id: 'a1', label: 'Action 1', kind: 'action' },
      { id: 'a2', label: 'Action 2', kind: 'action' },
      { id: 's1', label: 'State 1', kind: 'state' },
      { id: 's2', label: 'State 2', kind: 'state' },
      { id: 'g', label: 'Goal', kind: 'goal' },
    ],
    arrows: [
      { from: 'a1', to: 's1', label: '+50' },
      { from: 'a2', to: 's2', label: '+30' },
      { from: 's1', to: 's2', label: '+15' },
      { from: 's1', to: 'g', label: '+20' },
      { from: 's2', to: 'g', label: '+15' },
    ],
    outcome: 'Action 1: 0.50 × (0.20 + 0.15 × 0.15) ≈ +11 points. Action 2: 0.30 × 0.15 ≈ +5 points. Action 1 ranks first.',
  },
  settingsSchema,
  defaultSettings: { requirementPolicy: 'withhold-all', unstatedLinks: 'leave-out', staleAnswers: 'treat-as-missing', pointEstimateMargin: 0 },
  settingsFields: [
    {
      key: 'requirementPolicy',
      label: 'When something on the route is marked as required',
      help: 'A requirement means changes do not simply add up. "Always withhold" gives no number for any action whose routes pass such an item. The second option withholds only where the action reaches that item by more than one arrow, or also affects the required item by another route — the cases where adding up would actually be used.',
      type: 'select',
      options: [
        { value: 'withhold-all', label: 'Always withhold the number' },
        { value: 'withhold-when-routes-combine', label: 'Withhold only where routes combine there' },
      ],
    },
    {
      key: 'unstatedLinks',
      label: 'Arrows proposed by others that the person has not reviewed',
      help: '"Leave out" works from the arrows they hold and notes the open ones. "Treat as missing" marks any action whose routes could use such an arrow as incomplete.',
      type: 'select',
      options: [
        { value: 'leave-out', label: 'Leave out, and list them' },
        { value: 'treat-as-missing', label: 'Treat as missing information' },
      ],
    },
    {
      key: 'staleAnswers',
      label: 'Answers given before a definition or the time horizon changed',
      help: 'Such answers are flagged for review. Choose whether they count as missing until reviewed, or are used with a warning.',
      type: 'select',
      options: [
        { value: 'treat-as-missing', label: 'Treat as missing until reviewed' },
        { value: 'use-with-warning', label: 'Use, with a warning' },
      ],
    },
    {
      key: 'pointEstimateMargin',
      label: 'Margin around single-number answers',
      help: 'Percentage points added either side of an answer given as one number. 0 takes it at face value. Ranges people give themselves are always used as given.',
      type: 'number',
      min: 0,
      max: 50,
      step: 1,
      unit: 'points',
    },
  ],
  consumes: [ROLES.linkStance, ROLES.directChange],
  elicitation,
  prepare: prepareLocalAdditive,
};

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Product of two ranges that may include negative numbers. */
export function multiplyRanges(a: Range, b: Range): Range {
  const products = [a.low * b.low, a.low * b.high, a.high * b.low, a.high * b.high];
  return { low: Math.min(...products), high: Math.max(...products) };
}

/** Direct change along an arrow as a range, in probability units (0.2 = 20 percentage points). */
/** How a method variant reads one arrow's direct change from a person's answers. */
export type ReadEffect = (
  link: ModelLinkInput,
  settings: LocalAdditiveSettings,
) => { ok: true; range: Range; stale: boolean; role: string; chanceWithout?: Range } | { ok: false; why: string };

function usableChance(belief: Belief | undefined, settings: LocalAdditiveSettings): { ok: true; range: Range; stale: boolean } | { ok: false; why: string } {
  if (!belief || belief.state === 'unanswered') return { ok: false, why: 'no estimate yet' };
  if (belief.state === 'unsure') return { ok: false, why: 'answered "not sure"' };
  if (belief.value.kind !== 'probability') return { ok: false, why: 'no estimate yet' };
  const stale = belief.stale || belief.needsReview;
  if (stale && settings.staleAnswers === 'treat-as-missing') return { ok: false, why: 'the estimate needs review after a definition or the time horizon changed' };
  const margin = settings.pointEstimateMargin / 100;
  const { p, low, high } = belief.value;
  const range =
    low !== undefined && high !== undefined
      ? { low: clamp(Math.min(low, high), 0, 1), high: clamp(Math.max(low, high), 0, 1) }
      : { low: clamp(p - margin, 0, 1), high: clamp(p + margin, 0, 1) };
  return { ok: true, range, stale };
}

/** The change along an arrow, derived from two chances: the next thing if this happens, and if it does not. */
export const effectFromTwoChances: ReadEffect = (link, settings) => {
  const withIt = usableChance(link.beliefs[ROLES.probIfSource], settings);
  const without = usableChance(link.beliefs[ROLES.probIfNoSource], settings);
  if (!withIt.ok) return { ok: false, why: `chance if it happens: ${withIt.why}` };
  if (!without.ok) return { ok: false, why: `chance if it does not happen: ${without.why}` };
  return {
    ok: true,
    // The widest change consistent with both ranges.
    range: { low: withIt.range.low - without.range.high, high: withIt.range.high - without.range.low },
    stale: withIt.stale || without.stale,
    role: ROLES.probIfSource,
    chanceWithout: without.range,
  };
};

export const directEffect: ReadEffect = (link, settings) => {
  const belief: Belief | undefined = link.beliefs[ROLES.directChange];
  if (!belief || belief.state === 'unanswered') return { ok: false, why: 'no estimate yet of how much it changes the next thing' };
  if (belief.state === 'unsure') return { ok: false, why: 'answered "not sure" about how much it changes the next thing' };
  if (belief.value.kind !== 'difference') return { ok: false, why: 'no estimate yet of how much it changes the next thing' };
  const stale = belief.stale || belief.needsReview;
  if (stale && settings.staleAnswers === 'treat-as-missing') return { ok: false, why: 'the estimate needs review after a definition or the time horizon changed' };
  const margin = settings.pointEstimateMargin / 100;
  const { d, low, high } = belief.value;
  const range =
    low !== undefined && high !== undefined
      ? { low: clamp(Math.min(low, high), -1, 1), high: clamp(Math.max(low, high), -1, 1) }
      : { low: clamp(d - margin, -1, 1), high: clamp(d + margin, -1, 1) };
  return { ok: true, range, stale, role: ROLES.directChange };
};

/** One action whose change can be calculated: the items on its routes, in order, and the arrows into each. */
export interface PlannedAction {
  key: string;
  actionId: string;
  goal: string;
  order: string[];
  incoming: Record<string, { from: string; linkVar: string }[]>;
}

/** What the semantic checks let through: arrow ranges by generated name, and the actions to calculate. */
export interface AdditivePlan {
  links: Record<string, Range & { linkId: string; role: string; questionId?: string }>;
  actions: PlannedAction[];
}

function literal(n: number): string {
  // Parenthesised so negative numbers are unambiguous; no exponent notation surprises.
  return `(${Number(n.toFixed(12))})`;
}

/**
 * Translate a plan into Squiggle. Ranges are carried as explicit low/high pairs with ordinary
 * interval arithmetic — a person's range is NOT turned into a probability distribution.
 * Nothing is clipped: if added-up changes leave [−1, 1] the action is flagged, not tidied.
 */
export function compileAdditivePlan(plan: AdditivePlan): FormulaProgram {
  const lines: string[] = [];
  const sources: Record<string, SourceRef> = {};
  const outputs: string[] = [];
  for (const [v, l] of Object.entries(plan.links)) {
    lines.push(`${v}_lo = ${literal(l.low)}`, `${v}_hi = ${literal(l.high)}`);
    sources[`${v}_lo`] = { kind: 'link', id: l.linkId, role: l.role, questionId: l.questionId, bound: 'low' };
    sources[`${v}_hi`] = { kind: 'link', id: l.linkId, role: l.role, questionId: l.questionId, bound: 'high' };
  }
  for (const a of plan.actions) {
    const nodeVar = new Map(a.order.map((id, i) => [id, `${a.key}_n${i}`]));
    const checks: string[] = [];
    for (const id of a.order) {
      const v = nodeVar.get(id)!;
      sources[`${v}_lo`] = { kind: 'node', id, bound: 'low', note: `change at this item if the action is taken (${a.key})` };
      sources[`${v}_hi`] = { kind: 'node', id, bound: 'high', note: `change at this item if the action is taken (${a.key})` };
      if (id === a.actionId) {
        lines.push(`${v}_lo = 1`, `${v}_hi = 1`); // doing it versus not doing it
        continue;
      }
      const lows: string[] = [];
      const highs: string[] = [];
      for (const { from, linkVar } of a.incoming[id] ?? []) {
        const u = nodeVar.get(from)!;
        const products = `[${linkVar}_lo * ${u}_lo, ${linkVar}_lo * ${u}_hi, ${linkVar}_hi * ${u}_lo, ${linkVar}_hi * ${u}_hi]`;
        lows.push(`Number.min(${products})`);
        highs.push(`Number.max(${products})`);
      }
      lines.push(`${v}_lo = ${lows.join(' + ') || '0'}`, `${v}_hi = ${highs.join(' + ') || '0'}`);
      checks.push(`((${v}_lo < -1 || ${v}_hi > 1) ? 1 : 0)`);
    }
    const g = nodeVar.get(a.goal)!;
    lines.push(`${a.key}_lo = ${g}_lo`, `${a.key}_hi = ${g}_hi`, `${a.key}_bad = ${checks.join(' + ') || '0'}`);
    sources[`${a.key}_lo`] = { kind: 'action', id: a.actionId, bound: 'low', note: 'change in the chance of the goal' };
    sources[`${a.key}_hi`] = { kind: 'action', id: a.actionId, bound: 'high', note: 'change in the chance of the goal' };
    sources[`${a.key}_bad`] = { kind: 'action', id: a.actionId, note: 'how many items on its routes had added-up changes outside −1…1' };
    outputs.push(`${a.key}_lo`, `${a.key}_hi`, `${a.key}_bad`);
  }
  lines.push(`{${outputs.map((o) => `${o}: ${o}`).join(', ')}}`);
  return { language: 'squiggle', code: lines.join('\n'), sources, outputs };
}

/**
 * The same arithmetic in plain TypeScript. Not used to produce results: it exists so tests can
 * check that the generated formulas and the engine agree with the method's definition.
 */
export function evaluatePlanReference(plan: AdditivePlan): Record<string, number> {
  const values: Record<string, number> = {};
  for (const a of plan.actions) {
    const change = new Map<string, Range>([[a.actionId, { low: 1, high: 1 }]]);
    let bad = 0;
    for (const id of a.order) {
      if (id === a.actionId) continue;
      let low = 0;
      let high = 0;
      for (const { from, linkVar } of a.incoming[id] ?? []) {
        const part = multiplyRanges(plan.links[linkVar]!, change.get(from)!);
        low += part.low;
        high += part.high;
      }
      if (low < -1 || high > 1) bad += 1;
      change.set(id, { low, high });
    }
    const g = change.get(a.goal)!;
    values[`${a.key}_lo`] = g.low;
    values[`${a.key}_hi`] = g.high;
    values[`${a.key}_bad`] = bad;
  }
  return values;
}

export function prepareLocalAdditive(model: ParticipantModel, settings: LocalAdditiveSettings, readEffect: ReadEffect = directEffect): PreparedCalculation & { plan: AdditivePlan } {
  const roles = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  const plan: AdditivePlan = { links: {}, actions: [] };
  const linkVars = new Map<string, string>();
  const staleActions = new Set<string>();
  const goal = model.goalId;
  if (!goal) {
    const output: MethodOutput = {
      status: 'not-applicable',
      headline: 'No goal has been chosen yet.',
      actions: [],
      diagnostics: [{ severity: 'blocker', code: 'no-goal', message: 'Choose a goal before estimating actions.' }],
      bottlenecks: [],
    };
    return { program: null, plan, finish: () => output };
  }
  const label = new Map(model.nodes.map((n) => [n.id, n.label]));
  const name = (id: string) => `“${label.get(id) ?? id}”`;
  const linkName = (l: ModelLinkInput) => `${name(l.from)} → ${name(l.to)}`;

  const influenceAll = model.links.filter((l) => l.relation === 'influence');
  const held = influenceAll.filter((l) => l.stance === 'yes');
  // Links that might be part of the model but where we lack the person's view.
  const open = influenceAll.filter((l) => l.stance === 'unsure' || (l.stance === 'unstated' && settings.unstatedLinks === 'treat-as-missing'));
  // "Only under some conditions" is an interaction: part of the model, but not something effects-add-up can represent.
  const conditional = influenceAll.filter((l) => l.stance === 'conditional');
  const possible = [...held, ...conditional, ...open];
  const requirementsHeld = model.links.filter((l) => l.relation === 'requirement' && l.stance === 'yes');
  const requirementsOpen = model.links.filter((l) => l.relation === 'requirement' && (l.stance === 'unsure' || l.stance === 'unstated'));

  const out = outgoing(possible);
  const toGoal = ancestors(goal, incoming(possible));
  const actions = model.nodes.filter((n) => n.kind === 'action');
  const results: ActionResult[] = [];

  for (const a of actions) {
    const reach = descendants(a.id, out);
    if (!reach.has(goal)) {
      results.push(blank(a.id, 'not-connected', ['No route from this action to the goal in this person’s model.']));
      continue;
    }
    const via = new Set([...reach].filter((n) => toGoal.has(n)));
    const inside = possible.filter((l) => via.has(l.from) && via.has(l.to));
    const inc = incoming(inside);
    const required = requirementsHeld.filter((r) => via.has(r.to) && r.to !== a.id);
    const base: ActionResult = {
      ...blank(a.id, 'estimated', []),
      viaNodeIds: [...via].filter((n) => n !== a.id),
      requiredNodeIds: [...new Set(required.map((r) => r.from))],
    };

    const order = topoOrder(via, inside);
    if (!order) {
      results.push({ ...base, status: 'withheld', reasons: ['The links on the way to the goal form a loop, which this method cannot handle.'] });
      continue;
    }
    const routes = countRoutes(a.id, goal, via, inside);
    base.routeCount = routes.count;
    base.routesCapped = routes.capped;

    // Requirement claims are interactions. Never bypass them silently.
    const withholdReasons: string[] = [];
    for (const r of required) {
      const incomingHere = inc.get(r.to) ?? [];
      if (settings.requirementPolicy === 'withhold-all') {
        withholdReasons.push(`${name(r.from)} is marked as required for ${name(r.to)}, so effects into ${name(r.to)} do not simply add up.`);
      } else {
        const combines = incomingHere.length >= 2;
        const soleRouteIsTheRequirement = incomingHere.length === 1 && incomingHere[0]!.from === r.from;
        const actionAlsoMovesRequired = reach.has(r.from) && !soleRouteIsTheRequirement;
        if (combines)
          withholdReasons.push(`${name(r.from)} is marked as required for ${name(r.to)}, and this action reaches ${name(r.to)} by more than one link, so the effects cannot be added up.`);
        else if (actionAlsoMovesRequired)
          withholdReasons.push(`${name(r.from)} is marked as required for ${name(r.to)}, and this action also affects ${name(r.from)} by another route.`);
      }
    }
    for (const l of inside) {
      if (l.stance === 'conditional')
        withholdReasons.push(`${linkName(l)} is marked as holding only under some conditions, which effects-that-add-up cannot represent.`);
    }
    for (const r of model.links) {
      if (r.relation === 'requirement' && r.stance === 'conditional' && via.has(r.to) && r.to !== a.id)
        withholdReasons.push(`${name(r.from)} is marked as required for ${name(r.to)} under some conditions.`);
    }
    if (withholdReasons.length) {
      results.push({ ...base, status: 'withheld', reasons: [...new Set(withholdReasons)] });
      continue;
    }

    // Missing evidence → incomplete, never zero.
    const missing: ModelLinkInput[] = [];
    const reasons: string[] = [];
    const effects = new Map<string, Range>();
    let usedStale = false;
    for (const l of inside) {
      if (l.stance !== 'yes') {
        missing.push(l);
        reasons.push(`${linkName(l)}: ${l.stance === 'unsure' ? 'not sure whether this link holds' : 'no view given on this link yet'}.`);
        continue;
      }
      if (l.stanceStale && settings.staleAnswers === 'treat-as-missing') {
        missing.push(l);
        reasons.push(`${linkName(l)}: the answer needs review after a definition changed.`);
        continue;
      }
      const d = readEffect(l, settings);
      if (!d.ok) {
        missing.push(l);
        reasons.push(`${linkName(l)}: ${d.why}.`);
        continue;
      }
      usedStale ||= d.stale || l.stanceStale;
      roles.set(l.id, d.role);
      // Two chances make a contradiction visible that a single change cannot show.
      if (d.chanceWithout && d.chanceWithout.high > 0.02 && requirementsHeld.some((r) => r.from === l.from && r.to === l.to) && !diagnostics.some((x) => x.code === 'requirement-inconsistent' && x.linkIds?.[0] === l.id))
        diagnostics.push({
          severity: 'warning',
          code: 'requirement-inconsistent',
          message: `${name(l.from)} is marked as required for ${name(l.to)}, yet ${name(l.to)} was given a chance of happening without it. One of the two answers may need another look.`,
          linkIds: [l.id],
        });
      effects.set(l.id, d.range);
    }
    if (missing.length) {
      results.push({ ...base, status: 'incomplete', reasons, missingLinkIds: missing.map((l) => l.id) });
      continue;
    }

    // Everything checks out for this action: hand the arithmetic to the formula engine.
    const key = `a${plan.actions.length}`;
    const arrowsInto: PlannedAction['incoming'] = {};
    for (const n of order) {
      if (n === a.id) continue;
      arrowsInto[n] = (inc.get(n) ?? []).map((l) => {
        let v = linkVars.get(l.id);
        if (!v) {
          v = `e${linkVars.size}`;
          linkVars.set(l.id, v);
          const role = roles.get(l.id) ?? ROLES.directChange;
          plan.links[v] = { ...effects.get(l.id)!, linkId: l.id, role, questionId: l.questionIds?.[role] };
        }
        return { from: l.from, linkVar: v };
      });
    }
    plan.actions.push({ key, actionId: a.id, goal, order, incoming: arrowsInto });
    if (usedStale) staleActions.add(a.id);
    results.push({ ...base, status: 'estimated' });
  }

  const program = plan.actions.length > 0 ? compileAdditivePlan(plan) : null;
  const finish = (engine: EngineResult | null): MethodOutput => {
  // Fill in the engine's numbers. Anything it could not give is withheld, never zero.
  for (const planned of plan.actions) {
    const r = results.find((x) => x.actionId === planned.actionId)!;
    const low = engine?.ok ? engine.values[`${planned.key}_lo`] : undefined;
    const high = engine?.ok ? engine.values[`${planned.key}_hi`] : undefined;
    const bad = engine?.ok ? engine.values[`${planned.key}_bad`] : undefined;
    if (low === undefined || high === undefined || !Number.isFinite(low) || !Number.isFinite(high)) {
      r.status = 'withheld';
      r.reasons = [engine && !engine.ok ? `The calculation engine reported a problem: ${engine.error}` : 'The calculation engine did not return a number for this action.'];
    } else if (bad) {
      // Do not clip an impossible total into something that looks valid.
      r.status = 'withheld';
      r.reasons = [`The added-up changes along the way exceed what a chance can change by (more than 100 points), so the assumption that changes add up does not hold for ${name(planned.actionId)}.`];
    } else {
      r.effect = { low, high };
      if (staleActions.has(planned.actionId))
        diagnostics.push({ severity: 'warning', code: 'stale-used', message: `The estimate for ${name(planned.actionId)} uses answers given before a definition or the time horizon changed.`, nodeIds: [planned.actionId] });
    }
  }

  // A link that sits beside a longer route between the same two states is where double counting creeps in.
  const shortcuts = held.filter((l) => descendants(l.from, outgoing(held.filter((o) => o !== l))).has(l.to));
  if (shortcuts.length)
    diagnostics.push({
      severity: 'info',
      code: 'shortcut-links',
      message: `${shortcuts.length} link${shortcuts.length === 1 ? ' sits' : 's sit'} alongside a longer route between the same two points (for example ${linkName(shortcuts[0]!)}). Their estimates should cover only the direct push; otherwise the longer route is counted twice.`,
      linkIds: shortcuts.map((l) => l.id),
    });

  // Only say one action is ahead of another when their whole ranges separate.
  const estimated = results.filter((r) => r.status === 'estimated' && r.effect);
  for (const r of estimated) {
    r.clearlyAheadOf = estimated.filter((o) => o !== r && r.effect!.low > o.effect!.high).map((o) => o.actionId);
  }

  const relevantOpenRequirements = requirementsOpen.filter((r) => toGoal.has(r.to));
  if (relevantOpenRequirements.length)
    diagnostics.push({
      severity: 'info',
      code: 'requirements-not-reviewed',
      message: `${relevantOpenRequirements.length} possible requirement${relevantOpenRequirements.length === 1 ? '' : 's'} on the way to the goal that this person has not confirmed or rejected. If any holds, affected numbers would be withheld.`,
      linkIds: relevantOpenRequirements.map((l) => l.id),
    });
  const leftOut = influenceAll.filter((l) => l.stance === 'unstated');
  if (settings.unstatedLinks === 'leave-out' && leftOut.length)
    diagnostics.push({
      severity: 'info',
      code: 'unstated-left-out',
      message: `${leftOut.length} link${leftOut.length === 1 ? '' : 's'} in the shared map this person has not given a view on; left out of their results.`,
      linkIds: leftOut.map((l) => l.id),
    });
  if (actions.length === 0) diagnostics.push({ severity: 'info', code: 'no-actions', message: 'No actions have been proposed yet.' });

  const nEstimated = estimated.length;
  const nWithheld = results.filter((r) => r.status === 'withheld').length;
  const nIncomplete = results.filter((r) => r.status === 'incomplete').length;
  const status: MethodOutput['status'] =
    actions.length === 0 ? 'not-applicable' : nEstimated === results.length ? 'ok' : nEstimated > 0 ? 'partial' : 'withheld';
  const parts = [`${nEstimated} estimated`];
  if (nIncomplete) parts.push(`${nIncomplete} incomplete`);
  if (nWithheld) parts.push(`${nWithheld} withheld`);
  const nNot = results.filter((r) => r.status === 'not-connected').length;
  if (nNot) parts.push(`${nNot} not connected`);
  return {
    ranking: rankByRange(estimated, results.length),
    status,
    headline: actions.length === 0 ? 'No actions yet.' : `${actions.length} action${actions.length === 1 ? '' : 's'}: ${parts.join(', ')}.`,
    actions: results,
    diagnostics,
    bottlenecks: findBottlenecks(model),
  };
  };
  return { program, plan, finish };
}

/**
 * Order actions by estimated change, best first, but only as far as the ranges allow:
 * actions whose ranges overlap (directly or through a chain of overlaps) share a tier.
 */
export function rankByRange(estimated: ActionResult[], totalActions: number): Ranking | undefined {
  if (estimated.length === 0) return undefined;
  const sorted = [...estimated].sort((a, b) => b.effect!.high + b.effect!.low - (a.effect!.high + a.effect!.low) || a.actionId.localeCompare(b.actionId));
  const tiers: string[][] = [];
  let floor = Infinity; // lowest lower-bound in the current tier
  for (const r of sorted) {
    if (tiers.length > 0 && r.effect!.high >= floor) {
      tiers[tiers.length - 1]!.push(r.actionId);
      floor = Math.min(floor, r.effect!.low);
    } else {
      tiers.push([r.actionId]);
      floor = r.effect!.low;
    }
  }
  const complete = estimated.length === totalActions;
  const left = totalActions - estimated.length;
  return {
    tiers,
    complete,
    note: complete
      ? 'Holds only under this method’s assumptions. Actions in the same tier cannot be told apart.'
      : `Covers ${estimated.length} of ${totalActions} actions. ${left} could not be estimated and ${left === 1 ? 'is' : 'are'} not placed — which is not the same as ranking last.`,
  };
}

// — a second variant: ask for two chances per arrow instead of one change —

const TWO_HELP =
  'Assume everything else goes the way you expect, including what people outside this room are likely to do anyway. Count only the direct push on “{to}”, not what happens by way of other items on the map.';

const twoChanceTemplates: QuestionTemplate[] = [
  { id: 'chance-if-we-act', title: 'Chance if we do it', prompt: 'If people in this room do “{from}”, how likely is “{to}” by {horizon}?', fromKinds: ['action'], role: ROLES.probIfSource },
  { id: 'chance-if-we-dont', title: 'Chance if we do not', prompt: 'If nobody in this room does “{from}”, how likely is “{to}” by {horizon}?', fromKinds: ['action'], role: ROLES.probIfNoSource },
  { id: 'chance-if-happens', title: 'Chance if it happens', prompt: 'If “{from}” happens, how likely is “{to}” by {horizon}?', fromKinds: ['state', 'goal'], role: ROLES.probIfSource },
  { id: 'chance-if-not', title: 'Chance if it does not', prompt: 'If “{from}” does not happen, how likely is “{to}” by {horizon}?', fromKinds: ['state', 'goal'], role: ROLES.probIfNoSource },
].map(
  (t): QuestionTemplate => ({
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    help: TWO_HELP,
    subject: { type: 'link', relations: ['influence'], fromKinds: t.fromKinds as ('action' | 'state' | 'goal')[] },
    answer: { type: 'probability', allowRange: true },
    stageId: 'estimates',
    generate: 'when-method-requires',
    role: t.role,
    allowUnsure: true,
    version: 1,
  }),
);

/**
 * Same arithmetic and the same safeguards as the method above; only the questions differ.
 * Each arrow gets two chances, and the change is the difference between them. That costs a second
 * answer per arrow, but an answer near 0% or 100% now says something a bare change cannot,
 * which is what makes pooling in log-odds possible when maps are combined.
 */
export const twoChances: CalculationMethod<LocalAdditiveSettings> = {
  ...localAdditive,
  id: 'local-additive-two-chances',
  version: '1.0.0',
  name: 'Rank actions from two chances per arrow (local additive approximation)',
  summary:
    'Asks, for each arrow, how likely the next thing is if this happens and if it does not, and takes the difference as the change. Then ranks actions exactly as the added-up-changes method does. It still reports only changes to the chance of the goal, never that chance itself, and gives no number or rank wherever its assumptions visibly fail.',
  assumptions: [
    'Both chances for an arrow are judged against the same expected future: everything else as the person expects, including what others are likely to do, differing only in whether this one thing happens.',
    'The change along an arrow is the first chance minus the second. With ranges, the widest change consistent with both ranges is used.',
    ...localAdditive.assumptions.slice(1),
  ],
  limits: [
    'Two chances per arrow still do not say how several causes of the same thing combine. This is an approximation for ranking, not a causal model.',
    ...localAdditive.limits.slice(1),
  ],
  requiredInputs: [
    'For each arrow from an action: how likely the state it points at is if people here do it, and if nobody here does.',
    'For each other arrow: how likely the next item is if the first happens, and if it does not.',
    'Two answers per arrow. “Not sure” on either leaves the affected actions unranked.',
  ],
  example: {
    ...localAdditive.example,
    caption: 'The two chances for each arrow, written as “if it happens / if not”.',
    arrows: [
      { from: 'a1', to: 's1', label: '70 / 20' },
      { from: 'a2', to: 's2', label: '60 / 30' },
      { from: 's1', to: 's2', label: '55 / 40' },
      { from: 's1', to: 'g', label: '50 / 30' },
      { from: 's2', to: 'g', label: '50 / 35' },
    ],
    outcome: 'Changes are +50, +30, +15, +20, +15. Action 1: 0.50 × (0.20 + 0.15 × 0.15) ≈ +11 points. Action 2: 0.30 × 0.15 ≈ +5 points. Action 1 ranks first.',
  },
  consumes: [ROLES.linkStance, ROLES.probIfSource, ROLES.probIfNoSource],
  elicitation: twoChanceTemplates,
  prepare: (model, settings) => prepareLocalAdditive(model, settings, effectFromTwoChances),
};
