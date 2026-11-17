/**
 * Every change to a workshop is a command, validated here on the server.
 * Accepted commands are stored in order; replaying them rebuilds the workshop.
 */
import { z } from 'zod';
import { answerSpecSchema, configSchema, nodeKindSchema, relationSchema } from './config';

const text = (max: number) => z.string().trim().min(1).max(max);
const id = z.string().min(1).max(200);

export const answerValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unsure') }),
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('choice'), choice: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('pick-node'), nodeId: id }),
  z.object({
    kind: z.literal('probability'),
    p: z.number().min(0).max(1),
    low: z.number().min(0).max(1).optional(),
    high: z.number().min(0).max(1).optional(),
  }),
  z.object({ kind: z.literal('difference'), d: z.number().min(-1).max(1), low: z.number().min(-1).max(1).optional(), high: z.number().min(-1).max(1).optional() }),
  z.object({ kind: z.literal('text'), text: text(2000) }),
]);

const subjectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workshop') }),
  z.object({ type: z.literal('node'), nodeId: id }),
  z.object({ type: z.literal('link'), linkId: id }),
]);

const customAnswerSchema = answerSpecSchema.refine((a) => a.type === 'choice' || a.type === 'text' || a.type === 'probability' || a.type === 'difference', {
  message: 'Custom questions can be choice, text or probability questions',
});

