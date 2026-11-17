/** Tests for the revised scope: direct arrow drawing, loop blocking, solo mode, layers and pooling, combined models. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { equalMean, noPooling } from '../../shared/aggregate/methods';
import { getAggregation, registerAggregation } from '../../shared/aggregate/registry';
import type { AggregationMethod } from '../../shared/aggregate/types';
import { ROLES } from '../../shared/config';
import { findLoop, loopIfAdded } from '../../shared/cycles';
import { buildParticipantModel } from '../../shared/model';
import { buildSynthesisModel, previewSynthesis } from '../../shared/synthesis';
import { questionId } from '../../shared/templates';
import type { Role } from '../../shared/types';
import { WorkshopService } from '../../server/service';
import { MemoryStore } from '../../server/store';
import { ENGINE, FAC, seeded, setup } from './helpers';

const P = (id: string): Role => ({ type: 'participant', id });

/** Goal + states only, no arrows, two people, connection drawing open. */
function unconnected() {
  const t = setup();
  const alex = t.join('Alex').participantId;
  const sam = t.join('Sam').participantId;
  const add = (kind: string, label: string) => {
    t.fac({ type: 'add_node', kind, label });
    return t.node(label).id;
  };
  const G = add('goal', 'Goal');
  t.fac({ type: 'select_goal', nodeId: G, successDefinition: 'done', horizon: '2030' });
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((x) => add('state', x)) as [string, string, string, string];
  const Act = add('action', 'Act');
  t.fac({ type: 'set_settings', layers: { connections: { open: true } } });
  const draw = (pid: string, from: string, to: string, extra: Record<string, unknown> = {}) => t.as(pid)({ type: 'hold_link', from, to, hold: true, ...extra });
  const held = (pid: string) =>
    buildParticipantModel(t.view(), pid)
      .links.filter((l) => l.stance === 'yes' || l.stance === 'conditional')
      .map((l) => `${t.view().nodes[l.from]!.label}>${t.view().nodes[l.to]!.label}`)
      .sort();
  return { ...t, alex, sam, G, A, B, C, D, Act, draw, held };
}

describe('loop detection', () => {
  it('finds the loop a new arrow would close, and self-links', () => {
    const arrows = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(loopIfAdded(arrows, { from: 'c', to: 'a' })).toEqual(['c', 'a', 'b', 'c']);
    expect(loopIfAdded(arrows, { from: 'a', to: 'c' })).toBeNull();
    expect(loopIfAdded(arrows, { from: 'a', to: 'a' })).toEqual(['a', 'a']);
    expect(findLoop([...arrows, { from: 'c', to: 'a' }])).not.toBeNull();
    expect(findLoop(arrows)).toBeNull();
  });
});

