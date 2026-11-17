import { describe, expect, it } from 'vitest';
import { ROLES } from '../../shared/config';
import { buildParticipantModel, compareModels } from '../../shared/model';
import { latestAnswer, questionId, renderQuestion, staleReason } from '../../shared/templates';
import type { Role } from '../../shared/types';
import { FAC, seeded, setup } from './helpers';

const P = (id: string): Role => ({ type: 'participant', id });

describe('a workshop builds its own model from nothing', () => {
  it('starts empty, with only the workshop-level questions waiting', () => {
    const t = setup();
    const v = t.view();
    expect(Object.keys(v.nodes)).toEqual([]);
    expect(Object.keys(v.links)).toEqual([]);
    expect(Object.values(v.questions).map((q) => q.templateId).sort()).toEqual(['goal-preference', 'propose-goals']);
    expect(v.liveQuestionId).toBeNull();
  });

  it('goes from proposed goals to a chosen goal to recursive follow-up questions, one live question at a time', () => {
    const t = setup();
    const alex = t.join('Alex').participantId;
    const sam = t.join('Sam').participantId;
    const goalsQ = questionId('propose-goals', { type: 'workshop' });

    // Nothing can be suggested before the facilitator asks.
    expect(() => t.as(alex)({ type: 'suggest', questionId: goalsQ, text: 'Too early' })).toThrow(/not open/);

    t.fac({ type: 'publish_question', questionId: goalsQ });
    expect(t.view(P(alex)).liveQuestionId).toBe(goalsQ);
    expect(t.view(P(sam)).liveQuestionId).toBe(goalsQ);

    t.as(alex)({ type: 'suggest', questionId: goalsQ, text: 'Safer streets' });
    t.as(sam)({ type: 'suggest', questionId: goalsQ, text: 'safe streets for kids' });
    t.as(sam)({ type: 'suggest', questionId: goalsQ, text: 'More trees' });

    // No anchoring: before the facilitator reveals, each person sees only their own suggestions.
    expect(Object.values(t.view(P(alex)).suggestions).map((s) => s.text)).toEqual(['Safer streets']);
    expect(Object.values(t.view(P(sam)).suggestions).map((s) => s.text).sort()).toEqual(['More trees', 'safe streets for kids']);
    expect(t.view(P(alex)).progress[goalsQ]).toEqual({ responded: 2, total: 2 });

    const sug = (text: string) => Object.values(t.view().suggestions).find((s) => s.text === text)!;
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('Safer streets').id, resolution: 'accept' });
    const goal = t.node('Safer streets');
    expect(goal.kind).toBe('goal');

    // Merging a duplicate needs explicit confirmation and keeps who said what.
    expect(() => t.fac({ type: 'resolve_suggestion', suggestionId: sug('safe streets for kids').id, resolution: 'merge', intoNodeId: goal.id })).toThrow(/confirmed/);
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('safe streets for kids').id, resolution: 'merge', intoNodeId: goal.id, confirm: true });
    const merged = t.node('Safer streets');
    expect(merged.provenance.map((p) => p.event)).toEqual(['from-suggestion', 'merged-in']);
    expect(merged.provenance[1]!.detail).toMatchObject({ originalText: 'safe streets for kids', participantId: sam });
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('More trees').id, resolution: 'decline' });
    expect(sug('More trees').status).toBe('declined'); // set aside, not deleted

    // Unchosen goal candidates do not spawn follow-ups; choosing one does.
    const before = Object.values(t.view().questions).filter((q) => q.subject.type === 'node');
    expect(before).toEqual([]);
    t.fac({ type: 'select_goal', nodeId: goal.id, successDefinition: 'No serious injuries', horizon: '2030' });
    const forGoal = Object.values(t.view().questions).filter((q) => q.subject.type === 'node' && q.subject.nodeId === goal.id).map((q) => q.templateId).sort();
    expect(forGoal).toEqual(['success-definition', 'what-could-we-do', 'what-would-help']);

    // Publishing a new question closes the previous one.
    const helpQ = questionId('what-would-help', { type: 'node', nodeId: goal.id });
    t.fac({ type: 'publish_question', questionId: helpQ });
    expect(t.view().questions[goalsQ]!.status).toBe('closed');
    expect(renderQuestion(t.view(), t.view().questions[helpQ]!).prompt).toBe('What would make “Safer streets” more likely?');

    t.as(alex)({ type: 'suggest', questionId: helpQ, text: 'Slower traffic' });
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('Slower traffic').id, resolution: 'accept' });
    const state = t.node('Slower traffic');
    expect(state.kind).toBe('state');
    // The accepted state immediately has its own follow-up questions: the workshop recurses.
    const forState = Object.values(t.view().questions).filter((q) => q.subject.type === 'node' && q.subject.nodeId === state.id).map((q) => q.templateId).sort();
    expect(forState).toEqual(['what-could-we-do', 'what-would-help']);

    // Working backwards names things; it draws no arrows. The map starts unconnected.
    expect(Object.keys(t.view().links)).toEqual([]);
    expect(state.elicitedFor).toBe(goal.id); // remembered for a rough layout only

    // A requirement is a different kind of claim from an influence, and is its proposer's claim alone.
    t.fac({ type: 'add_template_question', templateId: 'what-is-required', subject: { type: 'node', nodeId: goal.id } });
    const reqQ = questionId('what-is-required', { type: 'node', nodeId: goal.id });
    t.fac({ type: 'publish_question', questionId: reqQ });
    t.as(sam)({ type: 'suggest', questionId: reqQ, text: 'Council funding' });
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('Council funding').id, resolution: 'accept' });
    const funding = t.node('Council funding');
    expect(Object.values(t.view().links).find((l) => l.from === funding.id)!.relation).toBe('requirement');
    expect(buildParticipantModel(t.view(), sam).links[0]!.stance).toBe('yes');
    expect(buildParticipantModel(t.view(), alex).links[0]!.stance).toBe('unstated');

    // Actions are their own kind.
    const actQ = questionId('what-could-we-do', { type: 'node', nodeId: state.id });
    t.fac({ type: 'publish_question', questionId: actQ });
    t.as(alex)({ type: 'suggest', questionId: actQ, text: 'Petition for speed bumps' });
    t.fac({ type: 'resolve_suggestion', suggestionId: sug('Petition for speed bumps').id, resolution: 'accept' });
    expect(t.node('Petition for speed bumps').kind).toBe('action');

    // "Nothing to add" is recorded as a response, not as content.
    t.as(sam)({ type: 'answer', questionId: actQ, value: { kind: 'done' } });
    expect(t.view().progress[actQ]).toMatchObject({ responded: 2, total: 2 });
  });

  it('only asks probability questions when the selected method consumes them', () => {
    const t = seeded();
    const has = (templateId: string) => Object.values(t.view().questions).some((q) => q.templateId === templateId && q.status === 'draft');
    expect(has('change-from-state')).toBe(false);
    expect(has('change-from-action')).toBe(false);
    // No starting chance of any state is ever asked by default.
    expect(Object.values(t.view().questions).some((q) => q.subject.type === 'node' && renderQuestion(t.view(), q).answer.type === 'probability')).toBe(false);
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    expect(has('change-from-state')).toBe(true);
    expect(has('change-from-action')).toBe(true);
    expect(Object.values(t.view().questions).some((q) => q.subject.type === 'node' && renderQuestion(t.view(), q).answer.type === 'probability')).toBe(false);
    expect(has('failure-modes')).toBe(true); // recordable regardless of method
    // Switching back sets the unasked ones aside without losing anything.
    config.calculation.methodId = 'structure-diagnostic';
    t.fac({ type: 'set_config', config });
    expect(has('change-from-state')).toBe(false);
    expect(has('failure-modes')).toBe(true);
  });

  it('rejects configuration that would break the app, and accepts reworded questions and new stages', () => {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.templates = config.templates.filter((x) => x.id !== 'requirement-stance');
    expect(() => t.fac({ type: 'set_config', config })).toThrow(/link\.stance/);

    const good = structuredClone(t.view().config);
    good.stages.push({ id: 'wrap-up', title: 'Wrap up', description: '', facilitatorHint: '' });
    good.templates.find((x) => x.id === 'what-would-help')!.prompt = 'What would move “{subject}” forward?';
    good.templates.push({
      id: 'first-step',
      title: 'First step',
      prompt: 'What is the smallest first step on “{subject}”?',
      subject: { type: 'node', kinds: ['action'] },
      answer: { type: 'text' },
      stageId: 'wrap-up',
      generate: 'always',
      allowUnsure: true,
      version: 1,
    });
    good.labels.state = 'Condition';
    t.fac({ type: 'set_config', config: good });
    const v = t.view();
    expect(renderQuestion(v, v.questions[questionId('what-would-help', { type: 'node', nodeId: t.S1 })]!).prompt).toBe('What would move “S1” forward?');
    expect(v.questions[questionId('first-step', { type: 'node', nodeId: t.A1 })]!.status).toBe('draft');
    const bad = structuredClone(good);
    bad.calculation.methodId = 'does-not-exist';
    expect(() => t.fac({ type: 'set_config', config: bad })).toThrow(/no calculation method/);
  });
});

