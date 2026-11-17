/**
 * The calculation contract.
 *
 * A calculation method is a self-contained strategy object. It never sees the
 * UI, the database or other participants: it receives ONE participant's model
 * as plain data plus its own validated settings, and returns results,
 * diagnostics and the assumptions it relied on. The app runs the selected
 * method once per participant and stores the outputs side by side.
 *
 * To add a method: implement `CalculationMethod`, register it in
 * `shared/calc/registry.ts`. See docs/CALCULATION_METHODS.md.
 */
import type { z } from 'zod';
import type { QuestionTemplate } from '../config';
import type { AnswerValue, NodeKind, Relation } from '../types';

/** A participant's answer to one role-bearing question, as a method sees it. */
export type Belief =
  /** Never asked or never answered. Not zero, not "no". */
  | { state: 'unanswered' }
  /** The participant said they do not know. Not zero, not "no". */
  | { state: 'unsure'; stale: boolean; reasoning?: string }
  | { state: 'answered'; value: AnswerValue; stale: boolean; needsReview: boolean; reasoning?: string };

/**
 * A person's position on one proposed link. These are deliberately distinct:
 *  yes         – they include it in their model
 *  conditional – they think it holds only under some conditions (an interaction)
 *  no          – they looked at it and reject it
 *  unsure      – they looked at it and do not know
 *  unstated    – they have not reviewed it (not the same as rejecting it)
 * A link that nobody proposed is simply absent: an approximation, not a claim of zero effect.
 */
export type Stance = 'yes' | 'conditional' | 'no' | 'unsure' | 'unstated';

export interface ModelNodeInput {
  id: string;
  kind: NodeKind;
  label: string;
  /** role → belief, for node-level roles such as a baseline probability. */
  beliefs: Record<string, Belief>;
}

export interface ModelLinkInput {
  id: string;
  from: string;
  to: string;
  relation: Relation;
  /** Whether this participant holds the link. 'unstated' = they were never asked and did not propose it. */
  stance: Stance;
  /** For held influence links: whether they think the source makes the target more or less likely. */
  direction?: 'helps' | 'harms';
  /** Their short note on how it works / under what conditions. */
  mechanism?: string;
  /** True when the stance was given against an older definition and has not been re-confirmed. */
  stanceStale: boolean;
  /** role → belief, for link-level roles such as conditional probabilities. */
  beliefs: Record<string, Belief>;
  /** role → the question the belief was read from, so results can be traced back to what was asked. */
  questionIds?: Record<string, string>;
}

/** One participant's model: the shared vocabulary plus only this person's claims. */
export interface ParticipantModel {
  participantId: string;
  goalId: string | null;
  horizon: string;
  nodes: ModelNodeInput[];
  links: ModelLinkInput[];
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'blocker';
  /** Stable machine-readable code, e.g. "missing-estimate". */
  code: string;
  message: string;
  nodeIds?: string[];
  linkIds?: string[];
}

export type ActionStatus =
  /** A number is reported, valid only under the method's declared assumptions. */
  | 'estimated'
  /** Evidence is missing; no number is reported (missing is not zero). */
  | 'incomplete'
  /** The method's assumptions do not hold here; a number would mislead, so none is given. */
  | 'withheld'
  /** No route from this action to the goal in this participant's model. */
  | 'not-connected'
  /** The method describes structure only and never produces numbers. */
  | 'described';

export interface ActionResult {
  actionId: string;
  status: ActionStatus;
  /**
   * Estimated change in the chance of the goal from doing this action,
   * relative to the same expected course of events without it. In probability
   * (0–1) units, as a range. Present only when status is 'estimated'.
   */
  effect?: { low: number; high: number };
  /** Plain-language reasons for an incomplete / withheld status. */
  reasons: string[];
  /** Links whose beliefs are missing or unusable for this action. */
  missingLinkIds: string[];
  /** Number of distinct routes from the action to the goal (capped). */
  routeCount: number;
  routesCapped: boolean;
  /** Nodes on at least one route from the action to the goal. */
  viaNodeIds: string[];
  /** States this participant says are required for something on those routes. */
  requiredNodeIds: string[];
  /** Other actions whose whole range lies below this one's. Empty unless ranges separate. */
  clearlyAheadOf: string[];
}

export interface Bottleneck {
  nodeId: string;
  kind: 'required-without-action' | 'required' | 'chokepoint';
  message: string;
}

/**
 * An ordering of actions, only as far as the method can support one.
 * Actions in the same tier cannot be told apart (their ranges overlap).
 */