describe('drawing connections directly', () => {
  it('starts with no arrows; each person draws their own over the same items, including across branches', () => {
    const t = unconnected();
    expect(Object.keys(t.view().links)).toEqual([]);
    t.draw(t.alex, t.A, t.G);
    t.draw(t.alex, t.B, t.A);
    t.draw(t.alex, t.C, t.A, { as: 'harms', mechanism: 'Uses the same people' });
    t.draw(t.sam, t.B, t.G);
    t.draw(t.sam, t.D, t.B, { relation: 'requirement' });
    expect(t.held(t.alex)).toEqual(['A>Goal', 'B>A', 'C>A']);
    expect(t.held(t.sam)).toEqual(['B>Goal', 'D>B']);
    const c = buildParticipantModel(t.view(), t.alex).links.find((l) => l.from === t.C)!;
    expect(c).toMatchObject({ direction: 'harms', mechanism: 'Uses the same people' });

    // Erasing is recorded as "no longer holds", and only for that person.
    t.draw(t.sam, t.A, t.G);
    t.as(t.sam)({ type: 'hold_link', from: t.A, to: t.G, hold: false });
    expect(t.held(t.sam)).toEqual(['B>Goal', 'D>B']);
    expect(t.held(t.alex)).toContain('A>Goal');
  });

  it('keeps arrows personal until connections are pooled; pooling shows candidates without showing who holds them', () => {
    const t = unconnected();
    t.draw(t.alex, t.A, t.G);
    expect(Object.keys(t.view(P(t.sam)).links)).toEqual([]);
    expect(Object.keys(t.view(P(t.alex)).links).length).toBe(1);

    t.fac({ type: 'set_settings', layers: { connections: { pooled: true } } });
    const samView = t.view(P(t.sam));
    expect(Object.keys(samView.links).length).toBe(1);
    expect(buildParticipantModel(samView, t.sam).links[0]!.stance).toBe('unstated'); // seen, not held
    expect(Object.values(samView.answers).every((byP) => Object.keys(byP).every((pid) => pid === t.sam))).toBe(true);

    // Pooling is not locked in: switching it off again hides the candidate and nothing was overwritten.
    t.fac({ type: 'set_settings', layers: { connections: { pooled: false } } });
    expect(Object.keys(t.view(P(t.sam)).links)).toEqual([]);
    expect(t.held(t.alex)).toEqual(['A>Goal']);
  });

  it('refuses any arrow that would close a loop, says where the loop is, and leaves the map as it was', () => {
    const t = unconnected();
    t.draw(t.alex, t.A, t.B);
    t.draw(t.alex, t.B, t.C);
    t.draw(t.alex, t.C, t.D);
    const before = t.view();
    expect(() => t.draw(t.alex, t.D, t.A)).toThrow(/loop in your map: “D” → “A” → “B” → “C” → “D”/);
    expect(() => t.draw(t.alex, t.B, t.A)).toThrow(/loop/);
    expect(() => t.draw(t.alex, t.A, t.A)).toThrow(/itself/);
    // A requirement arrow counts too.
    expect(() => t.draw(t.alex, t.D, t.A, { relation: 'requirement' })).toThrow(/loop/);
    expect(t.view().links).toEqual(before.links);
    expect(t.view().answers).toEqual(before.answers);
    expect(t.view().seq).toBe(before.seq);

    // Someone else's opposite arrow is fine in THEIR map: maps are checked per person…
    t.draw(t.sam, t.D, t.A);
    expect(t.held(t.sam)).toEqual(['D>A']);
    // …but answering "yes" to it through a question is checked just the same as a gesture.
    t.fac({ type: 'set_settings', layers: { connections: { pooled: true } } });
    const q = questionId('influence-stance', { type: 'link', linkId: `l:i:${t.D}>${t.A}` });
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'yes' }, via: 'explorer' })).toThrow(/loop/);
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'conditional' }, via: 'explorer' })).toThrow(/loop/);
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'no' }, via: 'explorer' }); // rejecting is always allowed
    // The facilitator entering it on someone's behalf is checked as well.
    expect(() => t.fac({ type: 'hold_link', from: t.D, to: t.A, hold: true, participantId: t.alex })).toThrow(/Alex’s map/);
  });

  it('refuses a merge that would join arrows into a loop', () => {
    const t = unconnected();
    t.draw(t.alex, t.A, t.B);
    t.draw(t.alex, t.B, t.C);
    const before = t.view();
    // If A and C were the same item, A → B → A.
    expect(() => t.fac({ type: 'merge_nodes', fromNodeId: t.C, intoNodeId: t.A, confirm: true })).toThrow(/loop in Alex’s map/);
    expect(t.view().nodes).toEqual(before.nodes);
    expect(t.view().links).toEqual(before.links);
    // A harmless merge still works.
    t.fac({ type: 'merge_nodes', fromNodeId: t.D, intoNodeId: t.C, confirm: true });
    expect(t.view().nodes[t.D]!.status).toBe('merged');
  });

  it('refuses an import whose arrows form a loop', () => {
    const t = unconnected();
    t.draw(t.alex, t.A, t.B);
    const file = JSON.parse(JSON.stringify(t.service.exportData(t.id, FAC)));
    file.events.push({ seq: 999, at: '2026-01-01T00:00:00.000Z', actor: { type: 'participant', id: t.alex }, cmd: { type: 'hold_link', from: t.B, to: t.A, hold: true } });
    expect(() => t.service.importData(file)).toThrow(/could not be replayed.*loop/s);
  });
});