describe('connection discovery', () => {
  it('builds a shortlist from nominations and keeps each person’s review separate', () => {
    const t = seeded();
    t.fac({ type: 'add_node', kind: 'state', label: 'S3' });
    const S3 = t.node('S3').id;
    t.fac({ type: 'add_template_question', templateId: 'find-connections', subject: { type: 'node', nodeId: t.G } });
    const findQ = questionId('find-connections', { type: 'node', nodeId: t.G });
    t.fac({ type: 'publish_question', questionId: findQ });
    expect(t.view().stageId).toBe('connections');

    const linksBefore = Object.keys(t.view().links).length;
    t.as(t.alex)({ type: 'nominate_link', questionId: findQ, sourceNodeId: S3, as: 'helps', mechanism: 'Frees up budget' });
    t.as(t.sam)({ type: 'nominate_link', questionId: findQ, sourceNodeId: S3, as: 'harms', mechanism: 'Distracts the team' });
    t.as(t.sam)({ type: 'nominate_link', questionId: findQ, sourceNodeId: t.S2, as: 'required' });
    // Two people nominating the same pair make one shortlist entry, not two; nothing is created for pairs nobody picked.
    expect(Object.keys(t.view().links).length).toBe(linksBefore + 2);

    const alex = buildParticipantModel(t.view(), t.alex);
    const sam = buildParticipantModel(t.view(), t.sam);
    const s3g = (m: typeof alex) => m.links.find((l) => l.from === S3 && l.to === t.G && l.relation === 'influence')!;
    expect(s3g(alex)).toMatchObject({ stance: 'yes', direction: 'helps', mechanism: 'Frees up budget' });
    expect(s3g(sam)).toMatchObject({ stance: 'yes', direction: 'harms', mechanism: 'Distracts the team' });
    // Sam's requirement is Sam's alone; Alex has simply not reviewed it.
    const req = (m: typeof alex) => m.links.find((l) => l.relation === 'requirement' && l.from === t.S2)!;
    expect(req(sam).stance).toBe('yes');
    expect(req(alex).stance).toBe('unstated');

    // Review: include / reject / conditional / unsure are all distinct, and nobody is outvoted.
    const reviewQ = t.stanceQ(S3, t.G);
    t.fac({ type: 'publish_question', questionId: reviewQ });
    t.as(t.alex)({ type: 'answer', questionId: reviewQ, value: { kind: 'choice', choice: 'conditional' }, reasoning: 'Only if the budget is ring-fenced' });
    expect(s3g(buildParticipantModel(t.view(), t.alex)).stance).toBe('conditional');
    expect(s3g(buildParticipantModel(t.view(), t.sam)).stance).toBe('yes');
    t.as(t.alex)({ type: 'answer', questionId: reviewQ, value: { kind: 'choice', choice: 'no' } });
    expect(s3g(buildParticipantModel(t.view(), t.alex)).stance).toBe('no');
    expect(t.view().links[`l:i:${S3}>${t.G}`]!.status).toBe('active'); // Alex rejecting it does not remove it for Sam
    t.as(t.alex)({ type: 'answer', questionId: reviewQ, value: { kind: 'unsure' } });
    expect(s3g(buildParticipantModel(t.view(), t.alex)).stance).toBe('unsure');

    const diffs = compareModels(buildParticipantModel(t.view(), t.alex), buildParticipantModel(t.view(), t.sam));
    expect(diffs.filter((d) => d.kind === 'structure').map((d) => d.linkId)).toContain(`l:i:${S3}>${t.G}`);

    // Missing prerequisite spotted during the review goes to the facilitator as a suggestion.
    t.fac({ type: 'publish_question', questionId: findQ });
    t.as(t.alex)({ type: 'suggest', questionId: findQ, text: 'A missing prerequisite' });
    const s = Object.values(t.view().suggestions).find((x) => x.text === 'A missing prerequisite')!;
    t.fac({ type: 'resolve_suggestion', suggestionId: s.id, resolution: 'accept' });
    expect(t.view().links[`l:i:${t.node('A missing prerequisite').id}>${t.G}`]).toBeTruthy();
  });

  it('refuses links that point the wrong way', () => {
    const t = seeded();
    expect(() => t.fac({ type: 'add_link', from: t.S1, to: t.A1, relation: 'influence' })).toThrow(/not into an action/);
    expect(() => t.fac({ type: 'add_link', from: t.G, to: t.S1, relation: 'influence' })).toThrow(/not out of it/);
    expect(() => t.fac({ type: 'add_link', from: t.S1, to: t.S1, relation: 'influence' })).toThrow(/itself/);
    expect(() => t.fac({ type: 'hold_link', from: t.S1, to: t.S1, hold: true, participantId: t.alex })).toThrow(/itself/);
  });
});

