/**
 * "Structure only" method: the honest default.
 *
 * It reports what each participant's model says structurally — which actions
 * connect to the goal, through what, what is required, what is unknown — and
 * deliberately produces no numbers and no ranking, because yes/no/unsure
 * claims alone do not determine how much any action changes the chance of the goal.
 */
import { z } from 'zod';
import { ROLES } from '../config';
import { ancestors, countRoutes, descendants, findBottlenecks, heldLinks, incoming, outgoing, topoOrder } from './graph';
import type { ActionResult, CalculationMethod, Diagnostic, MethodOutput, ParticipantModel } from './types';

const settingsSchema = z.object({
  /** Whether links the participant has not been asked about are listed as open questions. */
  listUnstatedLinks: z.boolean().default(true),
});
type Settings = z.infer<typeof settingsSchema>;

export const structureDiagnostic: CalculationMethod<Settings> = {
  id: 'structure-diagnostic',
  version: '1.0.0',
  name: 'Structure only (no ranking)',
  summary:
    'Describes each person’s model: which actions connect to the goal, what they say is required, where routes narrow, and what is still unknown. Produces no numbers.',
  requiresAcknowledgement: false,
  assumptions: [
    'A link counts as part of a person’s model only if they proposed it or included it when reviewing. Not reviewed, rejected and not sure are kept apart.',
    'A link nobody proposed is absent from the map: an approximation, not a claim of no effect.',
    'Nothing is inferred about how strong any link is.',
  ],
  limits: ['Does not say which action is better. Arrows alone are not enough to rank actions.'],
  requiredInputs: ['Each person’s arrows (which items they connect, and which they mark as required).', 'No numbers of any kind.'],
  example: {
    caption: 'Two actions, two states, one goal.',
    nodes: [
      { id: 'a1', label: 'Action 1', kind: 'action' },
      { id: 'a2', label: 'Action 2', kind: 'action' },
      { id: 's1', label: 'State 1', kind: 'state' },
      { id: 's2', label: 'State 2', kind: 'state' },
      { id: 'g', label: 'Goal', kind: 'goal' },
    ],
    arrows: [
      { from: 'a1', to: 's1' },
      { from: 'a2', to: 's2' },
      { from: 's1', to: 's2' },
      { from: 's1', to: 'g' },
      { from: 's2', to: 'g' },
    ],
    outcome: 'Reports: Action 1 reaches the goal by 2 routes, Action 2 by 1. It does not say which is better.',
  },
  settingsSchema,
  defaultSettings: { listUnstatedLinks: true },
  settingsFields: [
    {
      key: 'listUnstatedLinks',
      label: 'List links this person has not been asked about',
      help: 'Shows which links in the shared map this person has not yet taken a view on.',
      type: 'boolean',
    },
  ],
  consumes: [ROLES.linkStance],
  elicitation: [],
  prepare(model, settings) {
    // Nothing to compute: this method only describes structure.
    const output = describeStructure(model, settings.listUnstatedLinks);
    return { program: null, finish: () => output };
  },
};

export function describeStructure(model: ParticipantModel, listUnstated: boolean): MethodOutput {
  const diagnostics: Diagnostic[] = [];
  const goal = model.goalId;
  if (!goal) {
    return {
      status: 'not-applicable',
      headline: 'No goal has been chosen yet.',
      actions: [],
      diagnostics: [{ severity: 'blocker', code: 'no-goal', message: 'Choose a goal before looking at actions.' }],
      bottlenecks: [],
    };
  }
  const influence = heldLinks(model, 'influence');
  const requirement = heldLinks(model, 'requirement');
  const out = outgoing(influence);
  const toGoal = ancestors(goal, incoming(influence));
  const actions = model.nodes.filter((n) => n.kind === 'action');
  const results: ActionResult[] = [];

  for (const a of actions) {
    const reach = descendants(a.id, out);
    if (!reach.has(goal)) {
      results.push(blank(a.id, 'not-connected', ['No route from this action to the goal in this person’s model.']));
      continue;
    }
    const via = new Set([...reach].filter((n) => toGoal.has(n)));
    const inside = influence.filter((l) => via.has(l.from) && via.has(l.to));
    const loop = topoOrder(via, inside) === null;
    const routes = loop ? { count: 0, capped: false } : countRoutes(a.id, goal, via, inside);
    const required = [...new Set(requirement.filter((r) => via.has(r.to)).map((r) => r.from))];
    results.push({
      actionId: a.id,
      status: 'described',
      reasons: loop ? ['The links on the way to the goal form a loop.'] : [],
      missingLinkIds: [],
      routeCount: routes.count,
      routesCapped: routes.capped,
      viaNodeIds: [...via].filter((n) => n !== a.id),
      requiredNodeIds: required,
      clearlyAheadOf: [],
    });
  }

  const unsure = model.links.filter((l) => l.stance === 'unsure');
  if (unsure.length)
    diagnostics.push({
      severity: 'info',
      code: 'unsure-links',
      message: `Not sure about ${unsure.length} link${unsure.length === 1 ? '' : 's'}. These are left out of the routes above, not counted as "no".`,
      linkIds: unsure.map((l) => l.id),
    });
  const conditional = model.links.filter((l) => l.stance === 'conditional');
  if (conditional.length)
    diagnostics.push({
      severity: 'info',
      code: 'conditional-links',
      message: `${conditional.length} link${conditional.length === 1 ? '' : 's'} marked as holding only under some conditions. They are shown on the map but not followed when tracing routes.`,
      linkIds: conditional.map((l) => l.id),
    });
  const unstated = model.links.filter((l) => l.stance === 'unstated');
  if (listUnstated && unstated.length)
    diagnostics.push({
      severity: 'info',
      code: 'unstated-links',
      message: `${unstated.length} link${unstated.length === 1 ? '' : 's'} in the shared map this person has not given a view on.`,
      linkIds: unstated.map((l) => l.id),
    });
  const stale = model.links.filter((l) => l.stanceStale && l.stance !== 'unstated');
  if (stale.length)
    diagnostics.push({
      severity: 'warning',
      code: 'stale-stance',
      message: `${stale.length} answer${stale.length === 1 ? ' was' : 's were'} given before a definition changed and should be reviewed.`,
      linkIds: stale.map((l) => l.id),
    });
  if (actions.length === 0) diagnostics.push({ severity: 'info', code: 'no-actions', message: 'No actions have been proposed yet.' });

  const connected = results.filter((r) => r.status === 'described').length;
  return {
    status: 'no-numbers',
    headline:
      actions.length === 0
        ? 'No actions yet.'
        : `${connected} of ${actions.length} action${actions.length === 1 ? '' : 's'} connect to the goal in this person’s model. No ranking is given.`,
    actions: results,
    diagnostics,
    bottlenecks: findBottlenecks(model),
  };
}

export function blank(actionId: string, status: ActionResult['status'], reasons: string[]): ActionResult {
  return { actionId, status, reasons, missingLinkIds: [], routeCount: 0, routesCapped: false, viaNodeIds: [], requiredNodeIds: [], clearlyAheadOf: [] };
}