describe('layers: individual work and optional pooling', () => {
  it('lets the organizer open each layer separately and keeps personal items personal until pooled', () => {
    const t = unconnected();
    expect(() => t.as(t.alex)({ type: 'add_node', kind: 'state', label: 'Alex’s own state' })).toThrow(/not open/);
    t.fac({ type: 'set_settings', layers: { states: { open: true, pooled: false } } });
    t.as(t.alex)({ type: 'add_node', kind: 'state', label: 'Alex’s own state' });
    expect(() => t.as(t.alex)({ type: 'add_node', kind: 'action', label: 'Alex’s own action' })).toThrow(/not open/);
    const own = t.node('Alex’s own state');
    expect(own.owner).toBe(t.alex);
    const labels = (role: Role) => Object.values(t.view(role).nodes).map((n) => n.label);
    expect(labels(P(t.alex))).toContain('Alex’s own state');
    expect(labels(P(t.sam))).not.toContain('Alex’s own state');
    expect(labels(P(t.sam))).toContain('A'); // the facilitator's catalogue is shared
    // Alex can already use it in their own map.
    t.draw(t.alex, own.id, t.G);
    expect(Object.values(t.view(P(t.sam)).links)).toEqual([]);

    // Pool the catalogue: everyone sees the item, nobody is made to connect it the same way.
    t.fac({ type: 'set_settings', layers: { states: { pooled: true } } });
    expect(labels(P(t.sam))).toContain('Alex’s own state');
    expect(t.held(t.sam)).toEqual([]);
    expect(t.view().nodes[own.id]!.owner).toBe(t.alex); // provenance kept
  });

  it('opens estimates for individual work and pools their visibility separately from whole models', () => {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    const q = questionId('change-from-state', { type: 'link', linkId: `l:i:${t.S1}>${t.G}` });
    expect(() => t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'difference', d: 0.2 }, via: 'explorer' })).toThrow(/not open/);
    t.fac({ type: 'set_settings', layers: { estimates: { open: true } } });
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'difference', d: 0.2 }, via: 'explorer' });
    expect(t.view(P(t.sam)).answers[q]).toBeUndefined();
    t.fac({ type: 'set_settings', layers: { estimates: { pooled: true } } });
    expect(Object.keys(t.view(P(t.sam)).answers[q]!)).toEqual([t.alex]);
    // Stances are not estimates: pooling estimates does not reveal who holds which arrow.
    t.fac({ type: 'set_settings', layers: { connections: { open: true } } });
    t.as(t.alex)({ type: 'hold_link', from: t.S1, to: t.G, hold: true });
    expect(t.view(P(t.sam)).answers[t.stanceQ(t.S1, t.G)]).toBeUndefined();
  });
});

describe('solo mode', () => {
  it('lets one person do everything without a facilitator or other participants', async () => {
    const service = new WorkshopService(new MemoryStore(), undefined, ENGINE);
    const { workshopId } = service.create({ title: 'Mine', solo: true });
    const cmd = (c: Record<string, unknown>) => service.command(workshopId, FAC, c);
    const view = () => service.view(workshopId, FAC);
    expect(view().mode).toBe('solo');
    expect(Object.keys(view().participants)).toEqual(['me']);
    const add = (kind: string, label: string) => {
      cmd({ type: 'add_node', kind, label });
      return Object.values(view().nodes).find((n) => n.label === label)!.id;
    };
    const G = add('goal', 'My goal');
    cmd({ type: 'select_goal', nodeId: G, successDefinition: 'It happened', horizon: 'next year' });
    const S = add('state', 'A state');
    const A = add('action', 'Something I can do');
    // No participant needs naming: in solo mode the one person is implied.
    cmd({ type: 'hold_link', from: S, to: G, hold: true });
    cmd({ type: 'hold_link', from: A, to: S, hold: true });
    expect(() => cmd({ type: 'hold_link', from: G, to: S, hold: true })).toThrow(/towards the goal/);
    const config = structuredClone(view().config);
    config.calculation.methodId = 'local-additive';
    cmd({ type: 'set_config', config });
    const answer = (templateId: string, from: string, to: string, d: number) =>
      cmd({ type: 'answer', questionId: questionId(templateId, { type: 'link', linkId: `l:i:${from}>${to}` }), value: { kind: 'difference', d } });
    answer('change-from-action', A, S, 0.4);
    answer('change-from-state', S, G, 0.2);
    // Revise an estimate; the earlier one stays in the record, attributed to the person, not "on behalf".
    answer('change-from-state', S, G, 0.1);
    const list = view().answers[questionId('change-from-state', { type: 'link', linkId: `l:i:${S}>${G}` })]!.me!;
    expect(list.map((a) => [a.revision, a.source])).toEqual([
      [1, 'explorer'],
      [2, 'explorer'],
    ]);
    await service.runCalculation(workshopId, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true });
    const out = view().runs[0]!.outputs.me!;
    expect(out.actions[0]!.effect!.low).toBeCloseTo(0.4 * 0.1, 10);
    expect(out.ranking).toMatchObject({ complete: true });
  });

  it('offers a 52-item unconnected demo', () => {
    const service = new WorkshopService(new MemoryStore());
    const { workshopId } = service.create({ title: 'Demo', example: 'unconnected' });
    const v = service.view(workshopId, FAC);
    expect(Object.keys(v.nodes).length).toBe(52);
    expect(Object.keys(v.links).length).toBe(0);
    expect(v.isExample).toBe(true);
    expect(v.mode).toBe('solo');
    expect(Object.values(v.nodes).filter((n) => n.elicitedFor).length).toBe(51);
  });
});

