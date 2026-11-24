/**
 * Bringing several people's models together — as a preview first, then as a
 * separate, versioned object. Personal models are read, never changed.
 */
import { getAggregation, resolveAggregationSettings } from './aggregate/registry';
import type { AggregationResult, Contribution } from './aggregate/types';
import type { Belief, ModelLinkInput, ParticipantModel } from './calc/types';
import { ROLES } from './config';
import { findLoop } from './cycles';
import { buildParticipantModel, roleWords } from './model';
import type { SynthesisVersion, WorkshopState } from './types';

export interface ArrowReview {
  linkId: string;
  from: string;
  to: string;
  relation: 'influence' | 'requirement';
  holds: string[];
  conditional: string[];
  rejects: string[];
  unsure: string[];
  /** Has it in view but has not said either way — not the same as rejecting it. */
  unreviewed: string[];
  helps: string[];
  harms: string[];
  /** Everyone contributing holds it outright. */
  agreed: boolean;
  decision: 'include' | 'exclude' | 'undecided';
  included: boolean;
}

export interface PooledEstimate {
  linkId: string;
  role: string;
  roleLabel: string;
  /** Whether the numbers are chances (0–1) or changes in a chance (−1 to +1). */
  unit: 'probability' | 'difference';
  result: AggregationResult;
  conditionsDiffer: boolean;
  individual: Contribution[];
}

export interface SynthesisPreview {
  arrows: ArrowReview[];
  /** A loop among the arrows chosen for the combined map (it cannot be saved until this is resolved). */
  includedLoop: string[] | null;
  /** A loop that would appear if everyone's arrows were simply put together. */
  unionLoop: string[] | null;
  estimates: PooledEstimate[];
  /** Items whose names look alike and may be the same thing said twice. */
  possibleDuplicates: { a: string; b: string }[];
  /** Estimates that should be asked again against the combined map. */
  reviewCount: number;
  aggregationProblems: string[];
}

const HOLD = new Set(['yes', 'conditional']);

function words(label: string): Set<string> {
  const stop = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'for', 'in', 'on', 'is', 'are', 'be', 'with', 'more', 'less']);
  return new Set(label.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !stop.has(w)));
}