export interface Ranking {
  /** Best first. Each tier lists actions the method cannot separate. */
  tiers: string[][];
  /** False when some actions could not be estimated and are therefore not placed. */
  complete: boolean;
  note: string;
}

/** A tiny worked illustration shown in the method picker. */
export interface MethodExample {
  caption: string;
  nodes: { id: string; label: string; kind: NodeKind }[];
  arrows: { from: string; to: string; label?: string }[];
  outcome: string;
}

export interface MethodOutput {
  /** Present only when the method ranks actions and enough inputs and assumptions hold to say anything. */
  ranking?: Ranking;
  status: 'ok' | 'partial' | 'withheld' | 'no-numbers' | 'not-applicable';
  headline: string;
  actions: ActionResult[];
  diagnostics: Diagnostic[];
  bottlenecks: Bottleneck[];
}

/** Describes one setting so the app can render a form without method-specific UI code. */
export type SettingField =
  | { key: string; label: string; help: string; type: 'select'; options: { value: string; label: string }[] }
  | { key: string; label: string; help: string; type: 'number'; min: number; max: number; step: number; unit?: string }
  | { key: string; label: string; help: string; type: 'boolean' };

export interface CalculationMethod<S = unknown> {
  id: string;
  /** Bump when results for the same inputs could change. Stored with every run. */
  version: string;
  name: string;
  summary: string;
  /** True when the method produces numbers that rest on strong assumptions; the user must acknowledge them before a run. */
  requiresAcknowledgement: boolean;
  /** Declared assumptions, shown beside every result and stored with every run. */
  assumptions: string[];
  /** What this method cannot do. Shown in the UI. */
  limits: string[];
  /** What it needs from people, in plain language. Shown in the method picker before anything is run. */
  requiredInputs: string[];
  example: MethodExample;
  settingsSchema: z.ZodType<S>;
  defaultSettings: S;
  settingsFields: SettingField[];
  /** Roles of answers this method reads. Drives which "when-method-requires" questions get generated. */
  consumes: string[];
  /** Question definitions this method needs that the workshop config may not contain. A config template with the same id overrides the wording. */
  elicitation: QuestionTemplate[];
  /**
   * Check the model against this method's assumptions and translate what can be calculated into formulas.
   * Pure and synchronous. Must not throw on missing data: report it instead. All judgement about what is
   * valid, missing or unsupported happens here — the formula engine only does arithmetic.
   */
  prepare(model: ParticipantModel, settings: S): PreparedCalculation;
}

/** Where a generated formula variable came from, so every number can be traced back to the map. */
export interface SourceRef {
  kind: 'link' | 'node' | 'action';
  id: string;
  /** For inputs: which answer was read. */
  role?: string;
  questionId?: string;
  bound?: 'low' | 'high';
  note?: string;
}

/** Formulas for an engine to evaluate. Identifiers are generated by the app, never taken from user text. */
export interface FormulaProgram {
  language: 'squiggle';
  code: string;
  /** generated identifier → what it stands for */
  sources: Record<string, SourceRef>;
  /** Names expected in the result. */
  outputs: string[];
}

export type EngineResult = { ok: true; values: Record<string, number> } | { ok: false; error: string };

/** Evaluates generated formulas. Replaceable; knows nothing about workshops, people or assumptions. */
export interface FormulaEngine {
  id: string;
  version: string;
  /** Sampling settings in force, or null when evaluation is exact arithmetic with no sampling. */
  sampling: { sampleCount: number; seed: string } | null;
  evaluate(program: FormulaProgram): Promise<EngineResult>;
}

export interface PreparedCalculation {
  /** Null when the method needs no arithmetic (or nothing could be calculated). */
  program: FormulaProgram | null;
  /** Turn the engine's numbers into results. Given null or a failure, affected results are withheld — never zero. */
  finish(result: EngineResult | null): MethodOutput;
}

/** Run one method on one model through an engine. */
export async function evaluateMethod<S>(method: CalculationMethod<S>, model: ParticipantModel, settings: S, engine: FormulaEngine): Promise<{ output: MethodOutput; program: FormulaProgram | null }> {
  const prepared = method.prepare(model, settings);
  if (!prepared.program) return { output: prepared.finish(null), program: null };
  let result: EngineResult;
  try {
    result = await engine.evaluate(prepared.program);
  } catch (err) {
    result = { ok: false, error: (err as Error).message || 'The calculation engine failed.' };
  }
  return { output: prepared.finish(result), program: prepared.program };
}