describe('pooling estimates is a replaceable method', () => {
  const c = (participantId: string, state: 'answered' | 'unsure' | 'unanswered' | 'needs-review', p?: number, low?: number, high?: number) => ({ participantId, state, p, low, high });

  it('averages only real answers; unsure and missing are listed, never counted as zero', () => {
    const r = equalMean.aggregate({ contributions: [c('a', 'answered', 0.2), c('b', 'answered', 0.6), c('c', 'unsure'), c('d', 'unanswered'), c('e', 'needs-review', 0.9)], conditionsDiffer: false }, equalMean.defaultSettings);
    expect(r.value!.p).toBeCloseTo(0.4, 10);
    expect(r.value).toMatchObject({ low: 0.2, high: 0.6 });
    expect(r).toMatchObject({ used: ['a', 'b'], unsure: ['c'], missing: ['d'], needsReview: ['e'], spread: { min: 0.2, max: 0.6 }, flagged: false });
  });

  it('gives no number rather than a guess when too few people answered or nobody did', () => {
    expect(equalMean.aggregate({ contributions: [c('a', 'answered', 0.2), c('b', 'unsure')], conditionsDiffer: false }, equalMean.defaultSettings).value).toBeUndefined();
    expect(equalMean.aggregate({ contributions: [c('a', 'unsure'), c('b', 'unanswered')], conditionsDiffer: false }, equalMean.defaultSettings).value).toBeUndefined();
    expect(equalMean.aggregate({ contributions: [c('a', 'answered', 0.2)], conditionsDiffer: false }, { ...equalMean.defaultSettings, minContributors: 1 }).value!.p).toBe(0.2);
  });

  it('does not average answers given under different conditions unless told to, and then flags them', () => {
    const input = { contributions: [c('a', 'answered', 0.2), c('b', 'answered', 0.6)], conditionsDiffer: true };
    const withheld = equalMean.aggregate(input, equalMean.defaultSettings);
    expect(withheld.value).toBeUndefined();
    expect(withheld.flagged).toBe(true);
    const flagged = equalMean.aggregate(input, { ...equalMean.defaultSettings, whenConditionsDiffer: 'use-and-flag' });
    expect(flagged.value!.p).toBeCloseTo(0.4, 10);
    expect(flagged.flagged).toBe(true);
  });

  it('"do not pool" never produces a number, and a new method can be registered', () => {
    expect(noPooling.aggregate({ contributions: [c('a', 'answered', 0.2), c('b', 'answered', 0.6)], conditionsDiffer: false }, {}).value).toBeUndefined();
    const median: AggregationMethod<Record<string, never>> = {
      ...noPooling,
      id: 'test-median',
      name: 'Median (test)',
      settingsSchema: z.object({}),
      aggregate: (input) => {
        const ps = input.contributions.filter((x) => x.state === 'answered').map((x) => x.p!).sort();
        return { value: ps.length ? { p: ps[Math.floor(ps.length / 2)]! } : undefined, used: [], unsure: [], missing: [], needsReview: [], flagged: false, note: '' };
      },
    };
    registerAggregation(median);
    expect(getAggregation('test-median')!.aggregate({ contributions: [c('a', 'answered', 0.1), c('b', 'answered', 0.5), c('c', 'answered', 0.9)], conditionsDiffer: false }, {}).value!.p).toBe(0.5);
  });
});

