/**
 * The optional demonstration workshop. Clearly fictional: two actions, two
 * states and a goal (A1 → S1, A2 → S2, S1 → S2, S1 → G, S2 → G), with two
 * example people who disagree about the structure.
 */
import type { ClientCommand } from './commands';
import { ROLES } from './config';
import { knownTemplates, linkId, matchesFilter, questionId } from './templates';
import type { Actor, WorkshopState } from './types';

type Run = (actor: Actor, cmd: ClientCommand) => WorkshopState;

export const EXAMPLE_PARTICIPANTS = [
  { id: 'example-1', name: 'Example person 1' },
  { id: 'example-2', name: 'Example person 2' },
];

export function seedExample(run: Run): void {
  const fac: Actor = { type: 'facilitator' };
  const add = (kind: 'goal' | 'state' | 'action', label: string, definition: string): string => {
    const state = run(fac, { type: 'add_node', kind, label, definition });
    return Object.values(state.nodes).find((n) => n.label === label)!.id;
  };
  const G = add('goal', 'G (example goal)', 'A made-up goal for demonstration only.');
  run(fac, { type: 'select_goal', nodeId: G, successDefinition: 'The example goal is reached.', horizon: 'the end of next year' });
  const S1 = add('state', 'S1 (example state)', 'A made-up state of the world.');
  const S2 = add('state', 'S2 (example state)', 'Another made-up state of the world.');
  const A1 = add('action', 'A1 (example action)', 'A made-up action people in the room could take.');
  const A2 = add('action', 'A2 (example action)', 'Another made-up action.');
  const pairs: [string, string][] = [
    [A1, S1],
    [A2, S2],
    [S1, S2],
    [S1, G],
    [S2, G],
  ];
  let state = run(fac, { type: 'set_stage', stageId: 'estimates' });
  for (const [from, to] of pairs) state = run(fac, { type: 'add_link', from, to, relation: 'influence' });

  const ask = (participantId: string, role: string, link: string, value: ClientCommand & { type: 'answer' } extends { value: infer V } ? V : never, reasoning?: string) => {
    const subject = { type: 'link' as const, linkId: link };
    const t = knownTemplates(state.config).find((x) => x.role === role && matchesFilter(state, x.subject, subject) && state.questions[questionId(x.id, subject)]);
    if (!t) return;
    state = run(fac, { type: 'answer', questionId: questionId(t.id, subject), participantId, value, reasoning, via: 'question' });
  };
  /** How many percentage points `from` changes the chance of `to` (as a fraction). */
  const change = (pid: string, from: string, to: string, d: number) => ask(pid, ROLES.directChange, linkId('influence', from, to), { kind: 'difference', d });

  const [p1, p2] = EXAMPLE_PARTICIPANTS.map((p) => p.id) as [string, string];
  // Person 1 includes all five links and gives estimates for each.
  for (const [from, to] of pairs) ask(p1, ROLES.linkStance, linkId('influence', from, to), { kind: 'choice', choice: 'yes' });
  change(p1, A1, S1, 0.5);
  change(p1, A2, S2, 0.3);
  change(p1, S1, S2, 0.15);
  change(p1, S1, G, 0.2);
  change(p1, S2, G, 0.15);

  // Person 2 disagrees about the structure: rejects S1 → S2, is unsure about one estimate, and says S2 is required for G.
  ask(p2, ROLES.linkStance, linkId('influence', A1, S1), { kind: 'choice', choice: 'yes' });
  ask(p2, ROLES.linkStance, linkId('influence', A2, S2), { kind: 'choice', choice: 'yes' });
  ask(p2, ROLES.linkStance, linkId('influence', S1, S2), { kind: 'choice', choice: 'no' }, 'I do not see how S1 would change S2.');
  ask(p2, ROLES.linkStance, linkId('influence', S1, G), { kind: 'choice', choice: 'yes' });
  ask(p2, ROLES.linkStance, linkId('influence', S2, G), { kind: 'choice', choice: 'yes' });
  change(p2, A1, S1, 0.25);
  change(p2, S1, G, 0.4);
  change(p2, A2, S2, 0.5);
  ask(p2, ROLES.directChange, linkId('influence', S2, G), { kind: 'unsure' });
  state = run(fac, { type: 'add_link', from: S2, to: G, relation: 'requirement' });
  ask(p2, ROLES.linkStance, linkId('requirement', S2, G), { kind: 'choice', choice: 'yes' }, 'Without S2 I do not think G can happen.');
  ask(p1, ROLES.linkStance, linkId('requirement', S2, G), { kind: 'choice', choice: 'no' });
}

/**
 * A larger made-up map for trying out arrow drawing: one goal, three things
 * that feed it, four under each of those and three under each of those —
 * 52 items, and deliberately no arrows.
 */
export function seedUnconnected(run: Run): void {
  const fac: Actor = { type: 'facilitator' };
  const add = (kind: 'goal' | 'state', label: string, elicitedFor?: string): string => {
    const state = run(fac, { type: 'add_node', kind, label, definition: 'Made-up item for demonstration.', elicitedFor });
    return Object.values(state.nodes).find((n) => n.label === label)!.id;
  };
  const goal = add('goal', 'Demo goal');
  run(fac, { type: 'select_goal', nodeId: goal, successDefinition: 'The demo goal is reached.', horizon: 'five years from now' });
  for (let a = 1; a <= 3; a++) {
    const first = add('state', `Demo state ${a}`, goal);
    for (let b = 1; b <= 4; b++) {
      const second = add('state', `Demo state ${a}.${b}`, first);
      for (let c = 1; c <= 3; c++) add('state', `Demo state ${a}.${b}.${c}`, second);
    }
  }
  run(fac, { type: 'set_stage', stageId: 'connections' });
}
