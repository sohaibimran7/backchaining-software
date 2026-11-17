/**
 * The aggregation contract: how several people's answers to the SAME question
 * are pooled into one input for a combined model. Replaceable in exactly the
 * same way as calculation methods (see registry.ts in this folder).
 *
 * Pooling inputs is a different thing from averaging results. The app never
 * averages calculation results across people.
 */
import type { z } from 'zod';
import type { SettingField } from '../calc/types';

export interface Contribution {
  participantId: string;
  /**
   * answered     – a usable estimate against the current wording, definitions and time horizon
   * unsure       – they said they do not know (not zero)
   * unanswered   – nothing recorded (not zero)
   * needs-review – answered, but against an older definition/horizon, so not the same question any more
   */
  state: 'answered' | 'unsure' | 'unanswered' | 'needs-review';
  /** The number itself: a chance (0–1) or a change in a chance (−1 to +1), whichever the question asks for. */
  p?: number;
  low?: number;
  high?: number;
}

export interface AggregationInput {
  contributions: Contribution[];
  /**
   * True when the people answering had different things feeding into the target in their own maps,
   * or the combined map differs from theirs — so "everything else as you expect" did not mean the same for all.
   */
  conditionsDiffer: boolean;
}

export interface AggregationResult {
  /** Absent when the method declines to pool. Never defaults to zero. */
  value?: { p: number; low?: number; high?: number };
  used: string[];
  unsure: string[];
  missing: string[];
  needsReview: string[];
  /** Lowest and highest individual estimates among those used. */
  spread?: { min: number; max: number };
  /** True when the pooled number should be re-elicited before it is relied on. */
  flagged: boolean;
  note: string;
}

export interface AggregationMethod<S = unknown> {
  id: string;
  version: string;
  name: string;
  summary: string;
  assumptions: string[];
  limits: string[];
  settingsSchema: z.ZodType<S>;
  defaultSettings: S;
  settingsFields: SettingField[];
  aggregate(input: AggregationInput, settings: S): AggregationResult;
}
