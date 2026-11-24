/** HTTP API. Thin: parse, authenticate, call the service, map errors. */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import crypto from 'node:crypto';
import os from 'node:os';
import { CommandError, type Role } from '../shared/types';
import type { GithubBackup } from './githubBackup';
import type { WorkshopService } from './service';

export interface AppOptions {
  publicBaseUrl?: string;
  createSecret?: string;
  allowedOrigins?: string[];
  port: number;
  /** Saving copies to the server operator's private GitHub repository, if set up. */
  githubBackup?: GithubBackup;
  /**
   * Who may use it. 'local' (the default): only a browser on the same computer as the server, since the
   * copy goes to whoever is signed in to GitHub there. 'on': any organizer. 'off': nobody.
   */
  githubBackupAccess?: 'local' | 'on' | 'off';
  /** Multiplies every rate limit. 1 in production; raised only for automated test servers. */
  rateLimitScale?: number;
  /** Returns a caller address for rate limiting. */
  clientAddress?: (c: Context) => string;
}

const STATUS: Record<CommandError['code'], 400 | 403 | 404 | 409> = { invalid: 400, forbidden: 403, 'not-found': 404, conflict: 409 };

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) result.push(a.address);
  }
  return result;
}

/** Small fixed-window limiter: enough to stop code guessing and accidental floods. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return true;
    }
    h.count += 1;
    return h.count <= max;
  };
}

export function createApp(service: WorkshopService, options: AppOptions) {
  const app = new Hono();
  const address = (c: Context) => options.clientAddress?.(c) ?? 'unknown';
  const scale = options.rateLimitScale ?? 1;
  const joinLimit = limiter(40 * scale, 60_000);
  const createLimit = limiter(20 * scale, 60_000);
  const commandLimit = limiter(600 * scale, 60_000);

  app.onError((err, c) => {
    if (err instanceof CommandError) return c.json({ error: err.message, code: err.code }, STATUS[err.code]);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  });

  // Requests from a browser page on another site are refused. Keys travel in headers, never cookies.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && c.req.method !== 'GET') {
      const host = c.req.header('host');
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        /* malformed origin */
      }
      const allowed = originHost === host || (options.allowedOrigins ?? []).includes(origin) || (options.publicBaseUrl ? new URL(options.publicBaseUrl).origin === origin : false);
      if (!allowed) return c.json({ error: 'This request came from a site that is not allowed to use this server.' }, 403);
    }
    await next();
  });

  const small = bodyLimit({ maxSize: 512 * 1024 });
  const large = bodyLimit({ maxSize: 25 * 1024 * 1024 });

  const roleOf = (c: Context, workshopId: string): Role => {
    const header = c.req.header('authorization') ?? '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    const role = service.authenticate(workshopId, key);
    if (!role) throw new CommandError('forbidden', 'Your link for this workshop is not valid any more. Ask the facilitator for a new one.');
    return role;
  };

  const checkCreateSecret = (given: unknown) => {
    if (!options.createSecret) return;
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(options.createSecret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new CommandError('forbidden', 'Creating workshops on this server needs the access phrase.');
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/server-info', (c) =>
    c.json({
      publicBaseUrl: options.publicBaseUrl ?? null,
      lanAddresses: lanAddresses(),
      port: options.port,
      createNeedsSecret: !!options.createSecret,
    }),
  );

  app.post('/api/workshops', small, async (c) => {
    if (!createLimit(address(c))) return c.json({ error: 'Too many requests. Wait a minute and try again.' }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; example?: unknown; solo?: unknown; secret?: unknown };
    checkCreateSecret(body.secret);
    const example = body.example === true ? true : body.example === 'unconnected' ? 'unconnected' : undefined;
    const title = String(body.title ?? '').trim().slice(0, 120) || (example ? 'Example (fictional)' : body.solo === true ? 'My model' : 'Untitled workshop');
    return c.json(service.create({ title, example, solo: body.solo === true }));
  });

  app.post('/api/workshops/import', large, async (c) => {
    if (!createLimit(address(c))) return c.json({ error: 'Too many requests. Wait a minute and try again.' }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { data?: unknown; secret?: unknown };
    checkCreateSecret(body.secret);
    return c.json(service.importData(body.data, ' (imported)'));
  });

  app.get('/api/join/:code', (c) => {
    if (!joinLimit(address(c))) return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
    const found = service.lookupCode(c.req.param('code'));
    if (!found) return c.json({ error: 'No workshop has that code. Check it and try again.' }, 404);
    return c.json(found);
  });

  app.post('/api/join', small, async (c) => {
    if (!joinLimit(address(c))) return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
    return c.json(service.join(String(body.code ?? ''), String(body.name ?? '')));
  });

  app.get('/api/workshops/:id/view', (c) => {
    const id = c.req.param('id');
    return c.json(service.view(id, roleOf(c, id)));
  });

  app.post('/api/workshops/:id/commands', small, async (c) => {
    const id = c.req.param('id');
    const role = roleOf(c, id);
    if (!commandLimit(`${id}:${role.type === 'participant' ? role.id : 'f'}`)) return c.json({ error: 'Too many changes at once. Wait a moment.' }, 429);
    const body = (await c.req.json().catch(() => null)) as { type?: unknown } | null;
    if (body?.type === 'run_calculation') return c.json(await service.runCalculation(id, role, body));
    return c.json(service.command(id, role, body));
  });

  app.get('/api/workshops/:id/export', (c) => {
    const id = c.req.param('id');
    return c.json(service.exportData(id, roleOf(c, id)));
  });

  app.post('/api/workshops/:id/fork', small, async (c) => {
    const id = c.req.param('id');
    const role = roleOf(c, id);
    const body = (await c.req.json().catch(() => ({}))) as { seq?: unknown };
    const seq = Number(body.seq);
    if (!Number.isInteger(seq) || seq < 1) throw new CommandError('invalid', 'Choose a revision to copy from.');
    return c.json(service.fork(id, role, seq));
  });

  app.post('/api/workshops/:id/participants/:pid/key', small, (c) => {
    const id = c.req.param('id');
    return c.json({ participantKey: service.issueParticipantKey(id, roleOf(c, id), c.req.param('pid')) });
  });

  // — saving a copy to GitHub —
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  const githubAllowed = (c: Context): string | null => {
    const access = options.githubBackupAccess ?? 'local';
    if (!options.githubBackup || access === 'off') return 'Saving to GitHub is not set up on this server.';
    if (access === 'local' && !LOOPBACK.has(address(c))) return 'Saving to GitHub is only offered on the computer the app is running on, because the copy goes to the GitHub account signed in there.';
    return null;
  };

  app.get('/api/workshops/:id/backup/github', async (c) => {
    const id = c.req.param('id');
    if (roleOf(c, id).type !== 'facilitator') throw new CommandError('forbidden', 'Only the organizer can save the whole workshop.');
    const blocked = githubAllowed(c);
    if (blocked) return c.json({ available: false, repo: options.githubBackup?.repo ?? '', reason: blocked });
    return c.json(await options.githubBackup!.status());
  });

  app.post('/api/workshops/:id/backup/github', small, async (c) => {
    const id = c.req.param('id');
    const role = roleOf(c, id);
    const file = service.exportData(id, role); // organizer only
    const blocked = githubAllowed(c);
    if (blocked) throw new CommandError('forbidden', blocked);
    return c.json(await options.githubBackup!.save(file, id));
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  return app;
}
