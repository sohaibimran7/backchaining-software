import { questionId } from '../../shared/templates';
import type { Role, WorkshopView } from '../../shared/types';
import { WorkshopService } from '../../server/service';
import { createSquiggleEngine } from '../../server/squiggleEngine';
import { MemoryStore, type Store } from '../../server/store';

/** The real formula engine: tests exercise the same path the app does. */
export const ENGINE = createSquiggleEngine();

export const FAC: Role = { type: 'facilitator' };

export function setup(store: Store = new MemoryStore()) {
  let tick = 0;
  const service = new WorkshopService(store, () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(), ENGINE);
  const created = service.create({ title: 'Test workshop' });
  const id = created.workshopId;
  const fac = (cmd: Record<string, unknown>) => service.command(id, FAC, cmd);
  /** Run a calculation (asynchronous: the arithmetic is done by the formula engine). */
  const calc = (cmd: Record<string, unknown>, role: Role = FAC) => service.runCalculation(id, role, { type: 'run_calculation', ...cmd });
  const as = (pid: string) => (cmd: Record<string, unknown>) => service.command(id, { type: 'participant', id: pid }, cmd);
  const view = (role: Role = FAC): WorkshopView => service.view(id, role);
  const join = (name: string) => service.join(created.joinCode, name);
  const node = (label: string) => Object.values(view().nodes).find((n) => n.label === label)!;
  return { service, store, created, id, fac, calc, as, view, join, node };
}

/** A workshop taken up to: goal chosen, two states, two actions, five proposed links, two participants. */
export function seeded() {
  const t = setup();
  const alex = t.join('Alex').participantId;
  const sam = t.join('Sam').participantId;
  const add = (kind: string, label: string) => {
    t.fac({ type: 'add_node', kind, label });
    return t.node(label).id;
  };
  const G = add('goal', 'Goal');
  t.fac({ type: 'select_goal', nodeId: G, successDefinition: 'done', horizon: '2030' });
  const S1 = add('state', 'S1');
  const S2 = add('state', 'S2');
  const A1 = add('action', 'A1');
  const A2 = add('action', 'A2');
  const pairs: [string, string][] = [
    [A1, S1],
    [A2, S2],
    [S1, S2],
    [S1, G],
    [S2, G],
  ];
  for (const [from, to] of pairs)
    t.fac({ type: 'add_link', from, to, relation: 'influence' });
  const stanceQ = (from: string, to: string, relation: 'influence' | 'requirement' = 'influence') =>
    questionId(relation === 'influence' ? 'influence-stance' : 'requirement-stance', { type: 'link', linkId: `l:${relation === 'influence' ? 'i' : 'r'}:${from}>${to}` });
  return { ...t, alex, sam, G, S1, S2, A1, A2, stanceQ };
}
