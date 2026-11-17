/**
 * Turns the workshop state into ONE participant's model, as plain data.
 * This is the only thing calculation methods ever see.
 */
import { ROLES } from './config';
import type { Belief, ModelLinkInput, ModelNodeInput, ParticipantModel, Stance } from './calc/types';
import { activeLink, knownTemplates, latestAnswer, matchesFilter, questionId, staleReason } from './templates';
import type { QuestionSubject, WorkshopState } from './types';

function beliefsFor(state: WorkshopState, participantId: string, subject: QuestionSubject, questionIds?: Record<string, string>): Record<string, Belief> {
  const beliefs: Record<string, Belief> = {};
  for (const t of knownTemplates(state.config)) {
    if (!t.role || !matchesFilter(state, t.subject, subject)) continue;
    const q = state.questions[questionId(t.id, subject)];
    const a = q ? latestAnswer(state, q.id, participantId) : undefined;
    if (!q || !a) {
      beliefs[t.role] ??= { state: 'unanswered' };
      continue;
    }
    const stale = staleReason(state, q, a) !== null;
    const belief: Belief =
      a.value.kind === 'unsure'
        ? { state: 'unsure', stale, reasoning: a.reasoning }
        : { state: 'answered', value: a.value, stale, needsReview: !!a.needsReview, reasoning: a.reasoning };
    const existing = beliefs[t.role];
    // Several templates can carry the same role; an actual answer beats "unanswered".
    if (!existing || existing.state === 'unanswered') {
      beliefs[t.role] = belief;
      if (questionIds) questionIds[t.role] = q.id;
    }
  }
  return beliefs;
}

export function stanceOf(belief: Belief | undefined): { stance: Stance; stale: boolean; direction?: 'helps' | 'harms'; mechanism?: string } {
  if (!belief || belief.state === 'unanswered') return { stance: 'unstated', stale: false };
  if (belief.state === 'unsure') return { stance: 'unsure', stale: belief.stale, mechanism: belief.reasoning };
  const stale = belief.stale || belief.needsReview;
  const mechanism = belief.reasoning;
  const choice = belief.value.kind === 'choice' ? belief.value.choice : '';
  if (choice === 'yes') return { stance: 'yes', direction: 'helps', stale, mechanism };
  if (choice === 'harms') return { stance: 'yes', direction: 'harms', stale, mechanism };
  if (choice === 'conditional') return { stance: 'conditional', stale, mechanism };
  if (choice === 'no') return { stance: 'no', stale, mechanism };
  // Any other option a facilitator added (e.g. "partly") is not a clear yes or no.
  return { stance: 'unsure', stale: belief.stale, mechanism };
}

export function buildParticipantModel(state: WorkshopState, participantId: string): ParticipantModel {
  const nodes: ModelNodeInput[] = [];
  for (const n of Object.values(state.nodes)) {
    if (n.status !== 'active') continue;
    // Unchosen goal candidates are not part of anyone's model.
    if (n.kind === 'goal' && state.goal.nodeId !== n.id) continue;
    nodes.push({ id: n.id, kind: n.kind, label: n.label, beliefs: beliefsFor(state, participantId, { type: 'node', nodeId: n.id }) });
  }
  const present = new Set(nodes.map((n) => n.id));
  const links: ModelLinkInput[] = [];
  for (const l of Object.values(state.links)) {
    if (!activeLink(state, l.id) || !present.has(l.from) || !present.has(l.to)) continue;
    const questionIds: Record<string, string> = {};
    const beliefs = beliefsFor(state, participantId, { type: 'link', linkId: l.id }, questionIds);
    const { stance, stale, direction, mechanism } = stanceOf(beliefs[ROLES.linkStance]);
    links.push({ id: l.id, from: l.from, to: l.to, relation: l.relation, stance, direction: l.relation === 'influence' ? direction : undefined, mechanism, stanceStale: stale, beliefs, questionIds });
  }
  return { participantId, goalId: state.goal.nodeId, horizon: state.goal.horizon, nodes, links };
}

export interface ModelDifference {
  linkId: string;
  kind: 'structure' | 'estimate';
  a: string;
  b: string;
}

function describeBelief(b: Belief | undefined): string {
  if (!b || b.state === 'unanswered') return 'no answer';
  if (b.state === 'unsure') return 'not sure';
  const v = b.value;
  if (v.kind === 'probability') return v.low !== undefined && v.high !== undefined ? `${pct(v.low)}–${pct(v.high)}` : pct(v.p);
  if (v.kind === 'difference') return v.low !== undefined && v.high !== undefined ? `${points(v.low)} to ${points(v.high)}` : points(v.d);
  if (v.kind === 'choice') return v.choice;
  if (v.kind === 'text') return v.text;
  return 'answered';
}

/** A change in a chance, e.g. "+20 points". */
export function points(d: number): string {
  const v = Math.round(d * 1000) / 10;
  return `${v > 0 ? '+' : ''}${v} points`;
}

export function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export const STANCE_WORDS: Record<Stance, string> = {
  yes: 'includes this',
  conditional: 'only under some conditions',
  no: 'rejects this',
  unsure: 'not sure',
  unstated: 'not reviewed',
};

/** Where two people's models differ. Structural differences first; nothing is reconciled. */
export function compareModels(a: ParticipantModel, b: ParticipantModel): ModelDifference[] {
  const result: ModelDifference[] = [];
  const bLinks = new Map(b.links.map((l) => [l.id, l]));
  for (const la of a.links) {
    const lb = bLinks.get(la.id);
    if (!lb) continue;
    if (la.stance !== lb.stance || la.direction !== lb.direction) {
      const words = (l: typeof la) => (l.stance === 'yes' && l.direction === 'harms' ? 'includes this (makes it less likely)' : STANCE_WORDS[l.stance]);
      result.push({ linkId: la.id, kind: 'structure', a: words(la), b: words(lb) });
      continue;
    }
    if (la.stance !== 'yes') continue;
    for (const role of new Set([...Object.keys(la.beliefs), ...Object.keys(lb.beliefs)])) {
      if (role === ROLES.linkStance || role === ROLES.linkFailureModes) continue;
      const da = describeBelief(la.beliefs[role]);
      const db = describeBelief(lb.beliefs[role]);
      if (da !== db) result.push({ linkId: la.id, kind: 'estimate', a: `${roleWords(role)}: ${da}`, b: `${roleWords(role)}: ${db}` });
    }
  }
  return result;
}

export function roleWords(role: string): string {
  switch (role) {
    case ROLES.probIfSource:
      return 'chance if it happens';
    case ROLES.probIfNoSource:
      return 'chance if it does not';
    case ROLES.directChange:
      return 'how much it changes the next thing';
    case ROLES.baseline:
      return 'chance on the expected course';
    case ROLES.linkStance:
      return 'view';
    case ROLES.linkFailureModes:
      return 'how it could fail';
    default:
      return role;
  }
}
