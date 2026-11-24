import { z } from 'zod';
import type { SettingField } from '../calc/types';
import type { AggregationInput, AggregationMethod, AggregationResult, Contribution } from './types';

function sort(input: AggregationInput) {
  const of = (s: string) => input.contributions.filter((c) => c.state === s).map((c) => c.participantId);
  return { unsure: of('unsure'), missing: of('unanswered'), needsReview: of('needs-review'), answered: input.contributions.filter((c) => c.state === 'answered' && c.p !== undefined) };
}

/** The default: keep everyone's estimates side by side and pool nothing. */
export const noPooling: AggregationMethod<Record<string, never>> = {
  id: 'no-pooling',
  version: '1.0.0',
  name: 'Do not pool estimates',
  summary: 'Arrows can be combined, but estimates stay with the people who gave them. The combined model has no numbers.',
  assumptions: ['None.'],
  limits: ['A combined model made this way can be explored and described, but numeric methods will report its estimates as missing.'],
  settingsSchema: z.object({}),
  defaultSettings: {},
  settingsFields: [],
  aggregate(input): AggregationResult {
    const s = sort(input);
    return { used: [], unsure: s.unsure, missing: s.missing, needsReview: s.needsReview, flagged: false, note: 'Estimates are not pooled.' };
  },
};

// — settings and safeguards every pooling method below shares —

const commonSettings = {
  minContributors: z.number().int().min(1).max(50).default(2),
  range: z.enum(['spread', 'none']).default('spread'),
  whenConditionsDiffer: z.enum(['withhold', 'use-and-flag']).default('withhold'),
};
const commonDefaults = { minContributors: 2, range: 'spread' as const, whenConditionsDiffer: 'withhold' as const };
interface Common {
  minContributors: number;
  range: 'spread' | 'none';
  whenConditionsDiffer: 'withhold' | 'use-and-flag';
}
const commonFields = (what: string): SettingField[] => [
  { key: 'minContributors', label: `Fewest people needed for ${what}`, help: 'With fewer usable estimates than this, no pooled number is given and the question is listed as missing.', type: 'number', min: 1, max: 50, step: 1, unit: 'people' },
  {
    key: 'range',
    label: 'Range carried into calculations',
    help: '"Lowest to highest" passes the spread of individual estimates on as the range, so disagreement widens the result. "Pooled number only" passes a single number.',
    type: 'select',
    options: [
      { value: 'spread', label: 'Lowest to highest individual estimate' },
      { value: 'none', label: 'Pooled number only' },
    ],
  },
  {
    key: 'whenConditionsDiffer',
    label: 'When people’s maps differ around the target',
    help: 'Their answers assumed different surroundings, so they are not answers to one question. "Do not pool" lists them for re-asking. "Pool and flag" gives a number marked as needing review.',
    type: 'select',
    options: [
      { value: 'withhold', label: 'Do not pool; list for re-asking' },
      { value: 'use-and-flag', label: 'Pool and flag for review' },
    ],
  },
];
const COMMON_ASSUMPTIONS = [
  'The people answered the same question: same two items, same wording, same definitions, same time horizon.',
  '“Not sure” and no answer are left out. They are not treated as zero.',
  'Pooling inputs does not make the combined numbers a coherent causal model; the calculation method’s own assumptions still apply on top.',
];
const COMMON_LIMITS = [
  'If people had different things feeding into the target in their own maps, their answers were conditional on different things. By default those are not pooled and are listed for re-asking.',
  'An arrow someone did not draw contributes nothing here. It is not a zero estimate.',
];

/**
 * The shared procedure: leave out what is not an answer to this question, refuse when too few
 * remain or when conditions differ, and otherwise let `centre` combine the usable estimates.
 */
