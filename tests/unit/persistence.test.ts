import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportFileSchema } from '../../shared/commands';
import { buildParticipantModel } from '../../shared/model';
import { getMethod } from '../../shared/calc/registry';
import { createApp } from '../../server/app';
import { WorkshopService } from '../../server/service';
import { MemoryStore, SqliteStore } from '../../server/store';
import { ENGINE, FAC, seeded, setup } from './helpers';

const dirs: string[] = [];
function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backchain-test-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'workshops.sqlite');
}
afterEach(() => {
  // Leave temp folders for the OS to clean; nothing here deletes recursively.
  dirs.length = 0;
});

describe('persistence', () => {
  it('survives a server restart: same state, same keys, same answers', () => {
    const file = tempDb();
    const store = new SqliteStore(file);
    const s1 = setup(store);
    const alex = s1.join('Alex');
    s1.fac({ type: 'add_node', kind: 'goal', label: 'Goal' });
    const G = s1.node('Goal').id;
    s1.fac({ type: 'select_goal', nodeId: G, successDefinition: 'done', horizon: '2030' });
    const q = `q:success-definition:${G}`;
    s1.fac({ type: 'publish_question', questionId: q });
    s1.as(alex.participantId)({ type: 'answer', questionId: q, value: { kind: 'text', text: 'We would see it in the numbers' } });
    const before = s1.view();
    store.close();

    const store2 = new SqliteStore(file);
    const service2 = new WorkshopService(store2);
    const after = service2.view(s1.id, FAC);
    expect(after).toEqual(before);
    expect(service2.authenticate(s1.id, alex.participantKey)).toEqual({ type: 'participant', id: alex.participantId });
    expect(service2.authenticate(s1.id, s1.created.facilitatorKey)).toEqual({ type: 'facilitator' });
    expect(service2.lookupCode(s1.created.joinCode)).toEqual({ workshopId: s1.id, title: 'Test workshop' });
    // …and keeps working.
    service2.command(s1.id, { type: 'participant', id: alex.participantId }, { type: 'answer', questionId: q, value: { kind: 'unsure' } });
    expect(service2.view(s1.id, FAC).answers[q]![alex.participantId]!.length).toBe(2);
    store2.close();
  });

  it('exports, re-imports as a separate workshop, and copies an earlier revision', () => {
    const t = seeded();
    const q = t.stanceQ(t.S1, t.G);
    t.fac({ type: 'publish_question', questionId: q });
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'yes' } });
    const seqBefore = t.view().seq;
    t.as(t.alex)({ type: 'answer', questionId: q, value: { kind: 'choice', choice: 'no' } });

    const file = JSON.parse(JSON.stringify(t.service.exportData(t.id, FAC)));
    expect(exportFileSchema.safeParse(file).success).toBe(true);
    expect(() => t.service.exportData(t.id, { type: 'participant', id: t.alex })).toThrow(/Only the facilitator/);

    const imported = t.service.importData(file);
    expect(imported.workshopId).not.toBe(t.id);
    expect(imported.facilitatorKey).not.toBe(t.created.facilitatorKey);
    const copy = t.service.view(imported.workshopId, FAC);
    expect(copy.nodes).toEqual(t.view().nodes);
    expect(copy.answers).toEqual(t.view().answers);
    expect(buildParticipantModel(copy, t.alex)).toEqual(buildParticipantModel(t.view(), t.alex));
    // Old keys do not open the copy.
    expect(t.service.authenticate(imported.workshopId, t.created.facilitatorKey)).toBeNull();

    const fork = t.service.fork(t.id, FAC, seqBefore);
    const earlier = t.service.view(fork.workshopId, FAC);
    expect(earlier.answers[q]![t.alex]!.length).toBe(1);
    expect(earlier.title).toContain('copy at revision');
    expect(t.view().answers[q]![t.alex]!.length).toBe(2); // original untouched

    // The revision history is there and content-free about answers.
    const summaries = t.view().history.map((h) => h.summary).join('\n');
    expect(summaries).toContain('Alex answered');
    expect(summaries).not.toContain('"yes"');
  });

  it('refuses tampered or malformed import files', () => {
    const t = seeded();
    const file = JSON.parse(JSON.stringify(t.service.exportData(t.id, FAC)));
    expect(() => t.service.importData({ ...file, format: 'something-else' })).toThrow(/not a workshop export/);
    expect(() => t.service.importData({ ...file, events: file.events.slice(1) })).toThrow(/does not start/);
    const tampered = structuredClone(file);
    tampered.events.push({ seq: 999, at: 'x', actor: { type: 'participant', id: 'ghost' }, cmd: { type: 'set_title', title: 'pwned' } });
    expect(() => t.service.importData(tampered)).toThrow(/could not be replayed/);
    const evil = structuredClone(file);
    evil.events[0].cmd.config.calculation.methodId = 'eval-me';
    expect(() => t.service.importData(evil)).toThrow(/does not have/);
  });

  it('the example workshop is labelled, self-contained and exercises both methods', async () => {
    const service = new WorkshopService(new MemoryStore(), undefined, ENGINE);
    const { workshopId } = service.create({ title: 'Example workshop (fictional)', example: true });
    const v = service.view(workshopId, FAC);
    expect(v.isExample).toBe(true);
    expect(Object.values(v.nodes).map((n) => n.label).sort()).toEqual(['A1 (example action)', 'A2 (example action)', 'G (example goal)', 'S1 (example state)', 'S2 (example state)']);
    expect(Object.values(v.links).filter((l) => l.relation === 'influence').length).toBe(5);
    await service.runCalculation(workshopId, FAC, { type: 'run_calculation', methodId: 'local-additive', acknowledged: true });
    const run = service.view(workshopId, FAC).runs[0]!;
    const one = run.outputs['example-1']!;
    const two = run.outputs['example-2']!;
    const label = (id: string) => v.nodes[id]!.label.slice(0, 2);
    const byLabel = (out: typeof one) => Object.fromEntries(out.actions.map((a) => [label(a.actionId), a]));
    expect(byLabel(one).A1!.effect!.low).toBeCloseTo(0.11125, 10);
    expect(byLabel(one).A2!.effect!.low).toBeCloseTo(0.045, 10);
    // Person 2 says S2 is required for G: numbers are withheld for them, not guessed.
    expect(byLabel(two).A1!.status).toBe('withheld');
    expect(byLabel(two).A2!.status).toBe('withheld');
    expect(getMethod(run.methodId)!.version).toBe(run.methodVersion);
    // The run records which engine did the arithmetic, the formulas it was given, and where each name came from.
    expect(run.engine).toMatchObject({ id: 'squiggle', version: '0.10.0', sampling: null });
    expect(run.programs!['example-1']!.code).toContain('Number.min');
    expect(Object.values(run.programs!['example-1']!.sources).some((s) => s.kind === 'link' && !!s.questionId)).toBe(true);
    expect(run.programs!['example-2']).toBeUndefined(); // nothing was calculable for person 2, so nothing was sent to the engine
  });
});

