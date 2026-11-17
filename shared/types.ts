/**
 * Core domain types. Everything here is plain JSON-serialisable data so the
 * same shapes travel between server, browser, exports and tests.
 */
import type { WorkshopConfig } from './config';

export type NodeKind = 'goal' | 'state' | 'action';

/**
 * Two different claims a link can stand for. They are never mixed:
 *  - influence:   "from" happening would help bring about "to" (causal direction from → to)
 *  - requirement: "to" cannot happen without "from" (a necessity claim)
 * A link always points in the causal direction. Evidence that runs the other
 * way ("if B happened, A probably happened too") is not a link.
 */
export type Relation = 'influence' | 'requirement';

export type Actor =
  | { type: 'facilitator' }
  | { type: 'participant'; id: string }
  | { type: 'system' };

export interface ProvenanceEntry {
  at: string;
  actor: Actor;
  /** What happened, in a machine-readable form. */
  event: 'created' | 'from-suggestion' | 'merged-in' | 'renamed' | 'redefined' | 'archived' | 'restored';
  /** Original wording, suggestion id, merged node id etc. */
  detail?: Record<string, string>;
}

export type ObjectStatus = 'active' | 'merged' | 'archived';

export interface ModelNode {
  id: string;
  kind: NodeKind;
  label: string;
  definition: string;
  status: ObjectStatus;
  mergedInto?: string;
  /** Bumped whenever the meaning (not just spelling) changes. Answers remember which one they were given against. */
  meaningRev: number;
  createdAt: string;
  updatedAt: string;
  provenance: ProvenanceEntry[];
  /** Set when a participant added this themselves; it stays their personal item until that layer is pooled. */
  owner?: string;
  /** The item this came up under while working backwards. Used only to lay the map out roughly — it is not a link. */
  elicitedFor?: string;
  /** Facilitator-arranged position on the shared map (optional). */
  position?: { x: number; y: number };
}

export interface ModelLink {
  id: string;
  from: string;
  to: string;
  relation: Relation;
  status: ObjectStatus;
  mergedInto?: string;
  createdAt: string;
  provenance: ProvenanceEntry[];
}

export type QuestionSubject =
  | { type: 'workshop' }
  | { type: 'node'; nodeId: string }
  | { type: 'link'; linkId: string };

export type QuestionStatus = 'draft' | 'live' | 'closed' | 'dismissed' | 'superseded';

export interface Question {
  id: string;
  /** Template this question was generated from, or 'custom' for a facilitator-written one. */
  templateId: string;
  subject: QuestionSubject;
  status: QuestionStatus;
  /** When true, participants may see each other's answers to this question. */
  revealed: boolean;
  /** Facilitator has lined this up to be asked soon (ISO time it was queued). */
  queuedAt?: string;
  createdAt: string;
  publishedAt?: string;
  closedAt?: string;
  /** How many times it has gone live. */
  rounds: number;
  /** Set aside automatically because the selected calculation method does not need it. Comes back if it does. */
  autoDismissed?: boolean;
  /** Only for custom questions: the full definition travels with the question. */
  custom?: { prompt: string; help?: string; answer: import('./config').AnswerSpec; stageId: string };
}

export type AnswerValue =
  /** "I don't know" — a real answer, never treated as zero or as "no". */
  | { kind: 'unsure' }
  /** "I've added what I wanted to" on an open-ended question (suggestions / connections). */
  | { kind: 'done' }
  | { kind: 'choice'; choice: string }
  | { kind: 'pick-node'; nodeId: string }
  /** p in [0,1]; optional low/high when the participant gave a range. */
  | { kind: 'probability'; p: number; low?: number; high?: number }
  /**
   * A change in a chance, in probability units (0.2 = 20 percentage points more likely; negative = less likely),
   * compared with the same expected course of events. Not an absolute chance.
   */
  | { kind: 'difference'; d: number; low?: number; high?: number }
  | { kind: 'text'; text: string };

export type AnswerSource =
  | 'live' // answered while the question was live
  | 'revisit' // changed later from the participant's own screen
  | 'explorer' // edited in the model explorer
  | 'proposal' // implied by the participant proposing the link themselves
  | 'on-behalf' // typed in by the facilitator for the participant
  | 'merged' // carried over when two states were merged — always flagged for review
  | 'confirmed'; // participant re-confirmed after a definition changed

/** What the answer was given against. If any of these moved on, the answer is stale. */
export interface AnswerBasis {
  /** nodeId → meaningRev */
  nodes: Record<string, number>;
  /** goal context revision (goal choice, success definition, time horizon); only when the wording depends on it */
  context?: number;
  /** template wording version */
  template: number;
}

export interface Answer {
  questionId: string;
  participantId: string;
  /** 1-based, increases with every change by this participant to this question. */
  revision: number;
  value: AnswerValue;
  reasoning?: string;
  basis: AnswerBasis;
  source: AnswerSource;
  enteredBy: Actor;
  at: string;
  /** Set on carried-over answers so they always get a human look. */
  needsReview?: string;
}