/** How alike two labels are, 0–1 (shared words over all words). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

function contribution(participantId: string, belief: Belief | undefined): Contribution {
  if (!belief || belief.state === 'unanswered') return { participantId, state: 'unanswered' };
  if (belief.state === 'unsure') return { participantId, state: 'unsure' };
  const v = belief.value;
  if (v.kind !== 'probability' && v.kind !== 'difference') return { participantId, state: 'unanswered' };
  const p = v.kind === 'probability' ? v.p : v.d;
  return { participantId, state: belief.stale || belief.needsReview ? 'needs-review' : 'answered', p, low: v.low, high: v.high };
}

function decide(spec: Pick<SynthesisVersion, 'decisions'>, linkId: string, agreed: boolean): ArrowReview['decision'] {
  const explicit = spec.decisions[linkId];
  if (explicit) return explicit;
  return agreed ? 'include' : 'undecided';
}

export function previewSynthesis(state: WorkshopState, spec: Pick<SynthesisVersion, 'contributors' | 'decisions' | 'aggregation'>): SynthesisPreview {
  const contributors = spec.contributors.filter((id) => state.participants[id]);
  const models = new Map(contributors.map((id) => [id, buildParticipantModel(state, id)]));
  const first = models.get(contributors[0] ?? '');
  const arrows: ArrowReview[] = [];
  const perLink = new Map<string, Map<string, ModelLinkInput>>();
  for (const [pid, m] of models) for (const l of m.links) (perLink.get(l.id) ?? perLink.set(l.id, new Map()).get(l.id)!).set(pid, l);

  for (const l of first?.links ?? []) {
    const by = perLink.get(l.id)!;
    const pick = (test: (x: ModelLinkInput) => boolean) => contributors.filter((p) => by.get(p) && test(by.get(p)!));
    const holds = pick((x) => x.stance === 'yes');
    const conditional = pick((x) => x.stance === 'conditional');
    if (holds.length + conditional.length === 0) continue; // nobody contributing has this arrow: it is simply not in the combined map
    const agreed = holds.length === contributors.length;
    const decision = decide(spec, l.id, agreed);
    arrows.push({
      linkId: l.id,
      from: l.from,
      to: l.to,
      relation: l.relation,
      holds,
      conditional,
      rejects: pick((x) => x.stance === 'no'),
      unsure: pick((x) => x.stance === 'unsure'),
      unreviewed: pick((x) => x.stance === 'unstated'),
      helps: pick((x) => x.stance === 'yes' && x.direction === 'helps'),
      harms: pick((x) => x.stance === 'yes' && x.direction === 'harms'),
      agreed,
      decision,
      included: decision === 'include',
    });
  }

  const included = arrows.filter((a) => a.included);
  const includedLoop = findLoop(included);
  const unionLoop = findLoop(arrows);

  // Pool estimates only for arrows in the combined map, question by question.
  const method = getAggregation(spec.aggregation.methodId);
  const aggregationProblems: string[] = [];
  let settings: unknown = {};
  if (!method) aggregationProblems.push(`There is no aggregation method called "${spec.aggregation.methodId}".`);
  else {
    const resolved = resolveAggregationSettings(method, spec.aggregation.settings);
    if (resolved.ok) settings = resolved.settings;
    else aggregationProblems.push(...resolved.problems);
  }
  const combinedParents = (target: string) => included.filter((a) => a.to === target).map((a) => a.linkId).sort().join('|');
  const ownParents = (pid: string, target: string) =>
    models.get(pid)!.links.filter((x) => x.to === target && HOLD.has(x.stance)).map((x) => x.id).sort().join('|');

  const estimates: PooledEstimate[] = [];
  if (method && aggregationProblems.length === 0) {
    for (const a of included) {
      const by = perLink.get(a.linkId)!;
      const roles = new Set<string>();
      for (const l of by.values()) for (const role of Object.keys(l.beliefs)) if (role !== ROLES.linkStance && role !== ROLES.linkFailureModes) roles.add(role);
      for (const role of roles) {
        const individual = contributors.map((pid) => contribution(pid, by.get(pid)?.beliefs[role]));
        if (!individual.some((c) => c.p !== undefined || c.state === 'unsure')) continue;
        const answering = individual.filter((c) => c.state === 'answered').map((c) => c.participantId);
        const target = combinedParents(a.to);
        const conditionsDiffer = answering.some((pid) => ownParents(pid, a.to) !== target);
        const unit = [...by.values()].some((l) => { const b = l.beliefs[role]; return b?.state === 'answered' && b.value.kind === 'difference'; }) ? 'difference' : 'probability';
        estimates.push({ linkId: a.linkId, role, roleLabel: roleWords(role), unit, result: method.aggregate({ contributions: individual, unit, conditionsDiffer }, settings), conditionsDiffer, individual });
      }
    }
  }

  const nodes = Object.values(state.nodes).filter((n) => n.status === 'active');
  const possibleDuplicates: { a: string; b: string }[] = [];
  if (nodes.length <= 400) {
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        if (nodes[i]!.kind === nodes[j]!.kind && similarity(nodes[i]!.label, nodes[j]!.label) >= 0.6) possibleDuplicates.push({ a: nodes[i]!.id, b: nodes[j]!.id });
  }

  return {
    arrows,
    includedLoop,
    unionLoop,
    estimates,
    possibleDuplicates: possibleDuplicates.slice(0, 50),
    reviewCount: estimates.filter((e) => e.result.flagged || e.result.needsReview.length > 0).length,
    aggregationProblems,
  };
}

export const SYNTHESIS_PREFIX = 'syn:';

/** The combined model as a calculation method sees it: chosen arrows, pooled inputs. Its own thing, attributed to nobody. */
export function buildSynthesisModel(state: WorkshopState, synthesisId: string): ParticipantModel {
  const syn = state.syntheses[synthesisId]!;
  const preview = previewSynthesis(state, syn);
  const base = buildParticipantModel(state, syn.contributors.find((id) => state.participants[id]) ?? '');
  const pooled = new Map<string, PooledEstimate[]>();
  for (const e of preview.estimates) (pooled.get(e.linkId) ?? pooled.set(e.linkId, []).get(e.linkId)!).push(e);
  const links: ModelLinkInput[] = preview.arrows
    .filter((a) => a.included)
    .map((a) => {
      const beliefs: Record<string, Belief> = {};
      for (const e of pooled.get(a.linkId) ?? []) {
        const v = e.result.value;
        beliefs[e.role] = !v
          ? { state: 'unanswered' }
          : { state: 'answered', value: e.unit === 'difference' ? { kind: 'difference', d: v.p, low: v.low, high: v.high } : { kind: 'probability', ...v }, stale: false, needsReview: e.result.flagged };
      }
      // An arrow some hold only conditionally stays conditional in the combined map: the interaction does not vanish by combining.
      const stance = a.conditional.length > 0 ? 'conditional' : 'yes';
      const direction = a.relation !== 'influence' ? undefined : a.harms.length > 0 && a.helps.length === 0 ? 'harms' : 'helps';
      return { id: a.linkId, from: a.from, to: a.to, relation: a.relation, stance, direction, stanceStale: false, beliefs };
    });
  return { participantId: `${SYNTHESIS_PREFIX}${synthesisId}`, goalId: state.goal.nodeId, horizon: state.goal.horizon, nodes: base.nodes.map((n) => ({ ...n, beliefs: {} })), links };
}
