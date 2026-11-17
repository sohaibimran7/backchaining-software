/**
 * Squiggle as the formula engine. It evaluates formulas the app generated and
 * hands back plain numbers. It is not the database, it does not see people or
 * permissions, and it does not make any causal assumption true.
 *
 * Evaluation happens in a worker thread, so a large or runaway calculation
 * cannot freeze live workshops. A calculation that exceeds its time or memory
 * limit is really terminated (the thread is killed and replaced).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EngineResult, FormulaEngine, FormulaProgram } from '../shared/calc/types';

export interface SquiggleEngineOptions {
  /** Longest one evaluation may take before its thread is terminated. */
  timeLimitMs?: number;
  /** Memory ceiling for the evaluation thread. */
  memoryLimitMb?: number;
  maxCodeLength?: number;
}

function installedVersion(): string {
  try {
    // The package does not export its package.json, so find it next to the resolved entry point.
    let dir = path.dirname(createRequire(import.meta.url).resolve('@quri/squiggle-lang'));
    for (let i = 0; i < 6; i++) {
      const file = path.join(dir, 'package.json');
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === '@quri/squiggle-lang' && pkg.version) return pkg.version;
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* fall through */
  }
  return 'unknown';
}

type Reply = { id: number; ok: true; values: Record<string, number> } | { id: number; ok: false; error: string };

export function createSquiggleEngine(options: SquiggleEngineOptions = {}): FormulaEngine & { close(): Promise<void> } {
  const timeLimitMs = options.timeLimitMs ?? 15_000;
  const memoryLimitMb = options.memoryLimitMb ?? 512;
  const maxCodeLength = options.maxCodeLength ?? 4_000_000;
  let worker: Worker | null = null;
  let nextId = 1;
  // One evaluation at a time: results can never be attributed to the wrong request.
  let queue: Promise<unknown> = Promise.resolve();

  const start = (): Worker => {
    const w = new Worker(new URL('./squiggleWorker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb }, execArgv: [] });
    w.unref(); // an idle engine must not keep the process alive
    return w;
  };

  const evaluateNow = (program: FormulaProgram): Promise<EngineResult> =>
    new Promise((resolve) => {
      const w = (worker ??= start());
      const id = nextId++;
      let settled = false;
      const finish = (result: EngineResult, kill: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        w.off('message', onMessage);
        w.off('error', onError);
        w.off('exit', onExit);
        if (kill) {
          // Actually stop the work: terminate the thread and start a fresh one next time.
          worker = null;
          void w.terminate();
        }
        resolve(result);
      };
      const onMessage = (reply: Reply) => {
        if (reply.id !== id) return;
        if (!reply.ok) return finish({ ok: false, error: reply.error }, false);
        const missing = program.outputs.filter((o) => !(o in reply.values));
        finish(missing.length ? { ok: false, error: `The formulas did not produce: ${missing.slice(0, 5).join(', ')}` } : { ok: true, values: reply.values }, false);
      };
      const onError = (err: Error) => finish({ ok: false, error: /memory/i.test(err.message) ? 'The calculation needed too much memory and was stopped.' : err.message || 'The calculation engine failed.' }, true);
      const onExit = () => finish({ ok: false, error: 'The calculation engine stopped unexpectedly.' }, true);
      const timer = setTimeout(() => finish({ ok: false, error: `The calculation took longer than ${Math.round(timeLimitMs / 1000)} seconds and was stopped.` }, true), timeLimitMs);
      w.on('message', onMessage);
      w.on('error', onError);
      w.on('exit', onExit);
      w.postMessage({ id, code: program.code });
    });

  return {
    id: 'squiggle',
    version: installedVersion(),
    // The formulas this app generates are exact arithmetic on numbers: nothing is sampled.
    sampling: null,
    evaluate(program: FormulaProgram): Promise<EngineResult> {
      if (program.language !== 'squiggle') return Promise.resolve({ ok: false, error: `This engine cannot evaluate ${program.language}.` });
      if (program.code.length > maxCodeLength) return Promise.resolve({ ok: false, error: 'The model is too large to calculate in one go.' });
      const result = queue.then(() => evaluateNow(program));
      queue = result.catch(() => undefined);
      return result;
    },
    async close() {
      const w = worker;
      worker = null;
      if (w) await w.terminate();
    },
  };
}