export type SuggestionStatus = 'pending' | 'accepted' | 'merged' | 'declined' | 'withdrawn';

export interface Suggestion {
  id: string;
  questionId: string;
  participantId: string;
  text: string;
  status: SuggestionStatus;
  /** Node the suggestion ended up as (accepted) or was folded into (merged). */
  nodeId?: string;
  linkId?: string;
  at: string;
  resolvedAt?: string;
}

export interface Participant {
  id: string;
  name: string;
  joinedAt: string;
  active: boolean;
  colorIndex: number;
}

export interface GoalContext {
  nodeId: string | null;
  successDefinition: string;
  horizon: string;
  /** Bumped when the goal, its success definition or the horizon changes. */
  contextRev: number;
}

/** The five layers an organizer controls separately. */
export type Layer = 'goals' | 'states' | 'actions' | 'connections' | 'estimates';
export const LAYERS: Layer[] = ['goals', 'states', 'actions', 'connections', 'estimates'];

export interface LayerSetting {
  /** People may work on this layer on their own (add items, draw arrows, give estimates) without being asked a live question. */
  open: boolean;
  /**
   * What people contributed on this layer is visible to everyone as a shared catalogue of candidates.
   * Pooling never forces agreement: seeing someone's arrow is not holding it.
   */
  pooled: boolean;
}

export interface WorkshopSettings {
  /** Participants can see each other's whole models (who holds what, their estimates). A different thing from pooling a catalogue. */
  shareModels: boolean;
  layers: Record<Layer, LayerSetting>;
}

export interface SynthesisVersion {
  version: number;
  at: string;
  by: Actor;
  name: string;
  /** Whose models were brought together. */
  contributors: string[];
  /** Explicit choices for arrows the contributors do not all hold. Anything undecided is left out and listed. */
  decisions: Record<string, 'include' | 'exclude'>;
  /** How estimates are pooled, if at all. */
  aggregation: { methodId: string; settings: unknown };
}

/**
 * A combined model built from several people's models. It is its own object:
 * personal models are never overwritten, every save is a new version, and it
 * can be archived at any time.
 */
export interface Synthesis extends SynthesisVersion {
  id: string;
  createdBy: Actor;
  createdAt: string;
  archived: boolean;
  previous: SynthesisVersion[];
}

export interface CalculationRun {
  id: string;
  at: string;
  by: Actor;
  methodId: string;
  methodVersion: string;
  /** The exact settings used. */
  settings: unknown;
  /** Assumptions the method declared (and the user acknowledged) at run time. */
  assumptions: string[];
  /** Model revision the run was computed from; compare with state.modelRev to see if it is out of date. */
  modelRev: number;
  /**
   * One independent result per participant, plus one per synthesis under the key "syn:<id>".
   * Results are never averaged with each other; a synthesis result is computed from pooled inputs.
   */
  outputs: Record<string, import('./calc/types').MethodOutput>;
  /** Which version of each synthesis was used. */
  synthesisVersions?: Record<string, number>;
  /** The formula engine that did the arithmetic, and its sampling settings (null = exact arithmetic, no sampling). */
  engine?: { id: string; version: string; sampling: { sampleCount: number; seed: string } | null };
  /** The generated formulas per model, with what each generated name stands for. Absent for methods with no arithmetic. */
  programs?: Record<string, { code: string; sources: Record<string, import('./calc/types').SourceRef> }>;
}

export interface HistoryEntry {
  seq: number;
  at: string;
  actor: Actor;
  type: string;
  summary: string;
}

export interface WorkshopState {
  id: string;
  title: string;
  createdAt: string;
  /** Sequence number of the last applied event. */
  seq: number;
  /** Bumped by anything that changes what a calculation would see. */
  modelRev: number;
  isExample: boolean;
  /** solo: one person is organizer and participant at once. */
  mode: 'workshop' | 'solo';
  config: WorkshopConfig;
  settings: WorkshopSettings;
  stageId: string;
  goal: GoalContext;
  participants: Record<string, Participant>;
  nodes: Record<string, ModelNode>;
  links: Record<string, ModelLink>;
  questions: Record<string, Question>;
  liveQuestionId: string | null;
  suggestions: Record<string, Suggestion>;
  /** questionId → participantId → every revision, oldest first. Nothing is ever overwritten. */
  answers: Record<string, Record<string, Answer[]>>;
  runs: CalculationRun[];
  syntheses: Record<string, Synthesis>;
  history: HistoryEntry[];
}

export type Role = { type: 'facilitator' } | { type: 'participant'; id: string };

/** What a given client is allowed to see. Same shape as the state, already filtered. */
export interface WorkshopView extends WorkshopState {
  role: Role;
  joinCode: string;
  /** Per question: how many active participants have responded (visible to everyone; no content). */
  progress: Record<string, { responded: number; total: number; respondedIds?: string[] }>;
  /** Participants with a live connection right now. */
  online: string[];
}

export class CommandError extends Error {
  constructor(
    public code: 'forbidden' | 'invalid' | 'not-found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