/** Commands a browser may send. */
export const clientCommandSchema = z.discriminatedUnion('type', [
  // — anyone, about their own answers (the facilitator may name a participant to enter on their behalf)
  z.object({
    type: z.literal('answer'),
    questionId: id,
    value: answerValueSchema,
    reasoning: z.string().trim().max(1000).optional(),
    participantId: id.optional(),
    via: z.enum(['question', 'explorer']).default('question'),
  }),
  z.object({ type: z.literal('confirm_answer'), questionId: id, participantId: id.optional() }),
  z.object({ type: z.literal('suggest'), questionId: id, text: text(200), participantId: id.optional() }),
  z.object({ type: z.literal('edit_suggestion'), suggestionId: id, text: text(200) }),
  z.object({ type: z.literal('withdraw_suggestion'), suggestionId: id }),
  z.object({
    type: z.literal('nominate_link'),
    questionId: id,
    sourceNodeId: id,
    /** 'withdraw' takes back an earlier pick: it records that this person no longer includes the link. */
    as: z.enum(['helps', 'harms', 'required', 'withdraw']),
    mechanism: z.string().trim().max(300).optional(),
    participantId: id.optional(),
  }),
  z.object({ type: z.literal('rename_participant'), name: text(40), participantId: id.optional() }),
  // — map editing (facilitator; participants too when open exploration is on)
  z.object({ type: z.literal('add_node'), kind: nodeKindSchema, label: text(120), definition: z.string().trim().max(1000).default(''), elicitedFor: id.optional() }),
  z.object({ type: z.literal('add_link'), from: id, to: id, relation: relationSchema }),
  /**
   * Draw (or erase) an arrow in ONE person's model. Drawing puts the arrow in the candidate
   * catalogue if it is new and records that this person holds it; erasing records that they do not.
   * Refused if it would close a loop in that person's map.
   */
  z.object({
    type: z.literal('hold_link'),
    from: id,
    to: id,
    relation: relationSchema.default('influence'),
    hold: z.boolean(),
    as: z.enum(['helps', 'harms', 'conditional']).default('helps'),
    mechanism: z.string().trim().max(300).optional(),
    participantId: id.optional(),
  }),
  z.object({
    type: z.literal('save_synthesis'),
    /** Omit to create a new one; give an id to save a new version of an existing one. */
    synthesisId: id.optional(),
    name: text(80),
    contributors: z.array(id).min(1).max(50),
    decisions: z.record(z.string(), z.enum(['include', 'exclude'])).default({}),
    aggregation: z.object({ methodId: z.string().min(1).max(60), settings: z.unknown().optional() }),
  }),
  z.object({ type: z.literal('revert_synthesis'), synthesisId: id, version: z.number().int().min(1) }),
  z.object({ type: z.literal('set_synthesis_archived'), synthesisId: id, archived: z.boolean() }),
  // — facilitator only
  z.object({ type: z.literal('set_title'), title: text(120) }),
  z.object({ type: z.literal('set_stage'), stageId: id }),
  z.object({ type: z.literal('set_config'), config: configSchema }),
  z.object({
    type: z.literal('set_settings'),
    shareModels: z.boolean().optional(),
    layers: z.partialRecord(z.enum(['goals', 'states', 'actions', 'connections', 'estimates']), z.object({ open: z.boolean().optional(), pooled: z.boolean().optional() })).optional(),
  }),
  z.object({ type: z.literal('publish_question'), questionId: id }),
  z.object({ type: z.literal('close_question') }),
  z.object({ type: z.literal('queue_question'), questionId: id, queued: z.boolean() }),
  z.object({ type: z.literal('dismiss_question'), questionId: id, dismissed: z.boolean() }),
  z.object({ type: z.literal('reveal_question'), questionId: id, revealed: z.boolean() }),
  z.object({
    type: z.literal('add_custom_question'),
    prompt: text(400),
    help: z.string().trim().max(600).optional(),
    answer: customAnswerSchema,
    subject: subjectSchema.default({ type: 'workshop' }),
    stageId: id.optional(),
  }),
  z.object({ type: z.literal('add_template_question'), templateId: id, subject: subjectSchema }),
  z.object({
    type: z.literal('resolve_suggestion'),
    suggestionId: id,
    resolution: z.enum(['accept', 'merge', 'decline', 'reopen']),
    /** accept: optional tidied-up wording (the original is kept in the record). */
    label: text(120).optional(),
    /** merge: the existing item this says the same thing as. */
    intoNodeId: id.optional(),
    /** merge must be confirmed explicitly. */
    confirm: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('edit_node'),
    nodeId: id,
    label: text(120).optional(),
    definition: z.string().trim().max(1000).optional(),
    /** True when the meaning changed (earlier answers get flagged for review); false for a spelling fix. */
    meaningChanged: z.boolean(),
  }),
  z.object({ type: z.literal('merge_nodes'), fromNodeId: id, intoNodeId: id, confirm: z.literal(true) }),
  z.object({ type: z.literal('set_node_status'), nodeId: id, status: z.enum(['active', 'archived']) }),
  z.object({ type: z.literal('move_nodes'), positions: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })) }),
  z.object({ type: z.literal('set_link_status'), linkId: id, status: z.enum(['active', 'archived']) }),
  z.object({ type: z.literal('select_goal'), nodeId: id, successDefinition: z.string().trim().max(600), horizon: z.string().trim().max(120) }),
  z.object({ type: z.literal('set_participant_active'), participantId: id, active: z.boolean() }),
  z.object({
    type: z.literal('run_calculation'),
    methodId: z.string().min(1).max(60),
    settings: z.unknown().optional(),
    /** Must be true for methods that rest on strong assumptions. */
    acknowledged: z.boolean().default(false),
  }),
]);
export type ClientCommand = z.infer<typeof clientCommandSchema>;

/** Commands only the server issues. */
export type SystemCommand =
  | { type: 'create'; title: string; config: z.infer<typeof configSchema>; isExample: boolean; mode?: 'workshop' | 'solo' }
  | { type: 'join'; participantId: string; name: string; active?: boolean }
  | {
      type: 'record_run';
      methodId: string;
      methodVersion: string;
      settings: unknown;
      assumptions: string[];
      outputs: Record<string, import('./calc/types').MethodOutput>;
      synthesisVersions?: Record<string, number>;
      engine?: { id: string; version: string; sampling: { sampleCount: number; seed: string } | null };
      programs?: Record<string, { code: string; sources: Record<string, import('./calc/types').SourceRef> }>;
      /** The model revision the results were computed from. */
      modelRev?: number;
    };

