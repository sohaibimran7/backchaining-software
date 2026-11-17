import { z } from 'zod';
import type { AggregationInput, AggregationMethod, AggregationResult } from './types';

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

const meanSettings = z.object({
  minContributors: z.number().int().min(1).max(50).default(2),
  range: z.enum(['spread', 'none']).default('spread'),
  whenConditionsDiffer: z.enum(['withhold', 'use-and-flag']).default('withhold'),
});
type MeanSettings = z.infer<typeof meanSettings>;

/** Equal-person arithmetic mean of answers to one identical question. */
export const equalMean: AggregationMethod<MeanSettings> = {
  id: 'equal-mean',
  version: '1.0.0',
  name: 'Simple average (each person counts equally)',
  summary:
    'For each question, the plain average of the estimates from the people who answered it against the current wording and time horizon. Everyone’s original stays untouched and is shown beside the average.',
  assumptions: [
    'The people answered the same question: same two items, same wording, same definitions, same time horizon.',
    'Each person counts equally. Nobody is weighted by confidence or expertise.',
    '“Not sure” and no answer are left out of the average. They are not treated as zero.',
    'Averaging inputs does not make the combined numbers a coherent causal model; the calculation method’s own assumptions still apply on top.',
  ],
  limits: [
    'An average hides disagreement; the lowest and highest individual estimates are always shown with it.',
    'If people had different things feeding into the target in their own maps, their answers were conditional on different things. By default those are not averaged and are listed for re-asking.',
    'An arrow someone did not draw contributes nothing here. It is not a zero estimate.',
  ],
  settingsSchema: meanSettings,
  defaultSettings: { minContributors: 2, range: 'spread', whenConditionsDiffer: 'withhold' },
  settingsFields: [
    { key: 'minContributors', label: 'Fewest people needed for an average', help: 'With fewer usable estimates than this, no average is given and the question is listed as missing.', type: 'number', min: 1, max: 50, step: 1, unit: 'people' },
    {
      key: 'range',
      label: 'Range carried into calculations',
      help: '"Lowest to highest" passes the spread of individual estimates on as the range, so disagreement widens the result. "Average only" passes a single number.',
      type: 'select',
      options: [
        { value: 'spread', label: 'Lowest to highest individual estimate' },
        { value: 'none', label: 'Average only' },
      ],
    },
    {
      key: 'whenConditionsDiffer',
      label: 'When people’s maps differ around the target',
      help: 'Their answers assumed different surroundings, so they are not answers to one question. "Do not average" lists them for re-asking. "Average and flag" gives a number marked as needing review.',
      type: 'select',
      options: [
        { value: 'withhold', label: 'Do not average; list for re-asking' },
        { value: 'use-and-flag', label: 'Average and flag for review' },
      ],
    },
  ],
  aggregate(input, settings): AggregationResult {
    const s = sort(input);
    const base = { unsure: s.unsure, missing: s.missing, needsReview: s.needsReview };
    const ps = s.answered.map((c) => c.p!);
    const used = s.answered.map((c) => c.participantId);
    if (ps.length === 0) return { ...base, used: [], flagged: false, note: 'Nobody has a usable estimate for this.' };
    const spread = { min: Math.min(...ps), max: Math.max(...ps) };
    if (ps.length < settings.minContributors)
      return { ...base, used: [], spread, flagged: false, note: `Only ${ps.length} usable estimate${ps.length === 1 ? '' : 's'}; ${settings.minContributors} needed for an average.` };
    if (input.conditionsDiffer && settings.whenConditionsDiffer === 'withhold')
      return { ...base, used: [], spread, flagged: true, note: 'People’s maps differ around this target, so their answers are not to the same question. Ask it again against the combined map.' };
    const p = ps.reduce((a, b) => a + b, 0) / ps.length;
    // Individual ranges, where given, widen the spread.
    const lows = s.answered.map((c) => c.low ?? c.p!);
    const highs = s.answered.map((c) => c.high ?? c.p!);
    const value = settings.range === 'spread' ? { p, low: Math.min(...lows), high: Math.max(...highs) } : { p };
    return {
      ...base,
      value,
      used,
      spread,
      flagged: input.conditionsDiffer,
      note: `Average of ${ps.length} estimate${ps.length === 1 ? '' : 's'}${input.conditionsDiffer ? ' (maps differ around this target: review before relying on it)' : ''}.`,
    };
  },
};
