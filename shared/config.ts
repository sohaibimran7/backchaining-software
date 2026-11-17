/**
 * Workshop configuration: labels, theme, stages, question templates and the
 * calculation method. Everything a facilitator might reasonably want to change
 * lives here as data; the schema below protects the invariants the app needs.
 */
import { z } from 'zod';

export const nodeKindSchema = z.enum(['goal', 'state', 'action']);
export const relationSchema = z.enum(['influence', 'requirement']);

/**
 * Semantic roles let the app and calculation methods find the answers they need
 * without caring how a question is worded. A template may carry at most one.
 */
export const ROLES = {
  /**
   * "Do you hold this link?" Option values the app understands: yes, no, and optionally
   * "harms" (holds it, but it makes the target less likely) and "conditional" (only under some conditions).
   */
  linkStance: 'link.stance',
  /** Free text: what could make this help fail. Recorded, shown, never used in arithmetic. */
  linkFailureModes: 'link.failure_modes',
  /** Chance of the target if the source happens (everything else as expected). */
  probIfSource: 'link.probability_if_source_happens',
  /** Chance of the target if the source does not happen (everything else as expected). */
  probIfNoSource: 'link.probability_if_source_absent',
  /**
   * How many percentage points the source changes the chance of the target, compared with the same
   * expected course of events without it. A difference, not a conditional probability.
   */
  directChange: 'link.probability_difference',
  /** Chance of a state/goal on the expected course of events. Only asked when a method consumes it. */
  baseline: 'node.baseline_probability',
} as const;
export type RoleId = (typeof ROLES)[keyof typeof ROLES];

export const answerSpecSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('suggestions'),
    /** What an accepted suggestion becomes. */
    creates: z.object({
      nodeKind: nodeKindSchema,
      /** Optionally connect the new node to the question's subject. Always in the causal direction new → subject. */
      linkRelation: relationSchema.optional(),
    }),
    placeholder: z.string().max(140).optional(),
  }),
  z.object({
    type: z.literal('choice'),
    options: z.array(z.object({ value: z.string().min(1).max(40), label: z.string().min(1).max(80) })).min(2).max(8),
  }),
  z.object({ type: z.literal('pick-node'), kinds: z.array(nodeKindSchema).min(1) }),
  z.object({ type: z.literal('probability'), allowRange: z.boolean().default(true) }),
  /** A change in a chance, in percentage points, from −100 to +100. */
  z.object({ type: z.literal('difference'), allowRange: z.boolean().default(true) }),
  z.object({ type: z.literal('text'), placeholder: z.string().max(140).optional() }),
  /**
   * Connection discovery: for one target at a time, each person picks a few
   * existing items they think feed directly into it. The union of everyone's
   * picks becomes the shortlist to review — never every possible pair.
   */
  z.object({
    type: z.literal('nominate-links'),
    sourceKinds: z.array(nodeKindSchema).min(1),
    /** Soft guide shown to participants ("pick up to N"). */
    suggestedMax: z.number().int().min(1).max(20).default(4),
    /** Let people mark a pick as harmful (makes the target less likely) as well as helpful. */
    allowHarmful: z.boolean().default(true),
    /** Let people mark a pick as a requirement (the target cannot happen without it). */
    allowRequirement: z.boolean().default(true),
    /** Let people propose something that is not on the map yet (goes to the facilitator as a suggestion). */
    allowNew: nodeKindSchema.optional(),
  }),
]);
export type AnswerSpec = z.infer<typeof answerSpecSchema>;

export const subjectFilterSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('workshop') }),
  z.object({ type: z.literal('node'), kinds: z.array(nodeKindSchema).min(1) }),
  z.object({
    type: z.literal('link'),
    relations: z.array(relationSchema).min(1),
    /** Restrict to links whose source is one of these kinds (e.g. different wording for actions). */
    fromKinds: z.array(nodeKindSchema).min(1).optional(),
  }),
]);
export type SubjectFilter = z.infer<typeof subjectFilterSchema>;

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'Use lowercase letters, digits and dashes');

export const templateSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(80),
  /**
   * Wording shown to participants. Placeholders: {subject} {from} {to} {goal} {horizon} {success}.
   */
  prompt: z.string().min(1).max(400),
  help: z.string().max(600).optional(),
  subject: subjectFilterSchema,
  answer: answerSpecSchema,
  stageId: idSchema,
  /**
   * always: a draft question appears for every matching object.
   * when-method-requires: only while the selected calculation method consumes this template's role.
   * manual: never generated automatically; the facilitator adds it per object.
   */
  generate: z.enum(['always', 'when-method-requires', 'manual']).default('always'),
  role: z.string().max(60).optional(),
  allowUnsure: z.boolean().default(true),
  /** Bump when the meaning of the wording changes; earlier answers are then flagged for review. */
  version: z.number().int().min(1).default(1),
});
export type QuestionTemplate = z.infer<typeof templateSchema>;

export const stageSchema = z.object({
  id: idSchema,
  title: z.string().min(1).max(60),
  description: z.string().max(400).default(''),
  /** Shown to the facilitator only. */
  facilitatorHint: z.string().max(600).default(''),
});
export type Stage = z.infer<typeof stageSchema>;