describe('combining maps into a separate, reversible synthesis', () => {
  function twoMaps() {
    const t = unconnected();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { estimates: { open: true } } });
    // Both hold Act → A and A → Goal. Alex also holds B → A; Sam holds A → B instead (opposite direction).
    for (const p of [t.alex, t.sam]) {
      t.draw(p, t.Act, t.A);
      t.draw(p, t.A, t.G);
    }
    t.draw(t.alex, t.B, t.A);
    t.draw(t.sam, t.A, t.B);
    const est = (pid: string, tpl: string, from: string, to: string, value: Record<string, unknown>) =>
      t.as(pid)({ type: 'answer', questionId: questionId(tpl, { type: 'link', linkId: `l:i:${from}>${to}` }), value, via: 'explorer' });
    est(t.alex, 'change-from-action', t.Act, t.A, { kind: 'difference', d: 0.6 });
    est(t.sam, 'change-from-action', t.Act, t.A, { kind: 'difference', d: 0.4 });
    est(t.alex, 'change-from-state', t.A, t.G, { kind: 'difference', d: 0.2 });
    est(t.sam, 'change-from-state', t.A, t.G, { kind: 'difference', d: 0.4 });
    // Sam is not sure how much B matters; Alex has not said.
    est(t.sam, 'change-from-state', t.A, t.B, { kind: 'unsure' });
    const lid = (from: string, to: string) => `l:i:${from}>${to}`;
    return { ...t, lid };
  }
  const mean = { methodId: 'equal-mean', settings: { minContributors: 1 } };

  it('previews what would be brought together, including disagreements and the loop a plain union would make', () => {
    const t = twoMaps();
    const preview = previewSynthesis(t.view(), { contributors: [t.alex, t.sam], decisions: {}, aggregation: mean });
    const arrow = (from: string, to: string) => preview.arrows.find((a) => a.linkId === t.lid(from, to))!;
    expect(arrow(t.Act, t.A)).toMatchObject({ agreed: true, decision: 'include', included: true });
    // Held by one, never reviewed by the other: not agreement, not rejection — left out until someone decides.
    expect(arrow(t.B, t.A)).toMatchObject({ holds: [t.alex], unreviewed: [t.sam], agreed: false, decision: 'undecided', included: false });
    expect(arrow(t.A, t.B)).toMatchObject({ holds: [t.sam], decision: 'undecided' });
    expect(preview.unionLoop).not.toBeNull(); // each map is loop-free, the union is not
    expect(preview.includedLoop).toBeNull();
  });

  it('refuses to save a combined map with a loop; saves a loop-free choice as its own versioned object', () => {
    const t = twoMaps();
    const both = { [t.lid(t.B, t.A)]: 'include', [t.lid(t.A, t.B)]: 'include' };
    expect(() => t.fac({ type: 'save_synthesis', name: 'Both', contributors: [t.alex, t.sam], decisions: both, aggregation: mean })).toThrow(/Together these arrows make a loop/);
    expect(Object.keys(t.view().syntheses)).toEqual([]);

    const answersBefore = structuredClone(t.view().answers);
    t.fac({ type: 'save_synthesis', name: 'Team map', contributors: [t.alex, t.sam], decisions: { [t.lid(t.B, t.A)]: 'include', [t.lid(t.A, t.B)]: 'exclude' }, aggregation: mean });
    const syn = Object.values(t.view().syntheses)[0]!;
    expect(syn).toMatchObject({ name: 'Team map', version: 1, contributors: [t.alex, t.sam], archived: false });
    // Personal originals are untouched.
    expect(t.view().answers).toEqual(answersBefore);
    expect(t.held(t.alex)).toContain('B>A');
    expect(t.held(t.sam)).toContain('A>B');

    // A new save is a new version; the old one can be brought back; the whole thing can be put away.
    t.fac({ type: 'save_synthesis', synthesisId: syn.id, name: 'Team map', contributors: [t.alex, t.sam], decisions: {}, aggregation: mean });
    expect(t.view().syntheses[syn.id]).toMatchObject({ version: 2, decisions: {} });
    t.fac({ type: 'revert_synthesis', synthesisId: syn.id, version: 1 });
    expect(t.view().syntheses[syn.id]!.version).toBe(3);
    expect(t.view().syntheses[syn.id]!.decisions[t.lid(t.B, t.A)]).toBe('include');
    expect(t.view().syntheses[syn.id]!.previous.map((v) => v.version)).toEqual([1, 2]);
    t.fac({ type: 'set_synthesis_archived', synthesisId: syn.id, archived: true });
    expect(t.view().syntheses[syn.id]!.archived).toBe(true);
  });

  it('pools only identical questions, shows contributors and spread, and surfaces what needs re-asking', () => {
    const t = twoMaps();
    const spec = { contributors: [t.alex, t.sam], decisions: {}, aggregation: mean };
    const preview = previewSynthesis(t.view(), spec);
    const pooled = (from: string, to: string, role: string) => preview.estimates.find((e) => e.linkId === t.lid(from, to) && e.role === role)!;
    // A → Goal: both answered, and Goal has the same single arrow into it in both maps and the combined one.
    const ag = pooled(t.A, t.G, ROLES.directChange);
    expect(ag.conditionsDiffer).toBe(false);
    expect(ag.unit).toBe('difference');
    expect(ag.result.value!.p).toBeCloseTo(0.3, 10);
    expect(ag.result).toMatchObject({ used: [t.alex, t.sam], spread: { min: 0.2, max: 0.4 } });
    // Act → A: Alex has B → A as well in their own map, the combined map does not: conditions differ, so no average by default.
    const actA = pooled(t.Act, t.A, ROLES.directChange);
    expect(actA.conditionsDiffer).toBe(true);
    expect(actA.result.value).toBeUndefined();
    expect(actA.result.flagged).toBe(true);
    expect(preview.reviewCount).toBeGreaterThan(0);
    // Sam's "not sure" is listed, not averaged in as zero.
    const withB = previewSynthesis(t.view(), { ...spec, decisions: { [t.lid(t.A, t.B)]: 'include' } });
    const ab = withB.estimates.find((e) => e.linkId === t.lid(t.A, t.B))!;
    expect(ab.result).toMatchObject({ unsure: [t.sam], missing: [t.alex] });
    expect(ab.result.value).toBeUndefined();

    // If the horizon changes, earlier answers are no longer to the same question.
    t.fac({ type: 'select_goal', nodeId: t.G, successDefinition: 'done', horizon: '2040' });
    const later = previewSynthesis(t.view(), spec).estimates.find((e) => e.linkId === t.lid(t.A, t.G) && e.role === ROLES.directChange)!;
    expect(later.result.value).toBeUndefined();
    expect(later.result.needsReview).toEqual([t.alex, t.sam]);
  });

  it('calculates the combined model from pooled inputs as its own result, never by averaging people’s results', async () => {
    const t = twoMaps();
    const flagging = { methodId: 'equal-mean', settings: { minContributors: 1, whenConditionsDiffer: 'use-and-flag', range: 'none' } };
    t.fac({ type: 'save_synthesis', name: 'Team map', contributors: [t.alex, t.sam], decisions: {}, aggregation: flagging });
    const syn = Object.values(t.view().syntheses)[0]!;
    const model = buildSynthesisModel(t.view(), syn.id);
    expect(model.links.map((l) => l.id).sort()).toEqual([t.lid(t.A, t.G), t.lid(t.Act, t.A)].sort());
    await t.calc({ methodId: 'local-additive', acknowledged: true, settings: { staleAnswers: 'use-with-warning' } });
    const run = t.view().runs[0]!;
    expect(run.synthesisVersions).toEqual({ [syn.id]: 1 });
    const combined = run.outputs[`syn:${syn.id}`]!.actions[0]!;
    // Pooled inputs: average change 0.5 into A, average change 0.3 from A to the goal.
    expect(combined.effect!.low).toBeCloseTo(0.5 * 0.3, 10);
    // Each person's own result comes from their own numbers and stays separate.
    expect(run.outputs[t.alex]!.actions[0]!.effect!.low).toBeCloseTo(0.6 * 0.2, 10);
    // (Sam's unsure arrow A → B is not on a route to the goal, so it does not hold Sam's own result back.)
    expect(run.outputs[t.sam]!.actions[0]!.effect!.low).toBeCloseTo(0.4 * 0.4, 10);
    // The combined result is not the average of the two individual results (0.12 and 0.16 would average to 0.14).
    expect(combined.effect!.low).not.toBeCloseTo(0.14, 5);
    // With the default (no pooling) a combined model has arrows but no numbers.
    t.fac({ type: 'save_synthesis', name: 'Arrows only', contributors: [t.alex, t.sam], decisions: {}, aggregation: { methodId: 'no-pooling' } });
    await t.calc({ methodId: 'local-additive', acknowledged: true });
    const arrowsOnly = Object.values(t.view().syntheses).find((s) => s.name === 'Arrows only')!;
    expect(t.view().runs[1]!.outputs[`syn:${arrowsOnly.id}`]!.actions[0]!.status).toBe('incomplete');
  });

  it('respects sharing permissions: a participant can only combine with others once models are shared', () => {
    const t = twoMaps();
    const spec = { type: 'save_synthesis', name: 'Mine + Sam', contributors: [t.alex, t.sam], decisions: {}, aggregation: { methodId: 'no-pooling' } };
    expect(() => t.as(t.alex)(spec)).toThrow(/once models have been shared/);
    t.as(t.alex)({ ...spec, name: 'Just mine', contributors: [t.alex] });
    expect(Object.values(t.view(P(t.sam)).syntheses)).toEqual([]);
    t.fac({ type: 'set_settings', shareModels: true });
    t.as(t.alex)(spec);
    const id = Object.values(t.view().syntheses).find((s) => s.name === 'Mine + Sam')!.id;
    expect(() => t.as(t.sam)({ type: 'set_synthesis_archived', synthesisId: id, archived: true })).toThrow(/you made/);
    expect(Object.values(t.view(P(t.sam)).syntheses).length).toBe(2);
  });
});

