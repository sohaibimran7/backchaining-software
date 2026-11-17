import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROLES } from '../../shared/config';
import { compileAdditivePlan, evaluatePlanReference, localAdditive, multiplyRanges, prepareLocalAdditive, type LocalAdditiveSettings } from '../../shared/calc/localAdditive';
import { getMethod, listMethods, registerMethod, resolveSettings } from '../../shared/calc/registry';
import { structureDiagnostic } from '../../shared/calc/structureDiagnostic';
import { evaluateMethod, type Belief, type CalculationMethod, type ModelLinkInput, type ParticipantModel, type Stance } from '../../shared/calc/types';
import { ENGINE, seeded } from './helpers';

const defaults = localAdditive.defaultSettings;

/** A stated change in a chance (0.2 = 20 percentage points more likely). */
const diff = (d: number, low?: number, high?: number): Belief => ({ state: 'answered', value: { kind: 'difference', d, low, high }, stale: false, needsReview: false });

function link(from: string, to: string, change?: number | Belief, stance: Stance = 'yes'): ModelLinkInput {
  const beliefs: Record<string, Belief> = {};
  if (change !== undefined) beliefs[ROLES.directChange] = typeof change === 'number' ? diff(change) : change;
  return { id: `${from}>${to}`, from, to, relation: 'influence', stance, stanceStale: false, beliefs };
}
function requirement(from: string, to: string, stance: Stance = 'yes'): ModelLinkInput {
  return { id: `req:${from}>${to}`, from, to, relation: 'requirement', stance, stanceStale: false, beliefs: {} };
}
function model(links: ModelLinkInput[], extraNodes: string[] = []): ParticipantModel {
  const ids = new Set(['G', ...extraNodes]);
  for (const l of links) {
    ids.add(l.from);
    ids.add(l.to);
  }
  return {
    participantId: 'p',
    goalId: 'G',
    horizon: '2030',
    nodes: [...ids].map((id) => ({ id, label: id, kind: id === 'G' ? 'goal' : id.startsWith('A') ? 'action' : 'state', beliefs: {} })),
    links,
  };
}
/** The real path: semantic checks → generated Squiggle → engine → results. */
const result = async (m: ParticipantModel, settings: Partial<LocalAdditiveSettings> = {}) => {
  const { output: out, program } = await evaluateMethod(localAdditive, m, { ...defaults, ...settings }, ENGINE);
  return { out, program, action: (id: string) => out.actions.find((a) => a.actionId === id)! };
};
const describe_ = (m: ParticipantModel) => structureDiagnostic.prepare(m, structureDiagnostic.defaultSettings).finish(null);

// The demonstration graph: A1 → S1, A2 → S2, S1 → S2, S1 → G, S2 → G.
const example = () =>
  model([link('A1', 'S1', 0.5), link('A2', 'S2', 0.3), link('S1', 'S2', 0.15), link('S1', 'G', 0.2), link('S2', 'G', 0.15)]);

