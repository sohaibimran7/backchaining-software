/** Process entry point: HTTP API, websocket fan-out, and (in production) the built web app. */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Role } from '../shared/types';
import { createApp } from './app';
import { createGithubBackup, DEFAULT_BACKUP_REPO, localToken } from './githubBackup';
import { WorkshopService } from './service';
import { createSquiggleEngine } from './squiggleEngine';
import { SqliteStore } from './store';

// Minimal .env loader (no dependency): KEY=value lines, existing environment wins.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, '');
  }
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
const publicBaseUrl = process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || undefined;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const store = new SqliteStore(path.join(dataDir, 'workshops.sqlite'));
const engine = createSquiggleEngine({ timeLimitMs: Number(process.env.CALCULATION_TIME_LIMIT_MS ?? 15_000) });
const service = new WorkshopService(store, undefined, engine);
const app = createApp(service, {
  publicBaseUrl,
  createSecret: process.env.CREATE_WORKSHOP_SECRET?.trim() || undefined,
  allowedOrigins,
  port,
  githubBackup: createGithubBackup({ token: localToken, repo: process.env.GITHUB_BACKUP_REPO?.trim() || DEFAULT_BACKUP_REPO }),
  githubBackupAccess: (['local', 'on', 'off'] as const).find((x) => x === process.env.GITHUB_BACKUP) ?? 'local',
  rateLimitScale: Math.max(1, Number(process.env.RATE_LIMIT_SCALE ?? 1) || 1),
  clientAddress: (c) => {
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  },
});

// — static web app (production build) —
const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = [path.resolve(here, '../web'), path.resolve(here, '../dist/web')].find((p) => fs.existsSync(path.join(p, 'index.html')));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
if (webRoot) {
  app.get('*', (c) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad request', 400);
    }
    const candidate = path.normalize(path.join(webRoot, pathname));
    const inside = candidate === webRoot || candidate.startsWith(webRoot + path.sep);
    const isFile = inside && fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    const file = isFile ? candidate : path.join(webRoot, 'index.html'); // single-page app fallback
    const type = MIME[path.extname(file)] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
    headers['cache-control'] = isFile && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(fs.readFileSync(file), 200, headers);
  });
} else {
  app.get('/', (c) => c.text('API server is running. In development open the Vite address (default http://localhost:5173). For production run "npm run build" first.'));
}

const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Backchain server listening on http://localhost:${port}`);
  console.log(`Data directory: ${dataDir}`);
  console.log(`Formula engine: ${engine.id} ${engine.version}`);
  if (publicBaseUrl) console.log(`Participants join at: ${publicBaseUrl}`);
  else console.log('PUBLIC_BASE_URL is not set: the join link will use whatever address the facilitator has open. "localhost" will not work on phones.');
});

// — websocket: clients say hello with their key, then receive their own filtered view on every change —
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

(server as import('node:http').Server).on('upgrade', (req: IncomingMessage, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host || allowedOrigins.includes(origin) || (!!publicBaseUrl && new URL(publicBaseUrl).origin === origin);
    } catch {
      ok = false;
    }
    if (!ok) {
      socket.destroy();
      return;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws: WebSocket) => {
  let unsubscribe: (() => void) | null = null;
  let alive = true;
  const helloTimer = setTimeout(() => {
    if (!unsubscribe) ws.close(4001, 'No hello');
  }, 10_000);

  ws.on('pong', () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 25_000);

  ws.on('message', (raw) => {
    if (unsubscribe) return; // only the hello is expected
    let msg: { type?: string; workshopId?: string; key?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return ws.close(4000, 'Bad message');
    }
    if (msg.type !== 'hello' || typeof msg.workshopId !== 'string' || typeof msg.key !== 'string') return ws.close(4000, 'Bad hello');
    let role: Role | null = null;
    try {
      role = service.authenticate(msg.workshopId, msg.key);
    } catch {
      role = null;
    }
    if (!role) {
      ws.send(JSON.stringify({ type: 'denied' }));
      return ws.close(4003, 'Not allowed');
    }
    try {
      unsubscribe = service.subscribe(msg.workshopId, role, (view) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'view', view }));
      });
    } catch {
      ws.close(4004, 'No such workshop');
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    clearInterval(heartbeat);
    unsubscribe?.();
  });
  ws.on('error', () => ws.terminate());
});

function shutdown() {
  wss.close();
  void engine.close();
  (server as import('node:http').Server).close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