describe('stale calculation results are never stored as current', () => {
  it('recomputes if the model changes while the engine is working, and binds the run to the revision it used', async () => {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { connections: { open: true }, estimates: { open: true } } });
    t.as(t.alex)({ type: 'hold_link', from: t.A1, to: t.G, hold: true });
    const q = questionId('change-from-action', { type: 'link', linkId: `l:i:${t.A1}>${t.G}` });
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'difference', d: 0.1 }, via: 'explorer' });

    // An engine that lets an edit slip in during its first evaluation.
    let calls = 0;
    const slow = {
      ...ENGINE,
      evaluate: async (program: Parameters<typeof ENGINE.evaluate>[0]) => {
        calls += 1;
        if (calls === 1) service.command(t.id, { type: 'participant', id: t.alex }, { type: 'answer', questionId: q, value: { kind: 'difference', d: 0.4 }, via: 'explorer' });
        return ENGINE.evaluate(program);
      },
    };
    const service: WorkshopService = new WorkshopService(t.store, undefined, slow);
    await service.runCalculation(t.id, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true });
    const v = service.view(t.id, FAC);
    expect(v.runs.length).toBe(1); // the result computed from the older answer was discarded, not stored
    expect(v.runs[0]!.outputs[t.alex]!.actions.find((a) => a.actionId === t.A1)!.effect!.low).toBeCloseTo(0.4, 10);
    expect(v.runs[0]!.modelRev).toBe(v.modelRev);
    expect(calls).toBeGreaterThan(1);
  });

  it('gives up cleanly if the model never holds still', async () => {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { connections: { open: true }, estimates: { open: true } } });
    t.as(t.alex)({ type: 'hold_link', from: t.A1, to: t.G, hold: true });
    const q = questionId('change-from-action', { type: 'link', linkId: `l:i:${t.A1}>${t.G}` });
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'difference', d: 0.1 }, via: 'explorer' });
    let n = 0;
    const restless = {
      ...ENGINE,
      evaluate: async (program: Parameters<typeof ENGINE.evaluate>[0]) => {
        service.command(t.id, { type: 'participant', id: t.alex }, { type: 'answer', questionId: q, value: { kind: 'difference', d: 0.1 + ++n / 100 }, via: 'explorer' });
        return ENGINE.evaluate(program);
      },
    };
    const service: WorkshopService = new WorkshopService(t.store, undefined, restless);
    await expect(service.runCalculation(t.id, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true })).rejects.toThrow(/kept changing/);
    expect(service.view(t.id, FAC).runs.length).toBe(0);
  });
});