describe('local additive approximation', () => {
  it('sums each route once: direct effects multiply along a route and routes add', async () => {
    const { action, out } = await result(example());
    // A1: 0.5 × (0.2 direct to G + 0.15 × 0.15 via S2) = 0.11125
    expect(action('A1').status).toBe('estimated');
    expect(action('A1').effect!.low).toBeCloseTo(0.11125, 10);
    expect(action('A1').effect!.high).toBeCloseTo(0.11125, 10);
    expect(action('A1').routeCount).toBe(2);
    // A2: 0.3 × 0.15 = 0.045
    expect(action('A2').effect!.low).toBeCloseTo(0.045, 10);
    expect(action('A1').clearlyAheadOf).toEqual(['A2']);
    expect(out.status).toBe('ok');
    // A ranking of actions by percentage-point change — and nowhere an absolute chance of the goal.
    expect(out.ranking).toMatchObject({ tiers: [['A1'], ['A2']], complete: true });
    expect(JSON.stringify(out)).not.toMatch(/chance of the goal is|probability of the goal/i);
    // The shortcut S1 → G beside S1 → S2 → G is pointed out as a double-counting risk.
    expect(out.diagnostics.some((d) => d.code === 'shortcut-links')).toBe(true);
  });

  it('treats a missing estimate as missing, never as zero', async () => {
    const m = example();
    delete m.links[4]!.beliefs[ROLES.directChange]; // S2 → G
    const { action, out } = await result(m);
    expect(action('A2').status).toBe('incomplete');
    expect(action('A2').effect).toBeUndefined();
    expect(action('A2').missingLinkIds).toEqual(['S2>G']);
    // A1 also has a route through S2 → G, so it is incomplete too rather than silently dropping that route.
    expect(action('A1').status).toBe('incomplete');
    expect(out.status).toBe('withheld');
    expect(out.ranking).toBeUndefined(); // nothing to rank: no ranking is invented
  });

  it('treats "not sure" as missing, never as zero', async () => {
    const m = example();
    m.links[1]!.beliefs[ROLES.directChange] = { state: 'unsure', stale: false };
    const { action, out } = await result(m);
    expect(action('A2').status).toBe('incomplete');
    expect(action('A2').reasons.join(' ')).toContain('not sure');
    expect(action('A1').status).toBe('estimated');
    // The ranking is qualified: it covers one of two actions, and the other is unplaced rather than last.
    expect(out.ranking).toMatchObject({ tiers: [['A1']], complete: false });
    expect(out.ranking!.note).toContain('1 of 2');
  });

  it('keeps rejected, unsure and unreviewed links apart', async () => {
    const base = () => example();
    const rejected = base();
    rejected.links[2]!.stance = 'no'; // S1 → S2 rejected: simply not part of this model
    expect((await result(rejected)).action('A1').effect!.low).toBeCloseTo(0.1, 10);

    const unsure = base();
    unsure.links[2]!.stance = 'unsure';
    expect((await result(unsure)).action('A1').status).toBe('incomplete');

    const unreviewed = base();
    unreviewed.links[2]!.stance = 'unstated';
    const leftOut = await result(unreviewed);
    expect(leftOut.action('A1').effect!.low).toBeCloseTo(0.1, 10);
    expect(leftOut.out.diagnostics.some((d) => d.code === 'unstated-left-out')).toBe(true);
    expect((await result(unreviewed, { unstatedLinks: 'treat-as-missing' })).action('A1').status).toBe('incomplete');
  });

  it('withholds the number when a state on the route has a requirement (default policy)', async () => {
    const m = example();
    m.links.push(requirement('S2', 'G'));
    const { action, out } = await result(m);
    expect(action('A1').status).toBe('withheld');
    expect(action('A2').status).toBe('withheld');
    expect(action('A1').effect).toBeUndefined();
    expect(action('A1').reasons[0]).toContain('required');
    expect(out.status).toBe('withheld');
  });

  it('with the narrower policy, withholds only where routes combine at the state with the requirement', async () => {
    // R is required for S; the action reaches S by a single link, and does not touch R.
    const single = model([link('A1', 'S', 0.4), link('S', 'G', 0.25), requirement('R', 'S')], ['R']);
    expect((await result(single)).action('A1').status).toBe('withheld');
    const narrow = await result(single, { requirementPolicy: 'withhold-when-routes-combine' });
    expect(narrow.action('A1').status).toBe('estimated');
    expect(narrow.action('A1').effect!.low).toBeCloseTo(0.4 * 0.25, 10);
    // In the demonstration graph A1 reaches G by two links while S2 is required for G: still withheld.
    const combined = example();
    combined.links.push(requirement('S2', 'G'));
    expect((await result(combined, { requirementPolicy: 'withhold-when-routes-combine' })).action('A1').status).toBe('withheld');
    // A2 reaches G only through the required state itself: that single route can be estimated.
    expect((await result(combined, { requirementPolicy: 'withhold-when-routes-combine' })).action('A2').status).toBe('estimated');
  });

  it('withholds when a link holds only under some conditions', async () => {
    const m = example();
    m.links[3]!.stance = 'conditional'; // S1 → G
    const { action } = await result(m);
    expect(action('A1').status).toBe('withheld');
    expect(action('A2').status).toBe('estimated');
  });

  it('withholds on a loop instead of iterating', async () => {
    const m = model([link('A1', 'S1', 0.5), link('S1', 'S2', 0.2), link('S2', 'S1', 0.2), link('S2', 'G', 0.2)]);
    expect((await result(m)).action('A1').status).toBe('withheld');
  });

  it('reports an action with no route as not connected, with no number', async () => {
    const m = model([link('A1', 'S1', 0.5), link('S1', 'G', 0.2)], ['A9']);
    expect((await result(m)).action('A9').status).toBe('not-connected');
    expect((await result(m)).action('A9').effect).toBeUndefined();
  });

  it('carries ranges through and only separates actions whose ranges do not overlap', async () => {
    const m = model([link('A1', 'S', diff(0.5, 0.4, 0.6)), link('S', 'G', diff(0.5, 0.25, 1)), link('A2', 'G', diff(0.15, 0.1, 0.2)), link('A3', 'G', 0.02)]);
    const { action, out } = await result(m);
    expect(action('A1').effect!.low).toBeCloseTo(0.1, 10);
    expect(action('A1').effect!.high).toBeCloseTo(0.6, 10);
    expect(action('A2').effect!.low).toBeCloseTo(0.1, 10);
    expect(action('A2').effect!.high).toBeCloseTo(0.2, 10);
    expect(action('A1').clearlyAheadOf).toEqual(['A3']);
    expect(action('A2').clearlyAheadOf).toEqual(['A3']);
    // A1 and A2 overlap, so they share a tier; A3 is clearly behind both.
    expect(out.ranking!.tiers).toEqual([['A1', 'A2'], ['A3']]);
  });

  it('applies the configured margin to single-number estimates', async () => {
    const m = model([link('A1', 'G', 0.3)]);
    const { action } = await result(m, { pointEstimateMargin: 5 });
    expect(action('A1').effect!.low).toBeCloseTo(0.25, 10);
    expect(action('A1').effect!.high).toBeCloseTo(0.35, 10);
  });

  it('allows a link that lowers the chance (negative effect)', async () => {
    const m = model([link('A1', 'S1', 0.6), link('S1', 'G', -0.3)]);
    expect((await result(m)).action('A1').effect!.low).toBeCloseTo(-0.18, 10);
  });

  it('treats answers given before a definition changed as missing unless told otherwise', async () => {
    const m = model([link('A1', 'G', { ...diff(0.3), stale: true } as Belief)]);
    expect((await result(m)).action('A1').status).toBe('incomplete');
    const used = await result(m, { staleAnswers: 'use-with-warning' });
    expect(used.action('A1').status).toBe('estimated');
    expect(used.out.diagnostics.some((d) => d.code === 'stale-used')).toBe(true);
  });

  it('declares what it needs and an example before anything is run, and names differences as differences', () => {
    expect(localAdditive.requiredInputs.length).toBeGreaterThan(1);
    expect(localAdditive.example.arrows.length).toBe(5);
    expect(localAdditive.name).toMatch(/probability changes/);
    expect(localAdditive.name).not.toMatch(/conditional/i);
    expect(localAdditive.consumes).toEqual([ROLES.linkStance, ROLES.directChange]);
    for (const t of localAdditive.elicitation) expect(t.answer.type).toBe('difference');
    expect(structureDiagnostic.requiredInputs.join(' ')).toMatch(/No numbers/);
  });

  it('multiplies ranges that span zero correctly', () => {
    expect(multiplyRanges({ low: -0.2, high: 0.5 }, { low: 0.5, high: 1 })).toEqual({ low: -0.2, high: 0.5 });
  });

  it('says so when no goal is chosen', async () => {
    const m = example();
    m.goalId = null;
    expect((await result(m)).out.status).toBe('not-applicable');
  });
});