function pool(
  input: AggregationInput,
  settings: Common,
  word: string,
  centre: (answered: Contribution[]) => { p: number; weights?: Record<string, number>; extra?: string } | { refuse: string },
): AggregationResult {
  const s = sort(input);
  const base = { unsure: s.unsure, missing: s.missing, needsReview: s.needsReview };
  const ps = s.answered.map((c) => c.p!);
  if (ps.length === 0) return { ...base, used: [], flagged: false, note: 'Nobody has a usable estimate for this.' };
  const spread = { min: Math.min(...ps), max: Math.max(...ps) };
  if (ps.length < settings.minContributors)
    return { ...base, used: [], spread, flagged: false, note: `Only ${ps.length} usable estimate${ps.length === 1 ? '' : 's'}; ${settings.minContributors} needed.` };
  if (input.conditionsDiffer && settings.whenConditionsDiffer === 'withhold')
    return { ...base, used: [], spread, flagged: true, note: 'People’s maps differ around this target, so their answers are not to the same question. Ask it again against the combined map.' };
  const c = centre(s.answered);
  if ('refuse' in c) return { ...base, used: [], spread, flagged: false, note: c.refuse };
  // Individual ranges, where given, widen the spread.
  const lows = s.answered.map((x) => x.low ?? x.p!);
  const highs = s.answered.map((x) => x.high ?? x.p!);
  const value = settings.range === 'spread' ? { p: c.p, low: Math.min(...lows, c.p), high: Math.max(...highs, c.p) } : { p: c.p };
  return {
    ...base,
    value,
    used: s.answered.map((x) => x.participantId),
    weights: c.weights,
    spread,
    flagged: input.conditionsDiffer,
    note: `${word} of ${ps.length} estimate${ps.length === 1 ? '' : 's'}${c.extra ? ` ${c.extra}` : ''}${input.conditionsDiffer ? ' (maps differ around this target: review before relying on it)' : ''}.`,
  };
}

const meanSettings = z.object(commonSettings);

/** Equal-person arithmetic mean of answers to one identical question. */
export const equalMean: AggregationMethod<z.infer<typeof meanSettings>> = {
  id: 'equal-mean',
  version: '1.1.0',
  name: 'Simple average (each person counts equally)',
  summary: 'For each question, the plain average of the estimates from the people who answered it against the current wording and time horizon. Everyone’s original stays untouched and is shown beside the average.',
  assumptions: [COMMON_ASSUMPTIONS[0]!, 'Each person counts equally. Nobody is weighted by confidence or expertise.', ...COMMON_ASSUMPTIONS.slice(1)],
  limits: [
    'An average hides disagreement and is pulled by one outlier; the lowest and highest individual estimates are always shown with it.',
    'A well-evidenced answer and a guess count the same. People have no way to signal how much they know.',
    ...COMMON_LIMITS,
  ],
  settingsSchema: meanSettings,
  defaultSettings: commonDefaults,
  settingsFields: commonFields('an average'),
  aggregate: (input, settings) => pool(input, settings, 'Average', (a) => ({ p: a.reduce((sum, x) => sum + x.p!, 0) / a.length })),
};

/** The middle estimate: one extreme answer cannot move it. */
export const median: AggregationMethod<z.infer<typeof meanSettings>> = {
  id: 'median',
  version: '1.0.0',
  name: 'Middle estimate (median)',
  summary: 'For each question, the middle of the estimates given (with an even number, halfway between the two middle ones). One unusually high or low answer does not move it, which matters in a group of four or five.',
  assumptions: [COMMON_ASSUMPTIONS[0]!, 'Each person counts equally.', ...COMMON_ASSUMPTIONS.slice(1)],
  limits: [
    'It ignores how far the outer estimates are from the middle, so a real minority view has no pull at all. The lowest and highest estimates are shown with it.',
    'A well-evidenced answer and a guess count the same.',
    ...COMMON_LIMITS,
  ],
  settingsSchema: meanSettings,
  defaultSettings: commonDefaults,
  settingsFields: commonFields('a middle estimate'),
  aggregate: (input, settings) =>
    pool(input, settings, 'Middle', (a) => {
      const ps = a.map((x) => x.p!).sort((x, y) => x - y);
      const mid = Math.floor(ps.length / 2);
      return { p: ps.length % 2 ? ps[mid]! : (ps[mid - 1]! + ps[mid]!) / 2 };
    }),
};

const weightedSettings = z.object({ ...commonSettings, strength: z.enum(['proportional', 'strong']).default('proportional'), narrowestRange: z.number().min(1).max(50).default(5) });