export type Command = Exclude<ClientCommand, { type: 'run_calculation' }> | SystemCommand;

export interface StoredEvent {
  seq: number;
  at: string;
  actor: import('./types').Actor;
  cmd: Command;
}

const actionResultSchema = z.object({
  actionId: id,
  status: z.enum(['estimated', 'incomplete', 'withheld', 'not-connected', 'described']),
  effect: z.object({ low: z.number().min(-1).max(1), high: z.number().min(-1).max(1) }).optional(),
  reasons: z.array(z.string().max(1000)).max(500),
  missingLinkIds: z.array(id).max(5000),
  routeCount: z.number().min(0),
  routesCapped: z.boolean(),
  viaNodeIds: z.array(id).max(5000),
  requiredNodeIds: z.array(id).max(5000),
  clearlyAheadOf: z.array(id).max(5000),
});
const rankingSchema = z.object({
  tiers: z.array(z.array(id).max(5000)).max(5000),
  complete: z.boolean(),
  note: z.string().max(2000),
});
const methodOutputSchema = z.object({
  ranking: rankingSchema.optional(),
  status: z.enum(['ok', 'partial', 'withheld', 'no-numbers', 'not-applicable']),
  headline: z.string().max(1000),
  actions: z.array(actionResultSchema).max(5000),
  diagnostics: z
    .array(
      z.object({
        severity: z.enum(['info', 'warning', 'blocker']),
        code: z.string().max(80),
        message: z.string().max(2000),
        nodeIds: z.array(id).optional(),
        linkIds: z.array(id).optional(),
      }),
    )
    .max(5000),
  bottlenecks: z.array(z.object({ nodeId: id, kind: z.enum(['required-without-action', 'required', 'chokepoint']), message: z.string().max(1000) })).max(5000),
});

const systemCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), title: text(120), config: configSchema, isExample: z.boolean(), mode: z.enum(['workshop', 'solo']).optional() }),
  z.object({ type: z.literal('join'), participantId: id, name: text(40), active: z.boolean().optional() }),
  z.object({
    type: z.literal('record_run'),
    methodId: z.string().min(1).max(60),
    methodVersion: z.string().min(1).max(40),
    settings: z.unknown(),
    assumptions: z.array(z.string().max(1000)).max(50),
    outputs: z.record(z.string(), methodOutputSchema),
    synthesisVersions: z.record(z.string(), z.number().int()).optional(),
    engine: z.object({ id: z.string().max(60), version: z.string().max(40), sampling: z.object({ sampleCount: z.number().int(), seed: z.string().max(80) }).nullable() }).optional(),
    programs: z
      .record(
        z.string(),
        z.object({
          code: z.string().max(4_000_000),
          sources: z.record(
            z.string(),
            z.object({ kind: z.enum(['link', 'node', 'action']), id, role: z.string().max(80).optional(), questionId: id.optional(), bound: z.enum(['low', 'high']).optional(), note: z.string().max(300).optional() }),
          ),
        }),
      )
      .optional(),
    modelRev: z.number().int().optional(),
  }),
]);

const actorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('facilitator') }),
  z.object({ type: z.literal('system') }),
  z.object({ type: z.literal('participant'), id }),
]);

/** Shape of one line in an exported workshop file. Used to check imports before replaying them. */
export const storedEventSchema = z.object({
  seq: z.number().int().min(1),
  at: z.string().max(40),
  actor: actorSchema,
  cmd: z.union([systemCommandSchema, clientCommandSchema]),
});

export const exportFileSchema = z.object({
  format: z.literal('backchain-workshop'),
  formatVersion: z.literal(1),
  exportedAt: z.string().max(40),
  title: z.string().max(200),
  events: z.array(storedEventSchema).min(1).max(200_000),
});
export type ExportFile = z.infer<typeof exportFileSchema>;
