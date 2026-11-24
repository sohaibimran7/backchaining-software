/** Saving a copy to a private GitHub repository: check first, create only if missing, never write to a public one. */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/app';
import { createGithubBackup } from '../../server/githubBackup';
import { WorkshopService } from '../../server/service';
import { MemoryStore } from '../../server/store';
import { FAC, seeded } from './helpers';

/** A tiny stand-in for the GitHub API that records what was asked of it. */
function fakeGithub(start: { repo?: { private: boolean }; files?: Record<string, string> } = {}) {
  const state = { repo: start.repo as { private: boolean } | undefined, files: { ...(start.files ?? {}) } as Record<string, string>, calls: [] as string[], created: 0 };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://api.github.com', '');
    const method = init?.method ?? 'GET';
    state.calls.push(`${method} ${path}`);
    if ((init?.headers as Record<string, string>).authorization !== 'Bearer test-token') return json(401, {});
    if (path === '/user') return json(200, { login: 'someone' });
    if (path === '/user/repos' && method === 'POST') {
      const body = JSON.parse(String(init!.body));
      state.repo = { private: body.private };
      state.created += 1;
      return json(201, { private: body.private, html_url: 'https://github.com/someone/backchaining-models' });
    }
    if (path === '/repos/someone/backchaining-models') return state.repo ? json(200, { private: state.repo.private, html_url: 'https://github.com/someone/backchaining-models' }) : json(404, {});
    const m = /^\/repos\/someone\/backchaining-models\/contents\/(.+)$/.exec(path);
    if (m) {
      const file = decodeURIComponent(m[1]!);
      if (method === 'GET') {
        if (file === 'workshops') {
          const names = Object.keys(state.files).filter((f) => f.startsWith('workshops/'));
          return names.length ? json(200, names.map((f) => ({ name: f.slice('workshops/'.length) }))) : json(404, {});
        }
        return file in state.files ? json(200, { sha: `sha-of-${file}` }) : json(404, {});
      }
      if (method === 'PUT') {
        const body = JSON.parse(String(init!.body));
        if (file in state.files && body.sha !== `sha-of-${file}`) return json(409, { message: 'sha required' });
        state.files[file] = Buffer.from(body.content, 'base64').toString('utf8');
        return json(file in state.files ? 200 : 201, {});
      }
    }
    return json(404, {});
  }) as typeof fetch;
  return { state, backup: createGithubBackup({ token: () => 'test-token', fetchImpl }) };
}

describe('saving a copy to GitHub', () => {
  it('looks first, creates a private repository only when there is none, and explains itself in a README', async () => {
    const t = seeded();
    const file = t.service.exportData(t.id, FAC);
    const { state, backup } = fakeGithub();
    expect(await backup.status()).toMatchObject({ available: true, login: 'someone', repo: 'backchaining-models', exists: false });
    expect(state.created).toBe(0); // looking does not create anything

    const first = await backup.save(file, t.id);
    expect(first).toMatchObject({ created: true, path: `workshops/test-workshop--${t.id}.json` });
    expect(state.repo).toEqual({ private: true });
    expect(state.calls.indexOf('GET /repos/someone/backchaining-models')).toBeLessThan(state.calls.indexOf('POST /user/repos')); // checked before creating
    expect(state.files['README.md']).toMatch(/do not rename this repository/i);
    expect(state.files['README.md']).toMatch(/keep it private/i);
    expect(JSON.parse(state.files[first.path]!)).toEqual(JSON.parse(JSON.stringify(file)));
    expect(await backup.status()).toMatchObject({ available: true, exists: true, isPrivate: true });

    // Saving again reuses the repository and replaces the same file — even after the workshop is renamed.
    t.fac({ type: 'set_title', title: 'A new name' });
    const second = await backup.save(t.service.exportData(t.id, FAC), t.id);
    expect(second).toMatchObject({ created: false, path: first.path });
    expect(state.created).toBe(1);
    expect(Object.keys(state.files).sort()).toEqual(['README.md', first.path].sort());
    expect(JSON.parse(state.files[first.path]!).title).toBe('A new name');
  });

  it('refuses to save anything to a repository of that name that is public', async () => {
    const t = seeded();
    const { state, backup } = fakeGithub({ repo: { private: false } });
    const status = await backup.status();
    expect(status.available).toBe(false);
    expect(status.reason).toMatch(/public/);
    await expect(backup.save(t.service.exportData(t.id, FAC), t.id)).rejects.toThrow(/is public, so nothing was saved/);
    expect(state.files).toEqual({});
    expect(state.created).toBe(0);
  });

  it('says plainly when nobody is signed in, and never exposes the token', async () => {
    const none = createGithubBackup({ token: () => null });
    expect(await none.status()).toMatchObject({ available: false, reason: expect.stringMatching(/Nobody is signed in/) });
    const { backup } = fakeGithub();
    expect(JSON.stringify(await backup.status())).not.toContain('test-token');
  });

  it('is offered only to the organizer, and by default only on the computer the server runs on', async () => {
    const service = new WorkshopService(new MemoryStore());
    const created = service.create({ title: 'Mine' });
    const joined = service.join(created.joinCode, 'Alex');
    const { state, backup } = fakeGithub();
    let from = '127.0.0.1';
    const app = createApp(service, { port: 0, githubBackup: backup, clientAddress: () => from });
    const url = `/api/workshops/${created.workshopId}/backup/github`;
    const as = (key: string) => ({ authorization: `Bearer ${key}`, 'content-type': 'application/json' });

    expect((await app.request(url, { headers: as(joined.participantKey) })).status).toBe(403);
    expect((await app.request(url, { method: 'POST', body: '{}', headers: as(joined.participantKey) })).status).toBe(403);
    expect(await (await app.request(url, { headers: as(created.facilitatorKey) })).json()).toMatchObject({ available: true, exists: false });
    expect((await app.request(url, { method: 'POST', body: '{}', headers: as(created.facilitatorKey) })).status).toBe(200);
    expect(Object.keys(state.files).length).toBe(2);

    // An organizer on another device does not push to the server owner's GitHub unless that is switched on.
    from = '192.168.1.50';
    expect(await (await app.request(url, { headers: as(created.facilitatorKey) })).json()).toMatchObject({ available: false, reason: expect.stringMatching(/only offered on the computer/) });
    expect((await app.request(url, { method: 'POST', body: '{}', headers: as(created.facilitatorKey) })).status).toBe(403);
    const open = createApp(service, { port: 0, githubBackup: backup, githubBackupAccess: 'on', clientAddress: () => from });
    expect((await open.request(url, { method: 'POST', body: '{}', headers: as(created.facilitatorKey) })).status).toBe(200);
    const off = createApp(service, { port: 0, githubBackup: backup, githubBackupAccess: 'off', clientAddress: () => '127.0.0.1' });
    expect(await (await off.request(url, { headers: as(created.facilitatorKey) })).json()).toMatchObject({ available: false });
  });
});