export const labelsSchema = z.object({
  appName: z.string().min(1).max(40),
  goal: z.string().min(1).max(30),
  state: z.string().min(1).max(30),
  action: z.string().min(1).max(30),
  influence: z.string().min(1).max(40),
  requirement: z.string().min(1).max(40),
  unsure: z.string().min(1).max(40),
});

export const themeSchema = z.object({
  /** Accent colour as #rrggbb. */
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  goalColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  stateColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  actionColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    labels: labelsSchema,
    theme: themeSchema,
    stages: z.array(stageSchema).min(1).max(12),
    templates: z.array(templateSchema).max(60),
    calculation: z.object({
      methodId: z.string().min(1).max(60),
      /** Settings per method id, so switching back and forth keeps each method's settings. */
      settings: z.record(z.string(), z.unknown()).default({}),
    }),
    /** Default way of pooling estimates when models are combined. Each synthesis can override it. */
    aggregation: z
      .object({ methodId: z.string().min(1).max(60), settings: z.record(z.string(), z.unknown()).default({}) })
      .default({ methodId: 'no-pooling', settings: {} }),
    privacy: z.object({
      /** If true, newly published questions start with answers visible to everyone. Default false to avoid anchoring. */
      revealByDefault: z.boolean().default(false),
    }),
    limits: z.object({
      maxParticipants: z.number().int().min(1).max(50).default(12),
    }),
  })
  .superRefine((cfg, ctx) => {
    const stageIds = new Set<string>();
    for (const s of cfg.stages) {
      if (stageIds.has(s.id)) ctx.addIssue({ code: 'custom', message: `Two stages share the id "${s.id}"` });
      stageIds.add(s.id);
    }
    const seen = new Set<string>();
    cfg.templates.forEach((t, i) => {
      if (seen.has(t.id)) ctx.addIssue({ code: 'custom', path: ['templates', i, 'id'], message: `Two templates share the id "${t.id}"` });
      seen.add(t.id);
      if (!stageIds.has(t.stageId))
        ctx.addIssue({ code: 'custom', path: ['templates', i, 'stageId'], message: `Template "${t.id}" points at a stage that does not exist ("${t.stageId}")` });
      const problem = roleContractProblem(t);
      if (problem) ctx.addIssue({ code: 'custom', path: ['templates', i], message: problem });
      if (t.answer.type === 'nominate-links' && t.subject.type !== 'node')
        ctx.addIssue({ code: 'custom', path: ['templates', i], message: `Template "${t.id}" asks what feeds into something, so its subject must be a node` });
      if (t.answer.type === 'suggestions' && t.answer.creates.linkRelation && t.subject.type !== 'node')
        ctx.addIssue({ code: 'custom', path: ['templates', i], message: `Template "${t.id}" links new items to its subject, so its subject must be a node` });
    });
    // The app derives each person's model from yes/no answers to these, so they must exist.
    for (const relation of ['influence', 'requirement'] as const) {
      const covered = cfg.templates.some(
        (t) => t.role === ROLES.linkStance && t.subject.type === 'link' && t.subject.relations.includes(relation) && !t.subject.fromKinds && t.generate === 'always',
      );
      if (!covered)
        ctx.addIssue({
          code: 'custom',
          path: ['templates'],
          message: `There must be an always-generated template with role ${ROLES.linkStance} covering every "${relation}" link, so each person can say whether they hold it`,
        });
    }
  });
export type WorkshopConfig = z.infer<typeof configSchema>;

/**
 * Roles come with a contract so answers can be consumed safely. Returns a
 * human-readable problem, or null when the template satisfies its role.
 */
export function roleContractProblem(t: QuestionTemplate): string | null {
  if (!t.role) return null;
  const linkOnly = () => (t.subject.type === 'link' ? null : `Template "${t.id}" has role ${t.role}, which only makes sense for questions about a link`);
  switch (t.role) {
    case ROLES.linkStance: {
      if (t.answer.type !== 'choice') return `Template "${t.id}" has role ${t.role} and must be a choice question`;
      const values = t.answer.options.map((o) => o.value);
      if (!values.includes('yes') || !values.includes('no')) return `Template "${t.id}" has role ${t.role}; its options must include the values "yes" and "no"`;
      return linkOnly();
    }
    case ROLES.probIfSource:
    case ROLES.probIfNoSource:
      if (t.answer.type !== 'probability') return `Template "${t.id}" has role ${t.role} and must be a probability question`;
      return linkOnly();
    case ROLES.directChange:
      if (t.answer.type !== 'difference') return `Template "${t.id}" has role ${t.role} and must be a percentage-point difference question`;
      return linkOnly();
    case ROLES.baseline:
      if (t.answer.type !== 'probability') return `Template "${t.id}" has role ${t.role} and must be a probability question`;
      return t.subject.type === 'node' ? null : `Template "${t.id}" has role ${t.role}, which only makes sense for questions about a state or goal`;
    case ROLES.linkFailureModes:
      if (t.answer.type !== 'text') return `Template "${t.id}" has role ${t.role} and must be a text question`;
      return linkOnly();
    default:
      return null; // unknown roles are allowed: future methods may define their own
  }
}

export function parseConfig(input: unknown): { ok: true; config: WorkshopConfig } | { ok: false; problems: string[] } {
  const result = configSchema.safeParse(input);
  if (result.success) return { ok: true, config: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
  };
}