describe('Squiggle as the formula engine', () => {
  it('agrees with the method’s definition on point inputs, shared downstream items and signed changes', async () => {
    const cases: ParticipantModel[] = [
      example(),
      // Two actions sharing downstream items, with a harmful arrow and a diamond.
      model([link('A1', 'S1', 0.4), link('A2', 'S1', 0.2), link('A2', 'S2', -0.3), link('S1', 'S2', 0.25), link('S1', 'S3', -0.5), link('S2', 'S3', 0.6), link('S3', 'G', 0.35), link('S2', 'G', -0.1)]),
      // Ranges that span zero.
      model([link('A1', 'S1', diff(0.1, -0.2, 0.4)), link('S1', 'G', diff(-0.1, -0.5, 0.3)), link('A1', 'G', diff(0.05, 0, 0.1))]),
    ];
    for (const m of cases) {
      const prepared = prepareLocalAdditive(m, defaults);
      const reference = evaluatePlanReference(prepared.plan);
      const engine = await ENGINE.evaluate(prepared.program!);
      expect(engine.ok).toBe(true);
      if (!engine.ok) continue;
      expect(Object.keys(engine.values).sort()).toEqual(Object.keys(reference).sort());
      for (const [name, value] of Object.entries(reference)) expect(engine.values[name]).toBeCloseTo(value, 12);
    }
  });

  it('generates only safe identifiers and maps every one back to the map', async () => {
    const m = example();
    m.nodes[1]!.label = 'x = 1; evil() // "quoted" {name}';
    m.links[0]!.questionIds = { [ROLES.directChange]: 'q:change-from-action:A1>S1' };
    const { program } = prepareLocalAdditive(m, defaults);
    expect(program!.code).not.toContain('evil');
    expect(program!.code).toMatch(/^[a-z0-9_ =+*\-.()\[\],<>|?:{}\nA-Z]+$/); // numbers, generated names, Number.min/max, arithmetic
    for (const name of program!.code.match(/\b[ae]\d+(?:_n\d+)?_(?:lo|hi|bad)\b/g) ?? []) expect(program!.sources[name]).toBeTruthy();
    const input = Object.values(program!.sources).find((s) => s.kind === 'link' && s.id === 'A1>S1')!;
    expect(input).toMatchObject({ role: ROLES.directChange, questionId: 'q:change-from-action:A1>S1' });
    expect(Object.values(program!.sources).filter((s) => s.kind === 'action').map((s) => s.id)).toContain('A1');
  });

  it('keeps a person’s range as a range: no distribution is invented, nothing is sampled', async () => {
    const { program, out } = await result(model([link('A1', 'G', diff(0.3, 0.1, 0.5))]));
    expect(program!.code).not.toMatch(/normal|uniform|to |sample|mixture/i);
    expect(ENGINE.sampling).toBeNull();
    expect(out.actions[0]!.effect).toEqual({ low: 0.1, high: 0.5 });
  });

  it('withholds rather than clipping when added-up changes exceed what a chance can change by', async () => {
    const { action } = await result(model([link('A1', 'S1', 1), link('A1', 'S2', 1), link('S1', 'G', 0.7), link('S2', 'G', 0.7)]));
    expect(action('A1').status).toBe('withheld');
    expect(action('A1').effect).toBeUndefined();
    expect(action('A1').reasons[0]).toMatch(/exceed what a chance can change by/);
  });

  it('turns an engine failure into withheld results, never zeros', async () => {
    const broken = { ...ENGINE, evaluate: async () => ({ ok: false as const, error: 'boom' }) };
    const { output } = await evaluateMethod(localAdditive, example(), defaults, broken);
    for (const a of output.actions) {
      expect(a.status).toBe('withheld');
      expect(a.effect).toBeUndefined();
    }
    expect(output.ranking).toBeUndefined();
    const throwing = { ...ENGINE, evaluate: async () => { throw new Error('crash'); } };
    expect((await evaluateMethod(localAdditive, example(), defaults, throwing)).output.actions[0]!.reasons[0]).toContain('crash');
    expect((await ENGINE.evaluate({ language: 'squiggle', code: 'x = ', sources: {}, outputs: [] })).ok).toBe(false);
  });

  it('needs no engine at all when the semantic checks leave nothing to calculate', async () => {
    const m = example();
    m.links.push(requirement('S2', 'G'));
    const prepared = prepareLocalAdditive(m, defaults);
    expect(prepared.program).toBeNull();
    expect(compileAdditivePlan(prepared.plan).outputs).toEqual([]);
  });
});