describe('HTTP API', () => {
  const make = (opts: Partial<Parameters<typeof createApp>[1]> = {}) => {
    const service = new WorkshopService(new MemoryStore());
    const app = createApp(service, { port: 0, ...opts });
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
      app.request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });
    return { service, app, post };
  };

  it('creates, joins, and enforces keys on every workshop route', async () => {
    const { app, post } = make();
    const created = (await (await post('/api/workshops', { title: 'HTTP test' })).json()) as { workshopId: string; joinCode: string; facilitatorKey: string };
    expect(created.joinCode).toMatch(/^[A-Z0-9]{6}$/);
    expect((await app.request(`/api/join/${created.joinCode.toLowerCase()}`)).status).toBe(200);
    expect((await app.request('/api/join/NOPE00')).status).toBe(404);
    const joined = (await (await post('/api/join', { code: created.joinCode, name: 'Alex' })).json()) as { participantId: string; participantKey: string };

    const base = `/api/workshops/${created.workshopId}`;
    expect((await app.request(`${base}/view`)).status).toBe(403);
    expect((await app.request(`${base}/view`, { headers: { authorization: 'Bearer nope' } })).status).toBe(403);
    const asFac = { authorization: `Bearer ${created.facilitatorKey}` };
    const asAlex = { authorization: `Bearer ${joined.participantKey}` };
    const view = (await (await app.request(`${base}/view`, { headers: asAlex })).json()) as { role: unknown };
    expect(view.role).toEqual({ type: 'participant', id: joined.participantId });

    expect((await post(`${base}/commands`, { type: 'set_title', title: 'Hijack' }, asAlex)).status).toBe(403);
    expect((await post(`${base}/commands`, { type: 'set_title', title: 'Renamed' }, asFac)).status).toBe(200);
    expect((await post(`${base}/commands`, { type: 'nope' }, asFac)).status).toBe(400);
    expect((await app.request(`${base}/export`, { headers: asAlex })).status).toBe(403);
    expect((await app.request(`${base}/export`, { headers: asFac })).status).toBe(200);
    expect((await post(`${base}/participants/${joined.participantId}/key`, {}, asAlex)).status).toBe(403);
    expect((await app.request('/api/workshops/does-not-exist/view', { headers: asFac })).status).toBe(403);
    // The facilitator key never appears in what a participant can fetch.
    expect(JSON.stringify(view)).not.toContain(created.facilitatorKey);
  });

  it('rate-limits code guessing by default', async () => {
    const { app } = make();
    const statuses: number[] = [];
    for (let i = 0; i < 45; i++) statuses.push((await app.request('/api/join/NOPE00')).status);
    expect(statuses.slice(0, 40).every((x) => x === 404)).toBe(true);
    expect(statuses.slice(40).every((x) => x === 429)).toBe(true);
  });

  it('refuses cross-site requests and respects the create secret', async () => {
    const { post } = make({ createSecret: 'open sesame' });
    expect((await post('/api/workshops', { title: 'x' })).status).toBe(403);
    expect((await post('/api/workshops', { title: 'x', secret: 'open sesame' })).status).toBe(200);
    expect((await post('/api/workshops', { title: 'x', secret: 'open sesame' }, { origin: 'https://evil.example', host: 'workshop.example' })).status).toBe(403);
    expect((await post('/api/workshops', { title: 'x', secret: 'open sesame' }, { origin: 'https://workshop.example', host: 'workshop.example' })).status).toBe(200);
  });
});
