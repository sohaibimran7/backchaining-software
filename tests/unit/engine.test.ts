/** The formula engine runs off the main thread and is really terminated when it overruns. */
import { afterAll, describe, expect, it } from 'vitest';
import type { FormulaProgram } from '../../shared/calc/types';
import { createSquiggleEngine } from '../../server/squiggleEngine';

const program = (code: string, outputs: string[] = []): FormulaProgram => ({ language: 'squiggle', code, sources: {}, outputs });
// Deliberately heavy: far more work than any generated model needs.
const RUNAWAY = 'f(n) = List.reduce(List.upTo(1, 4000), 0, {|a, b| a + List.reduce(List.upTo(1, 4000), 0, {|c, d| c + d + n})})\nx = f(1) + f(2) + f(3) + f(4) + f(5) + f(6) + f(7) + f(8)\n{x: x}';

describe('formula engine isolation', () => {
  const engine = createSquiggleEngine({ timeLimitMs: 400 });
  afterAll(() => engine.close());

  it('evaluates off the main thread and returns named numbers', async () => {
    const r = await engine.evaluate(program('a = 2 * 3\n{a: a}', ['a']));
    expect(r).toEqual({ ok: true, values: { a: 6 } });
    expect(await engine.evaluate(program('{a: 1}', ['a', 'b']))).toMatchObject({ ok: false });
    expect(await engine.evaluate(program('x = '))).toMatchObject({ ok: false });
  });

  it('terminates a calculation that overruns, keeps the server responsive meanwhile, and recovers', async () => {
    // If evaluation blocked this thread, the ticker could not fire while it runs.
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const started = Date.now();
    const r = await engine.evaluate(program(RUNAWAY, ['x']));
    const elapsed = Date.now() - started;
    clearInterval(ticker);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/was stopped/);
    expect(elapsed).toBeLessThan(3000); // stopped near the limit, not after the work finished
    expect(ticks).toBeGreaterThan(5); // the main thread kept running throughout

    // The terminated thread is replaced; the next calculation is unaffected.
    expect(await engine.evaluate(program('{a: 1 + 1}', ['a']))).toEqual({ ok: true, values: { a: 2 } });
  });

  it('keeps concurrent requests apart', async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => engine.evaluate(program(`{a: ${n} * 10}`, ['a']))));
    expect(results.map((r) => (r.ok ? r.values.a : null))).toEqual([10, 20, 30, 40]);
  });
});
