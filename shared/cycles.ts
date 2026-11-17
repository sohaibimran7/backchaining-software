/**
 * Loop detection. Version one of the app refuses every directed loop,
 * including an item linked to itself, wherever arrows come from: a gesture,
 * an answer, a merge, an import, or combining two people's maps.
 */
export interface Arrow {
  from: string;
  to: string;
}

/**
 * If adding `extra` to `arrows` would close a loop, returns the loop as a list
 * of node ids starting and ending at the same node; otherwise null.
 */
export function loopIfAdded(arrows: Arrow[], extra: Arrow): string[] | null {
  if (extra.from === extra.to) return [extra.from, extra.to];
  // A loop appears exactly when the new arrow's target can already reach its source.
  const out = new Map<string, string[]>();
  for (const a of arrows) {
    const list = out.get(a.from);
    if (list) list.push(a.to);
    else out.set(a.from, [a.to]);
  }
  const cameFrom = new Map<string, string>();
  const queue = [extra.to];
  const seen = new Set(queue);
  while (queue.length) {
    const n = queue.shift()!;
    if (n === extra.from) {
      const path = [n];
      let cur = n;
      while (cur !== extra.to) {
        cur = cameFrom.get(cur)!;
        path.unshift(cur);
      }
      return [extra.from, ...path]; // from → to → … → from
    }
    for (const next of out.get(n) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        cameFrom.set(next, n);
        queue.push(next);
      }
    }
  }
  return null;
}

/** Any loop in a set of arrows, or null if there is none. */
export function findLoop(arrows: Arrow[]): string[] | null {
  const kept: Arrow[] = [];
  for (const a of arrows) {
    const loop = loopIfAdded(kept, a);
    if (loop) return loop;
    kept.push(a);
  }
  return null;
}

export function describeLoop(loop: string[], label: (id: string) => string): string {
  return loop.map((id) => `“${label(id)}”`).join(' → ');
}