describe('structure-only method', () => {
  it('never produces a number or an ordering', () => {
    const out = describe_(example());
    expect(out.status).toBe('no-numbers');
    for (const a of out.actions) {
      expect(a.effect).toBeUndefined();
      expect(a.clearlyAheadOf).toEqual([]);
    }
    expect(out.actions.find((a) => a.actionId === 'A1')!.routeCount).toBe(2);
  });

  it('keeps a required state visible even when no action leads to it', () => {
    const m = example();
    m.links.push(requirement('R', 'G'));
    m.nodes.push({ id: 'R', label: 'R', kind: 'state', beliefs: {} });
    const out = describe_(m);
    expect(out.bottlenecks).toContainEqual(expect.objectContaining({ nodeId: 'R', kind: 'required-without-action' }));
  });

  it('finds a state every route passes through', () => {
    const m = model([link('A1', 'S1'), link('A2', 'S1'), link('S1', 'G')]);
    const out = describe_(m);
    expect(out.bottlenecks).toContainEqual(expect.objectContaining({ nodeId: 'S1', kind: 'chokepoint' }));
  });
});

describe('methods are replaceable', () => {
  it('validates settings and falls back to defaults', () => {
    expect(resolveSettings(localAdditive, undefined)).toEqual({ ok: true, settings: defaults });
    expect(resolveSettings(localAdditive, { pointEstimateMargin: 500 }).ok).toBe(false);
    expect(resolveSettings(localAdditive, { requirementPolicy: 'ignore' }).ok).toBe(false);
  });

  it('a new method can be registered and run through the normal workflow without touching the app', async () => {
    const counting: CalculationMethod<{ label: string }> = {
      id: 'test-count-links',
      version: '0.0.1',
      name: 'Counts links (test)',
      summary: 'test',
      requiresAcknowledgement: false,
      assumptions: ['none'],
      limits: [],
      requiredInputs: ['arrows'],
      example: { caption: '', nodes: [], arrows: [], outcome: '' },
      settingsSchema: z.object({ label: z.string() }),
      defaultSettings: { label: 'links' },
      settingsFields: [],
      consumes: [ROLES.linkStance],
      elicitation: [],
      prepare: (m, s) => ({ program: null, finish: () => ({ status: 'no-numbers', headline: `${m.links.filter((l) => l.stance === 'yes').length} ${s.label}`, actions: [], diagnostics: [], bottlenecks: [] }) }),
    };
    registerMethod(counting);
    expect(listMethods().map((m) => m.id)).toContain('test-count-links');
    const t = seeded();
    // Draft questions are locked for participants until asked or until open exploration is on.
    expect(() => t.as(t.alex)({ type: 'answer', questionId: t.stanceQ(t.A1, t.S1), value: { kind: 'choice', choice: 'yes' }, via: 'explorer' })).toThrow(/not open/);
    t.fac({ type: 'set_settings', layers: { connections: { open: true } } });
    t.as(t.alex)({ type: 'answer', questionId: t.stanceQ(t.A1, t.S1), value: { kind: 'choice', choice: 'yes' }, via: 'explorer' });
    await t.calc({ methodId: 'test-count-links', settings: { label: 'held' } });
    const run = t.view().runs.at(-1)!;
    expect(run.methodId).toBe('test-count-links');
    expect(run.methodVersion).toBe('0.0.1');
    expect(run.settings).toEqual({ label: 'held' });
    expect(run.outputs[t.alex]!.headline).toBe('1 held');
    expect(run.outputs[t.sam]!.headline).toBe('0 held');
    expect(getMethod('nope')).toBeUndefined();
  });
});