describe('identity and isolation', () => {
  it('lets two participants hold and edit different answers to the same question without seeing each other’s', () => {
    const t = seeded();
    const q = t.stanceQ(t.S1, t.G);
    t.fac({ type: 'publish_question', questionId: q });
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'yes' }, reasoning: 'Seen it work' });
    t.as(t.sam)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'no' } });

    expect(Object.keys(t.view(P(t.alex)).answers[q]!)).toEqual([t.alex]);
    expect(Object.keys(t.view(P(t.sam)).answers[q]!)).toEqual([t.sam]);
    expect(Object.keys(t.view(FAC).answers[q]!).sort()).toEqual([t.alex, t.sam].sort());

    // Sam changes their mind after the question closed; Alex's answer is untouched and Sam's history is kept.
    t.fac({ type: 'close_question' });
    t.as(t.sam)({ type: 'answer', questionId: q, value: { kind: 'unsure' } });
    const v = t.view();
    expect(v.answers[q]![t.sam]!.map((a) => [a.revision, a.value.kind, a.source])).toEqual([
      [1, 'choice', 'live'],
      [2, 'unsure', 'revisit'],
    ]);
    expect(latestAnswer(v, q, t.alex)).toMatchObject({ revision: 1, value: { kind: 'choice', choice: 'yes' }, reasoning: 'Seen it work' });

    // The facilitator can reveal a question's answers when they choose to.
    t.fac({ type: 'reveal_question', questionId: q, revealed: true });
    expect(Object.keys(t.view(P(t.alex)).answers[q]!).sort()).toEqual([t.alex, t.sam].sort());
    t.fac({ type: 'reveal_question', questionId: q, revealed: false });
    expect(Object.keys(t.view(P(t.alex)).answers[q]!)).toEqual([t.alex]);
  });

  it('stops a participant answering as someone else or doing facilitator things', async () => {
    const t = seeded();
    const q = t.stanceQ(t.S1, t.G);
    t.fac({ type: 'publish_question', questionId: q });
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'yes' }, participantId: t.sam })).toThrow(/your own/);
    expect(() => t.as(t.alex)({ type: 'publish_question', questionId: q })).toThrow(/Only the facilitator/);
    expect(() => t.as(t.alex)({ type: 'reveal_question', questionId: q, revealed: true })).toThrow(/Only the facilitator/);
    expect(() => t.as(t.alex)({ type: 'set_config', config: t.view().config })).toThrow(/Only the facilitator/);
    expect(() => t.as(t.alex)({ type: 'add_node', kind: 'state', label: 'Sneaky' })).toThrow(/not open right now/);
    expect(() => t.as(t.alex)({ type: 'hold_link', from: t.S1, to: t.G, hold: true })).toThrow(/not open right now/);
    expect(() => t.as(t.alex)({ type: 'add_link', from: t.S1, to: t.G, relation: 'requirement' })).toThrow(/Only the facilitator/);
    await expect(t.calc({ methodId: 'structure-diagnostic' }, { type: 'participant', id: t.alex })).rejects.toThrow(/Only the facilitator/);
    expect(() => t.as(t.alex)({ type: 'join', participantId: 'x', name: 'x' })).toThrow();
    expect(() => t.as(t.alex)({ type: 'record_run', methodId: 'x', methodVersion: '1', settings: {}, assumptions: [], outputs: {} })).toThrow();
  });

  it('keys authenticate exactly one identity, survive a rejoin, and can be reissued', () => {
    const t = setup();
    const a = t.join('Alex');
    const b = t.join('Sam');
    expect(t.service.authenticate(t.id, a.participantKey)).toEqual({ type: 'participant', id: a.participantId });
    expect(t.service.authenticate(t.id, b.participantKey)).toEqual({ type: 'participant', id: b.participantId });
    expect(t.service.authenticate(t.id, t.created.facilitatorKey)).toEqual({ type: 'facilitator' });
    expect(t.service.authenticate(t.id, 'wrong')).toBeNull();
    expect(t.service.authenticate(t.id, undefined)).toBeNull();
    const other = t.service.create({ title: 'Other' });
    expect(t.service.authenticate(other.workshopId, a.participantKey)).toBeNull();
    expect(t.service.authenticate(other.workshopId, t.created.facilitatorKey)).toBeNull();
    const fresh = t.service.issueParticipantKey(t.id, FAC, a.participantId);
    expect(t.service.authenticate(t.id, a.participantKey)).toBeNull();
    expect(t.service.authenticate(t.id, fresh)).toEqual({ type: 'participant', id: a.participantId });
    expect(() => t.service.issueParticipantKey(t.id, P(b.participantId), a.participantId)).toThrow(/Only the facilitator/);
  });

  it('shows participants only their own calculation results unless models are shared', async () => {
    const t = seeded();
    await t.calc({ methodId: 'structure-diagnostic' });
    expect(Object.keys(t.view(P(t.alex)).runs[0]!.outputs)).toEqual([t.alex]);
    t.fac({ type: 'set_settings', shareModels: true });
    expect(Object.keys(t.view(P(t.alex)).runs[0]!.outputs).sort()).toEqual([t.alex, t.sam].sort());
  });

  it('validates answers against the question on the server', () => {
    const t = seeded();
    const q = t.stanceQ(t.S1, t.G);
    t.fac({ type: 'publish_question', questionId: q });
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'maybe' } })).toThrow(/not one of the options/);
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'probability', p: 0.5 } })).toThrow(/does not fit/);
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'probability', p: 7 } })).toThrow();
    expect(() => t.as(t.alex)({ type: 'nonsense' })).toThrow();
  });
});