describe('concurrent calculations', () => {
  it('finish in the order they were requested and stay separate runs, even when the first is slower', async () => {
    const t = seeded();
    let first = true;
    const uneven = {
      ...ENGINE,
      evaluate: async (program: Parameters<typeof ENGINE.evaluate>[0]) => {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 120));
        }
        return ENGINE.evaluate(program);
      },
    };
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { connections: { open: true }, estimates: { open: true } } });
    t.as(t.alex)({ type: 'hold_link', from: t.A1, to: t.G, hold: true });
    t.as(t.alex)({ type: 'answer', questionId: questionId('change-from-action', { type: 'link', linkId: `l:i:${t.A1}>${t.G}` }), value: { kind: 'difference', d: 0.2 }, via: 'explorer' });
    const service = new WorkshopService(t.store, undefined, uneven);
    // Same model revision, different settings, requested back to back.
    const a = service.runCalculation(t.id, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true, settings: { pointEstimateMargin: 0 } });
    const b = service.runCalculation(t.id, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true, settings: { pointEstimateMargin: 5 } });
    const c = service.runCalculation(t.id, FAC, { type: 'run_calculation', methodId: 'structure-diagnostic' });
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.seq).toBeLessThan(rb.seq);
    expect(rb.seq).toBeLessThan(rc.seq);
    const runs = service.view(t.id, FAC).runs;
    expect(runs.map((r) => [r.methodId, (r.settings as { pointEstimateMargin?: number }).pointEstimateMargin])).toEqual([
      ['local-additive', 0],
      ['local-additive', 5],
      ['structure-diagnostic', undefined],
    ]);
    expect(new Set(runs.map((r) => r.id)).size).toBe(3); // the latest request is the latest run; earlier ones remain selectable
    expect(runs[1]!.outputs[t.alex]!.actions.find((x) => x.actionId === t.A1)!.effect).toEqual({ low: 0.15, high: 0.25 });
  });
});