/** People who gave a narrower range count for more. */
export const rangeWeighted: AggregationMethod<z.infer<typeof weightedSettings>> = {
  id: 'range-weighted-mean',
  version: '1.0.0',
  name: 'Average weighted by how narrow each person’s range is',
  summary:
    'An average in which a person who gave a narrow range counts for more than one who gave a wide range. It lets people signal how sure they are through the range they already give, without a separate confidence question. Each person’s share is shown.',
  assumptions: [
    COMMON_ASSUMPTIONS[0]!,
    'A narrower range means better evidence, and people’s ranges are comparable with each other.',
    'Someone who gave a single number with no range is treated as having the widest range anyone gave for that question, so they count least. If nobody gave a range, everyone counts equally.',
    ...COMMON_ASSUMPTIONS.slice(1),
  ],
  limits: [
    'Overconfident people gain influence. A narrow range is a claim to know, not proof of knowing.',
    'It rewards giving a range at all. Tell people beforehand that ranges will be used this way.',
    ...COMMON_LIMITS,
  ],
  settingsSchema: weightedSettings,
  defaultSettings: { ...commonDefaults, strength: 'proportional', narrowestRange: 5 },
  settingsFields: [
    {
      key: 'strength',
      label: 'How much a narrow range counts',
      help: '"In proportion": half the width, twice the weight. "Strongly": half the width, four times the weight (the usual statistical rule if ranges are read as margins of error).',
      type: 'select',
      options: [
        { value: 'proportional', label: 'In proportion to narrowness' },
        { value: 'strong', label: 'Strongly (narrowness squared)' },
      ],
    },
    { key: 'narrowestRange', label: 'Narrowest range that earns extra weight', help: 'Ranges narrower than this many percentage points are treated as this wide, so nobody can dominate by claiming near-certainty.', type: 'number', min: 1, max: 50, step: 1, unit: 'points' },
    ...commonFields('an average'),
  ],
  aggregate: (input, settings) =>
    pool(input, settings, 'Weighted average', (a) => {
      const floor = settings.narrowestRange / 100;
      const given = a.filter((x) => x.low !== undefined && x.high !== undefined).map((x) => Math.max(floor, x.high! - x.low!));
      if (given.length === 0) return { p: a.reduce((sum, x) => sum + x.p!, 0) / a.length, extra: '(nobody gave a range, so everyone counted equally)' };
      const widest = Math.max(...given);
      const raw = a.map((x) => {
        const width = x.low !== undefined && x.high !== undefined ? Math.max(floor, x.high - x.low) : widest;
        return settings.strength === 'strong' ? 1 / (width * width) : 1 / width;
      });
      const total = raw.reduce((x, y) => x + y, 0);
      const weights = Object.fromEntries(a.map((x, i) => [x.participantId, raw[i]! / total]));
      return { p: a.reduce((sum, x, i) => sum + x.p! * (raw[i]! / total), 0), weights };
    }),
};

const oddsSettings = z.object({ ...commonSettings, nearestToCertain: z.number().min(0.1).max(10).default(1) });

/** Pool chances on the odds scale, where an answer near 0% or 100% carries its full weight. */
export const logOdds: AggregationMethod<z.infer<typeof oddsSettings>> = {
  id: 'log-odds-mean',
  version: '1.0.0',
  name: 'Average of the odds (for chances only)',
  summary:
    'Converts each chance to odds, averages those on a log scale, and converts back (the geometric mean of odds). An answer close to 0% or 100% pulls harder than it would in a plain average, so strong evidence about how likely something is shows up in the pooled number. Only for questions whose answer is a chance.',
  assumptions: [
    COMMON_ASSUMPTIONS[0]!,
    'Each person counts equally on the log-odds scale. No extra sharpening is applied on top.',
    'Someone who answers close to 0% or 100% does so because they have strong evidence, not out of habit.',
    ...COMMON_ASSUMPTIONS.slice(1),
  ],
  limits: [
    'It cannot pool a change in a chance (such as “+20 points”): odds are not defined for a change. Use it with the two-chances-per-arrow calculation method.',
    'It reflects evidence about how likely the next thing is, not about how big the difference between the two chances is. Someone sure that an arrow barely matters gets no extra weight.',
    'One person at exactly 0% or 100% would decide the result alone, so such answers are pulled in slightly (see the setting).',
    ...COMMON_LIMITS,
  ],
  settingsSchema: oddsSettings,
  defaultSettings: { ...commonDefaults, nearestToCertain: 1 },
  settingsFields: [
    { key: 'nearestToCertain', label: 'Closest to certain an answer may count as', help: 'Answers nearer than this many percentage points to 0% or 100% are treated as this far from it. Stops one answer of exactly 0% or 100% from deciding everything.', type: 'number', min: 0.1, max: 10, step: 0.1, unit: 'points' },
    ...commonFields('a pooled chance'),
  ],
  aggregate: (input, settings) =>
    pool(input, settings, 'Average of the odds', (a) => {
      if (input.unit !== 'probability') return { refuse: 'This way of pooling only works for chances, and this question asks for a change in a chance. Choose another way of pooling, or use the two-chances calculation method.' };
      const edge = settings.nearestToCertain / 100;
      const logits = a.map((x) => {
        const p = Math.min(1 - edge, Math.max(edge, x.p!));
        return Math.log(p / (1 - p));
      });
      const meanLogit = logits.reduce((x, y) => x + y, 0) / logits.length;
      return { p: 1 / (1 + Math.exp(-meanLogit)) };
    }),
};