describe('unknowns, revisions and changing definitions', () => {
  function withEstimates() {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { connections: { open: true }, estimates: { open: true } } });
    const lid = `l:i:${t.S1}>${t.G}`;
    const qYes = questionId('change-from-state', { type: 'link', linkId: lid });
    return { ...t, lid, qYes };
  }

  it('keeps "not sure" and "not answered" distinct from each other and from zero', () => {
    const t = withEstimates();
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'unsure' }, via: 'explorer' });
    const link = (pid: string) => buildParticipantModel(t.view(), pid).links.find((l) => l.id === t.lid)!;
    expect(link(t.alex).beliefs[ROLES.directChange]).toMatchObject({ state: 'unsure' });
    expect(link(t.alex).beliefs[ROLES.linkFailureModes]).toEqual({ state: 'unanswered' });
    expect(link(t.sam).beliefs[ROLES.directChange]).toEqual({ state: 'unanswered' });
    t.as(t.sam)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0 }, via: 'explorer' });
    expect(link(t.sam).beliefs[ROLES.directChange]).toMatchObject({ state: 'answered', value: { d: 0 } });
  });

  it('ties every estimate to who, what, which definitions and which revision', () => {
    const t = withEstimates();
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.2, low: 0.1, high: 0.3 }, reasoning: 'Based on last year', via: 'explorer' });
    const a = latestAnswer(t.view(), t.qYes, t.alex)!;
    expect(a).toMatchObject({ participantId: t.alex, questionId: t.qYes, revision: 1, source: 'explorer', enteredBy: { type: 'participant', id: t.alex }, reasoning: 'Based on last year' });
    expect(a.basis).toEqual({ nodes: { [t.S1]: 1, [t.G]: 1 }, context: 1, template: 1 });
    expect(() => t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.9, low: 0.1, high: 0.3 }, via: 'explorer' })).toThrow(/inside the range/);
  });

  it('keeps answers when a definition changes and flags them for review; a spelling fix does not', () => {
    const t = withEstimates();
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.2 }, via: 'explorer' });
    const stale = () => staleReason(t.view(), t.view().questions[t.qYes]!, latestAnswer(t.view(), t.qYes, t.alex)!);
    expect(stale()).toBeNull();

    t.fac({ type: 'edit_node', nodeId: t.S1, label: 'S1 (typo fixed)', meaningChanged: false });
    expect(stale()).toBeNull();

    t.fac({ type: 'edit_node', nodeId: t.S1, definition: 'Now means something narrower', meaningChanged: true });
    expect(stale()).toMatch(/definition of “S1 \(typo fixed\)” has changed/);
    expect(latestAnswer(t.view(), t.qYes, t.alex)!.value).toEqual({ kind: 'difference', d: 0.2 }); // preserved
    expect(buildParticipantModel(t.view(), t.alex).links.find((l) => l.id === t.lid)!.beliefs[ROLES.directChange]).toMatchObject({ stale: true });

    // Confirming it still stands clears the flag and is itself a recorded revision.
    t.as(t.alex)({ type: 'confirm_answer', questionId: t.qYes });
    expect(stale()).toBeNull();
    expect(latestAnswer(t.view(), t.qYes, t.alex)).toMatchObject({ revision: 2, source: 'confirmed' });

    // Changing the time horizon flags answers whose wording depends on it.
    t.fac({ type: 'select_goal', nodeId: t.G, successDefinition: 'done', horizon: '2040' });
    expect(stale()).toMatch(/time horizon/);
    // …but not answers whose wording does not mention it.
    const stanceQ = t.stanceQ(t.A1, t.S1);
    t.as(t.alex)({ type: 'answer', questionId: stanceQ, value: { kind: 'choice', choice: 'yes' }, via: 'explorer' });
    t.fac({ type: 'select_goal', nodeId: t.G, successDefinition: 'done', horizon: '2050' });
    expect(staleReason(t.view(), t.view().questions[stanceQ]!, latestAnswer(t.view(), stanceQ, t.alex)!)).toBeNull();
  });

  it('merging two states keeps everything, carries answers across and flags them', () => {
    const t = withEstimates();
    t.fac({ type: 'add_node', kind: 'state', label: 'S1 duplicate' });
    const dup = t.node('S1 duplicate').id;
    t.fac({ type: 'add_link', from: dup, to: t.G, relation: 'influence' });
    const dupQ = questionId('change-from-state', { type: 'link', linkId: `l:i:${dup}>${t.G}` });
    t.as(t.sam)({ type: 'answer', questionId: dupQ, value: { kind: 'difference', d: 0.4 }, via: 'explorer' });
    t.as(t.alex)({ type: 'answer', questionId: dupQ, value: { kind: 'difference', d: -0.1 }, via: 'explorer' });
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.2 }, via: 'explorer' });

    expect(() => t.fac({ type: 'merge_nodes', fromNodeId: dup, intoNodeId: t.S1 })).toThrow();
    expect(() => t.fac({ type: 'merge_nodes', fromNodeId: dup, intoNodeId: t.A1, confirm: true })).toThrow(/only be merged/);
    t.fac({ type: 'merge_nodes', fromNodeId: dup, intoNodeId: t.S1, confirm: true });

    const v = t.view();
    expect(v.nodes[dup]).toMatchObject({ status: 'merged', mergedInto: t.S1 });
    expect(v.nodes[t.S1]!.provenance.at(-1)).toMatchObject({ event: 'merged-in', detail: { nodeId: dup, label: 'S1 duplicate' } });
    expect(v.links[`l:i:${dup}>${t.G}`]).toMatchObject({ status: 'merged', mergedInto: t.lid });
    expect(v.questions[dupQ]!.status).toBe('superseded');
    expect(v.answers[dupQ]![t.sam]!.length).toBe(1); // the original answer is still in the record
    // Sam had no answer on the surviving link, so theirs is carried over and flagged.
    expect(latestAnswer(v, t.qYes, t.sam)).toMatchObject({ value: { kind: 'difference', d: 0.4 }, source: 'merged' });
    expect(staleReason(v, v.questions[t.qYes]!, latestAnswer(v, t.qYes, t.sam)!)).toMatch(/Carried over from “S1 duplicate”/);
    // Alex already had an answer there; it is not overwritten.
    expect(latestAnswer(v, t.qYes, t.alex)).toMatchObject({ value: { kind: 'difference', d: 0.2 }, source: 'explorer' });
  });

  it('archiving keeps the record and restoring brings questions back', () => {
    const t = withEstimates();
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.2 }, via: 'explorer' });
    t.fac({ type: 'set_node_status', nodeId: t.S1, status: 'archived' });
    expect(t.view().questions[t.qYes]!.status).toBe('superseded');
    expect(buildParticipantModel(t.view(), t.alex).nodes.some((n) => n.id === t.S1)).toBe(false);
    t.fac({ type: 'set_node_status', nodeId: t.S1, status: 'active' });
    expect(t.view().questions[t.qYes]!.status).toBe('draft');
    expect(latestAnswer(t.view(), t.qYes, t.alex)!.value).toEqual({ kind: 'difference', d: 0.2 });
  });

  it('binds each calculation run to the method version, settings and model revision, per person, never pooled', async () => {
    const t = withEstimates();
    await expect(t.calc({ methodId: 'local-additive' })).rejects.toThrow(/acknowledged/);
    await t.calc({ methodId: 'local-additive', acknowledged: true, settings: { pointEstimateMargin: 5 } });
    const run = t.view().runs[0]!;
    expect(run).toMatchObject({ methodId: 'local-additive', methodVersion: '2.0.0', modelRev: t.view().modelRev });
    expect(run.settings).toMatchObject({ pointEstimateMargin: 5, requirementPolicy: 'withhold-all' });
    expect(run.assumptions.length).toBeGreaterThan(3);
    expect(Object.keys(run.outputs).sort()).toEqual([t.alex, t.sam].sort());
    // Nobody has taken a view on any link yet: nothing connects, and nothing is reported as zero.
    for (const out of Object.values(run.outputs)) for (const a of out.actions) expect(a.effect).toBeUndefined();
    // A later change makes the run visibly out of date rather than silently different.
    t.as(t.alex)({ type: 'answer', questionId: t.qYes, value: { kind: 'difference', d: 0.2 }, via: 'explorer' });
    expect(t.view().modelRev).toBeGreaterThan(run.modelRev);
    expect(t.view().runs[0]!.outputs).toEqual(run.outputs);
  });
});