describe('privacy of calculation runs', () => {
  it('never sends another person’s formulas, numbers or source mappings to a participant unless models are shared', async () => {
    const t = seeded();
    const config = structuredClone(t.view().config);
    config.calculation.methodId = 'local-additive';
    t.fac({ type: 'set_config', config });
    t.fac({ type: 'set_settings', layers: { connections: { open: true }, estimates: { open: true } } });
    const q = questionId('change-from-action', { type: 'link', linkId: `l:i:${t.A1}>${t.G}` });
    for (const [pid, d] of [
      [t.alex, 0.123456],
      [t.sam, 0.654321],
    ] as const) {
      t.as(pid)({ type: 'hold_link', from: t.A1, to: t.G, hold: true });
      t.as(pid)({ type: 'answer', questionId: q, value: { kind: 'difference', d }, via: 'explorer' });
    }
    t.fac({ type: 'save_synthesis', name: 'Organizer’s combination', contributors: [t.alex, t.sam], decisions: {}, aggregation: { methodId: 'equal-mean', settings: { minContributors: 1 } } });
    await t.calc({ methodId: 'local-additive', acknowledged: true });

    const samSees = JSON.stringify(t.view(P(t.sam)));
    expect(samSees).toContain('0.654321'); // Sam's own number, in Sam's own formulas
    expect(samSees).not.toContain('0.123456'); // Alex's coefficient appears nowhere: not in answers, results or formulas
    const run = t.view(P(t.sam)).runs[0]!;
    expect(Object.keys(run.programs!)).toEqual([t.sam]);
    expect(Object.keys(run.outputs)).toEqual([t.sam]);
    expect(run.synthesisVersions).toEqual({}); // the organizer's combined model is not Sam's to see
    expect(samSees).not.toContain('0.388888'); // nor its pooled average (0.3888885)
    // The organizer sees everything; sharing models opens it up for participants.
    expect(Object.keys(t.view().runs[0]!.programs!).length).toBe(3);
    t.fac({ type: 'set_settings', shareModels: true });
    expect(JSON.stringify(t.view(P(t.sam)))).toContain('0.123456');
    expect(Object.keys(t.view(P(t.sam)).runs[0]!.programs!).length).toBe(3);
  });
});
