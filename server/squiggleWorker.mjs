/**
 * Runs Squiggle off the server's main thread. Plain JavaScript on purpose, so
 * it loads the same way in development, tests and the production build.
 * One message in ({ id, code }) → one message out ({ id, ok, values | error }).
 */
import { parentPort } from 'node:worker_threads';
import { run } from '@quri/squiggle-lang';

parentPort.on('message', async ({ id, code }) => {
  try {
    const output = await run(code);
    const end = output.getEndResult();
    if (!end.ok) return parentPort.postMessage({ id, ok: false, error: String(end.value) });
    const value = end.value;
    if (value.tag !== 'Dict') return parentPort.postMessage({ id, ok: false, error: 'The formulas did not produce a table of results.' });
    const values = {};
    for (const [name, item] of value.value.entries()) {
      if (item.tag === 'Number' && typeof item.value === 'number') values[name] = item.value;
    }
    parentPort.postMessage({ id, ok: true, values });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: (err && err.message) || 'The calculation engine failed.' });
  }
});
