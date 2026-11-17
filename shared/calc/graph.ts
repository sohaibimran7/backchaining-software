/** Small graph helpers shared by calculation methods and the explorer. Pure functions over plain data. */
import type { Bottleneck, ModelLinkInput, ParticipantModel } from './types';

export type Adjacency = Map<string, ModelLinkInput[]>;

export function outgoing(links: ModelLinkInput[]): Adjacency {
  const m: Adjacency = new Map();
  for (const l of links) {
    const list = m.get(l.from);
    if (list) list.push(l);
    else m.set(l.from, [l]);
  }
  return m;
}

export function incoming(links: ModelLinkInput[]): Adjacency {
  const m: Adjacency = new Map();
  for (const l of links) {
    const list = m.get(l.to);
    if (list) list.push(l);
    else m.set(l.to, [l]);
  }
  return m;
}

/** Every node reachable from `start` following links forwards (start included). */
export function descendants(start: string, out: Adjacency): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of out.get(n) ?? []) {
      if (!seen.has(l.to)) {
        seen.add(l.to);
        stack.push(l.to);
      }
    }
  }
  return seen;
}

/** Every node that can reach `target` following links forwards (target included). */
export function ancestors(target: string, inc: Adjacency): Set<string> {
  const seen = new Set<string>([target]);
  const stack = [target];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of inc.get(n) ?? []) {
      if (!seen.has(l.from)) {
        seen.add(l.from);
        stack.push(l.from);
      }
    }
  }
  return seen;
}

/**
 * Topological order of `nodes` using only `links` among them.
 * Returns null if those links contain a loop.
 */
export function topoOrder(nodes: Set<string>, links: ModelLinkInput[]): string[] | null {
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n, 0);
  const inside = links.filter((l) => nodes.has(l.from) && nodes.has(l.to));
  for (const l of inside) indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);
  const out = outgoing(inside);
  const queue = [...nodes].filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const l of out.get(n) ?? []) {
      const d = (indeg.get(l.to) ?? 0) - 1;
      indeg.set(l.to, d);
      if (d === 0) queue.push(l.to);
    }
  }
  return order.length === nodes.size ? order : null;
}

export const ROUTE_CAP = 10_000;

/** Number of distinct routes from `from` to `to` over a loop-free set of links, capped at ROUTE_CAP. */
export function countRoutes(from: string, to: string, nodes: Set<string>, links: ModelLinkInput[]): { count: number; capped: boolean } {
  const order = topoOrder(nodes, links);
  if (!order) return { count: 0, capped: false };
  const inc = incoming(links.filter((l) => nodes.has(l.from) && nodes.has(l.to)));
  const ways = new Map<string, number>();
  let capped = false;
  for (const n of order) {
    if (n === from) {
      ways.set(n, 1);
      continue;
    }
    let total = 0;
    for (const l of inc.get(n) ?? []) total += ways.get(l.from) ?? 0;
    if (total > ROUTE_CAP) {
      total = ROUTE_CAP;
      capped = true;
    }
    ways.set(n, total);
  }
  return { count: ways.get(to) ?? 0, capped };
}

/** Links this participant holds (answered or proposed "yes"), by relation. */
export function heldLinks(model: ParticipantModel, relation: 'influence' | 'requirement'): ModelLinkInput[] {
  return model.links.filter((l) => l.relation === relation && l.stance === 'yes');
}

/**
 * Structural bottlenecks in one participant's model. No numbers involved.
 *  - required-without-action: a state they say is required on the way to the goal, with no action leading to it
 *  - required: a required state that at least one action does lead to
 *  - chokepoint: a state every action→goal route passes through
 */
export function findBottlenecks(model: ParticipantModel): Bottleneck[] {
  const goal = model.goalId;
  if (!goal) return [];
  const label = new Map(model.nodes.map((n) => [n.id, n.label]));
  const name = (id: string) => `“${label.get(id) ?? id}”`;
  const influence = heldLinks(model, 'influence');
  const requirement = heldLinks(model, 'requirement');
  const out = outgoing(influence);
  const towardGoal = ancestors(goal, incoming([...influence, ...requirement]));
  const actions = model.nodes.filter((n) => n.kind === 'action').map((n) => n.id);
  const reachedByAction = new Set<string>();
  for (const a of actions) for (const n of descendants(a, out)) reachedByAction.add(n);

  const result: Bottleneck[] = [];
  const seenRequired = new Set<string>();
  for (const r of requirement) {
    if (!towardGoal.has(r.to) || seenRequired.has(r.from)) continue;
    seenRequired.add(r.from);
    if (reachedByAction.has(r.from)) {
      result.push({ nodeId: r.from, kind: 'required', message: `${name(r.from)} is required for ${name(r.to)}.` });
    } else {
      result.push({
        nodeId: r.from,
        kind: 'required-without-action',
        message: `${name(r.from)} is required for ${name(r.to)}, and no action in this model leads to it.`,
      });
    }
  }

  // Chokepoints: remove a state; if no action can reach the goal any more, every route went through it.
  const goalAncestors = ancestors(goal, incoming(influence));
  const connectedActions = actions.filter((a) => descendants(a, out).has(goal));
  if (connectedActions.length > 0) {
    const candidates = model.nodes.filter((n) => n.kind === 'state' && goalAncestors.has(n.id) && reachedByAction.has(n.id));
    for (const c of candidates) {
      const without = outgoing(influence.filter((l) => l.from !== c.id && l.to !== c.id));
      const stillReaches = connectedActions.some((a) => descendants(a, without).has(goal));
      if (!stillReaches) {
        result.push({ nodeId: c.id, kind: 'chokepoint', message: `Every route from an action to the goal passes through ${name(c.id)}.` });
      }
    }
  }
  return result;
}
