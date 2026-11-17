/**
 * What each client is allowed to see. The server sends every client a view
 * already filtered for them, so hidden answers never reach another phone.
 */
import { questionLayer } from './engine';
import { renderQuestion } from './templates';
import type { ModelLink, ModelNode, Role, WorkshopState, WorkshopView } from './types';

const KIND_LAYER = { goal: 'goals', state: 'states', action: 'actions' } as const;

/** Has this participant responded to this question in any way? */
export function hasResponded(state: WorkshopState, questionId: string, participantId: string): boolean {
  if (state.answers[questionId]?.[participantId]?.length) return true;
  const q = state.questions[questionId];
  if (!q) return false;
  const type = renderQuestion(state, q).answer.type;
  if (type === 'suggestions' || type === 'nominate-links') {
    if (Object.values(state.suggestions).some((s) => s.questionId === questionId && s.participantId === participantId && s.status !== 'withdrawn')) return true;
    return Object.values(state.links).some((l) => l.provenance.some((p) => p.detail?.questionId === questionId && p.detail?.nominatedBy === participantId));
  }
  return false;
}

export function viewFor(state: WorkshopState, role: Role, joinCode: string, online: string[]): WorkshopView {
  const active = Object.values(state.participants).filter((p) => p.active);
  const progress: WorkshopView['progress'] = {};
  for (const q of Object.values(state.questions)) {
    if (q.rounds === 0 && !state.answers[q.id]) continue;
    const respondedIds = active.filter((p) => hasResponded(state, q.id, p.id)).map((p) => p.id);
    progress[q.id] = role.type === 'facilitator' ? { responded: respondedIds.length, total: active.length, respondedIds } : { responded: respondedIds.length, total: active.length };
  }

  if (role.type === 'facilitator') return { ...state, role, joinCode, progress, online };

  const me = role.id;
  const shareAll = state.settings.shareModels;
  const layers = state.settings.layers;

  // Catalogue: a personal item is its owner's until that layer is pooled.
  const nodes: Record<string, ModelNode> = {};
  for (const n of Object.values(state.nodes)) {
    if (!n.owner || n.owner === me || shareAll || layers[KIND_LAYER[n.kind]].pooled) nodes[n.id] = n;
  }
  // Arrows: you see the ones you have a view on, ones the facilitator put up, and — if pooled — everyone's candidates.
  // Seeing a candidate arrow is not holding it, and it does not show who does.
  const links: Record<string, ModelLink> = {};
  const linkQuestionIds = new Map<string, string[]>();
  for (const q of Object.values(state.questions)) {
    if (q.subject.type === 'link') (linkQuestionIds.get(q.subject.linkId) ?? linkQuestionIds.set(q.subject.linkId, []).get(q.subject.linkId)!).push(q.id);
  }
  for (const l of Object.values(state.links)) {
    if (!nodes[l.from] || !nodes[l.to]) continue;
    const fromFacilitator = l.provenance[0]?.actor.type !== 'participant';
    const iHaveAView = (linkQuestionIds.get(l.id) ?? []).some((qid) => state.answers[qid]?.[me]?.length);
    if (shareAll || layers.connections.pooled || fromFacilitator || iHaveAView) links[l.id] = l;
  }
  const questions: WorkshopState['questions'] = {};
  for (const q of Object.values(state.questions)) {
    if (q.subject.type === 'node' && !nodes[q.subject.nodeId]) continue;
    if (q.subject.type === 'link' && !links[q.subject.linkId]) continue;
    questions[q.id] = q;
  }
  const visibleQuestion = (id: string) => {
    const q = state.questions[id];
    if (!q) return false;
    return shareAll || q.revealed || (layers.estimates.pooled && questionLayer(state, q) === 'estimates');
  };

  const answers: WorkshopState['answers'] = {};
  for (const [qid, byParticipant] of Object.entries(state.answers)) {
    if (!questions[qid]) continue;
    if (visibleQuestion(qid)) {
      answers[qid] = byParticipant;
    } else if (byParticipant[me]) {
      answers[qid] = { [me]: byParticipant[me] };
    }
  }
  const suggestions: WorkshopState['suggestions'] = {};
  for (const s of Object.values(state.suggestions)) {
    const resolvedIntoMap = s.status === 'accepted' || s.status === 'merged';
    if (s.participantId === me || resolvedIntoMap || visibleQuestion(s.questionId)) suggestions[s.id] = s;
  }
  // Combined models: your own, plus everyone's once models are shared.
  const syntheses = Object.fromEntries(Object.entries(state.syntheses).filter(([, s]) => shareAll || (s.createdBy.type === 'participant' && s.createdBy.id === me)));
  // A run carries results AND the generated formulas (which contain people's numbers) per model.
  // Everything keyed by model is filtered the same way: your own, and combined models you may see.
  const mayKey = (key: string) => shareAll || key === me || (key.startsWith('syn:') && !!syntheses[key.slice(4)]);
  const only = <T,>(record: Record<string, T> | undefined, test: (key: string) => boolean) => (record ? Object.fromEntries(Object.entries(record).filter(([key]) => test(key))) : undefined);
  const runs = state.runs.map((r) => ({
    ...r,
    outputs: only(r.outputs, mayKey)!,
    programs: only(r.programs, mayKey),
    synthesisVersions: only(r.synthesisVersions, (id) => shareAll || !!syntheses[id]),
  }));
  for (const key of Object.keys(progress)) if (!questions[key]) delete progress[key];
  return { ...state, nodes, links, questions, answers, suggestions, syntheses, runs, role, joinCode, progress, online };
}
