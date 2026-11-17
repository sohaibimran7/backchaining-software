/**
 * Workshop service: identity, permissions, applying commands, persistence and
 * live fan-out. No HTTP in here, so it can be tested directly.
 */
import crypto from 'node:crypto';
import { clientCommandSchema, exportFileSchema, type Command, type ExportFile, type StoredEvent } from '../shared/commands';
import { getMethod } from '../shared/calc/registry';
import type { FormulaEngine } from '../shared/calc/types';
import { parseConfig, type WorkshopConfig } from '../shared/config';
import { defaultConfig } from '../shared/defaultConfig';
import { emptyState, execute, prepareRun } from '../shared/engine';
import { EXAMPLE_PARTICIPANTS, seedExample, seedUnconnected } from '../shared/example';
import { CommandError, type Actor, type Role, type WorkshopState, type WorkshopView } from '../shared/types';
import { viewFor } from '../shared/views';
import type { Store } from './store';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newKey(): string {
  return crypto.randomBytes(24).toString('base64url');
}
function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newId(length = 12): string {
  return crypto.randomBytes(length).toString('base64url').replace(/[-_]/g, '').slice(0, length).toLowerCase();
}
function newCode(): string {
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

interface Subscriber {
  role: Role;
  send: (view: WorkshopView) => void;
}

interface Loaded {
  state: WorkshopState;
  joinCode: string;
  subscribers: Set<Subscriber>;
}

export class WorkshopService {
  private loaded = new Map<string, Loaded>();

  constructor(
    private store: Store,
    private now: () => string = () => new Date().toISOString(),
    private engine: FormulaEngine | null = null,
  ) {}

  // — loading —

  private replay(id: string, events: StoredEvent[], strict: boolean): WorkshopState {
    const state = emptyState(id, defaultConfig);
    let working = state;
    for (const e of events) {
      const next = structuredClone(working);
      try {
        execute(next, { actor: e.actor, at: e.at, seq: e.seq }, e.cmd);
        working = next;
      } catch (err) {
        if (strict) throw err;
        // A stored event that no longer applies (e.g. after a code change) is skipped rather than losing the workshop.
        console.warn(`[workshop ${id}] skipped event ${e.seq} (${e.cmd.type}): ${(err as Error).message}`);
        working.seq = e.seq;
      }
    }
    return working;
  }

  private load(id: string): Loaded {
    const hit = this.loaded.get(id);
    if (hit) return hit;
    const row = this.store.getWorkshop(id);
    if (!row) throw new CommandError('not-found', 'That workshop does not exist.');
    const entry: Loaded = { state: this.replay(id, this.store.listEvents(id), false), joinCode: row.joinCode, subscribers: new Set() };
    this.loaded.set(id, entry);
    return entry;
  }

  // — identity —

  authenticate(workshopId: string, key: string | undefined): Role | null {
    if (!key) return null;
    const row = this.store.getWorkshop(workshopId);
    if (!row) return null;
    const hash = hashKey(key);
    if (safeEqual(hash, row.facilitatorKeyHash)) return { type: 'facilitator' };
    const participantId = this.store.findParticipantByKey(workshopId, hash);
    return participantId ? { type: 'participant', id: participantId } : null;
  }

  // — creating, joining —

  private uniqueCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = newCode();
      if (!this.store.getWorkshopByCode(code)) return code;
    }
    throw new Error('Could not allocate a join code');
  }

  create(input: { title: string; example?: boolean | 'unconnected'; solo?: boolean; config?: WorkshopConfig }): { workshopId: string; joinCode: string; facilitatorKey: string } {
    const id = newId();
    const key = newKey();
    const at = this.now();
    let config = input.config ?? defaultConfig;
    if (input.example === true) config = { ...config, calculation: { ...config.calculation, methodId: 'local-additive' } };
    const solo = !!input.solo || input.example === 'unconnected';
    const events: StoredEvent[] = [];
    let state = emptyState(id, config);
    const run = (actor: Actor, cmd: Command): WorkshopState => {
      const event: StoredEvent = { seq: events.length + 1, at, actor, cmd };
      const next = structuredClone(state);
      execute(next, { actor, at, seq: event.seq }, cmd);
      state = next;
      events.push(event);
      return state;
    };
    run({ type: 'system' }, { type: 'create', title: input.title, config, isExample: !!input.example, mode: solo ? 'solo' : 'workshop' });
    // Solo: the one person is organizer and participant at once.
    if (solo) run({ type: 'system' }, { type: 'join', participantId: 'me', name: 'Me' });
    if (input.example === true) {
      for (const p of EXAMPLE_PARTICIPANTS) run({ type: 'system' }, { type: 'join', participantId: p.id, name: p.name, active: false });
      seedExample((actor, cmd) => run(actor, cmd as Command));
    } else if (input.example === 'unconnected') {
      seedUnconnected((actor, cmd) => run(actor, cmd as Command));
    }
    const joinCode = this.uniqueCode();
    this.store.createWorkshop({ id, joinCode, facilitatorKeyHash: hashKey(key), createdAt: at }, events);
    this.loaded.set(id, { state, joinCode, subscribers: new Set() });
    return { workshopId: id, joinCode, facilitatorKey: key };
  }

  lookupCode(code: string): { workshopId: string; title: string } | null {
    const row = this.store.getWorkshopByCode(code.trim().toUpperCase());
    if (!row) return null;
    return { workshopId: row.id, title: this.load(row.id).state.title };
  }

  join(code: string, name: string): { workshopId: string; participantId: string; participantKey: string } {
    const row = this.store.getWorkshopByCode(code.trim().toUpperCase());
    if (!row) throw new CommandError('not-found', 'No workshop has that code. Check it and try again.');
    const entry = this.load(row.id);
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new CommandError('invalid', 'Please enter a name.');
    const count = Object.values(entry.state.participants).filter((p) => p.active).length;
    if (count >= entry.state.config.limits.maxParticipants) throw new CommandError('conflict', 'This workshop is full. Ask the facilitator to make room.');
    const participantId = `p${newId(8)}`;
    this.apply(row.id, { type: 'system' }, { type: 'join', participantId, name: clean });
    const key = newKey();
    this.store.setParticipantKey(row.id, participantId, hashKey(key));
    return { workshopId: row.id, participantId, participantKey: key };
  }

  /** Give a participant a fresh personal link (e.g. lost phone, or after importing a workshop). The old one stops working. */
  issueParticipantKey(workshopId: string, role: Role, participantId: string): string {
    if (role.type !== 'facilitator') throw new CommandError('forbidden', 'Only the facilitator can do that.');
    const entry = this.load(workshopId);
    if (!entry.state.participants[participantId]) throw new CommandError('not-found', 'That participant is not in this workshop.');
    const key = newKey();
    this.store.setParticipantKey(workshopId, participantId, hashKey(key));
    return key;
  }

  // — commands —

  private apply(workshopId: string, actor: Actor, cmd: Command): number {
    const entry = this.load(workshopId);
    const event: StoredEvent = { seq: entry.state.seq + 1, at: this.now(), actor, cmd };
    const next = structuredClone(entry.state);
    execute(next, { actor, at: event.at, seq: event.seq }, cmd);
    this.store.appendEvent(workshopId, event);
    entry.state = next;
    this.broadcast(entry);
    return event.seq;
  }

  /** Validate and apply a command sent by a client. */
  command(workshopId: string, role: Role, raw: unknown): { seq: number } {
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CommandError('invalid', parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('\n'));
    }
    const actor: Actor = role;
    const cmd = parsed.data;
    if (cmd.type === 'run_calculation') throw new CommandError('invalid', 'Calculations are run through runCalculation.');
    return { seq: this.apply(workshopId, actor, cmd) };
  }

  /**
   * Run a calculation. The arithmetic is asynchronous, so the workshop may move on while it runs:
   * results computed from an older state are thrown away and recomputed rather than stored as if current.
   */
  async runCalculation(workshopId: string, role: Role, raw: unknown): Promise<{ seq: number }> {
    const parsed = clientCommandSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'run_calculation') throw new CommandError('invalid', 'That is not a calculation request.');
    if (role.type !== 'facilitator') throw new CommandError('forbidden', 'Only the facilitator can run a calculation.');
    if (!this.engine) throw new CommandError('conflict', 'This server has no calculation engine configured.');
    this.load(workshopId); // fail fast if the workshop does not exist
    // Calculations for one workshop run strictly in the order they were requested, so a slow earlier
    // request can never land after — and appear newer than — a later one. Each stays its own run.
    const previous = this.calculating.get(workshopId) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(() => this.calculateInTurn(workshopId, role, parsed.data as Extract<typeof parsed.data, { type: 'run_calculation' }>));
    this.calculating.set(workshopId, mine);
    try {
      return await mine;
    } finally {
      if (this.calculating.get(workshopId) === mine) this.calculating.delete(workshopId);
    }
  }

  private calculating = new Map<string, Promise<unknown>>();

  private async calculateInTurn(workshopId: string, role: Role, request: Extract<import('../shared/commands').ClientCommand, { type: 'run_calculation' }>): Promise<{ seq: number }> {
    const parsed = { data: request };
    if (!this.engine) throw new CommandError('conflict', 'This server has no calculation engine configured.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = this.load(workshopId).state;
      const record = await prepareRun(snapshot, parsed.data, this.engine);
      const current = this.load(workshopId).state;
      if (current.modelRev === snapshot.modelRev) return { seq: this.apply(workshopId, role, record) };
    }
    throw new CommandError('conflict', 'The models kept changing while the calculation ran. Try again in a moment.');
  }

  // — views and live updates —

  private online(entry: Loaded): string[] {
    const ids = new Set<string>();
    for (const s of entry.subscribers) if (s.role.type === 'participant') ids.add(s.role.id);
    return [...ids];
  }

  view(workshopId: string, role: Role): WorkshopView {
    const entry = this.load(workshopId);
    return viewFor(entry.state, role, entry.joinCode, this.online(entry));
  }

  private broadcast(entry: Loaded): void {
    const online = this.online(entry);
    const cache = new Map<string, WorkshopView>();
    for (const s of entry.subscribers) {
      const cacheKey = s.role.type === 'facilitator' ? 'f' : `p:${s.role.id}`;
      let view = cache.get(cacheKey);
      if (!view) {
        view = viewFor(entry.state, s.role, entry.joinCode, online);
        cache.set(cacheKey, view);
      }
      try {
        s.send(view);
      } catch {
        /* a broken connection is cleaned up by its own close handler */
      }
    }
  }

  subscribe(workshopId: string, role: Role, send: (view: WorkshopView) => void): () => void {
    const entry = this.load(workshopId);
    const subscriber: Subscriber = { role, send };
    entry.subscribers.add(subscriber);
    this.broadcast(entry); // also tells everyone who is online
    return () => {
      entry.subscribers.delete(subscriber);
      this.broadcast(entry);
    };
  }

  // — export, import, copies —

  exportData(workshopId: string, role: Role, uptoSeq?: number): ExportFile {
    if (role.type !== 'facilitator') throw new CommandError('forbidden', 'Only the facilitator can export the whole workshop.');
    const entry = this.load(workshopId);
    const events = this.store.listEvents(workshopId).filter((e) => uptoSeq === undefined || e.seq <= uptoSeq);
    return { format: 'backchain-workshop', formatVersion: 1, exportedAt: this.now(), title: entry.state.title, events };
  }

  /** Create a NEW workshop from an export file. Every event is re-validated and replayed; nothing is trusted. */
  importData(raw: unknown, titleSuffix = ''): { workshopId: string; joinCode: string; facilitatorKey: string } {
    const parsed = exportFileSchema.safeParse(raw);
    if (!parsed.success) throw new CommandError('invalid', 'That file is not a workshop export this version can read.');
    const events = parsed.data.events.map((e, i) => ({ ...e, seq: i + 1 })) as StoredEvent[];
    const first = events[0]!;
    if (first.cmd.type !== 'create') throw new CommandError('invalid', 'That file does not start with a workshop.');
    const config = parseConfig(first.cmd.config);
    if (!config.ok) throw new CommandError('invalid', `The configuration in that file is not valid: ${config.problems.join('; ')}`);
    if (!getMethod(config.config.calculation.methodId)) throw new CommandError('invalid', `That file uses a calculation method this server does not have ("${config.config.calculation.methodId}").`);
    if (titleSuffix) first.cmd = { ...first.cmd, title: `${first.cmd.title}${titleSuffix}`.slice(0, 120) };
    const id = newId();
    let state: WorkshopState;
    try {
      state = this.replay(id, events, true);
    } catch (err) {
      throw new CommandError('invalid', `That file could not be replayed: ${(err as Error).message}`);
    }
    const key = newKey();
    const joinCode = this.uniqueCode();
    this.store.createWorkshop({ id, joinCode, facilitatorKeyHash: hashKey(key), createdAt: this.now() }, events);
    this.loaded.set(id, { state, joinCode, subscribers: new Set() });
    return { workshopId: id, joinCode, facilitatorKey: key };
  }

  /** A separate copy of the workshop as it was at an earlier revision. The original is untouched. */
  fork(workshopId: string, role: Role, seq: number): { workshopId: string; joinCode: string; facilitatorKey: string } {
    const data = this.exportData(workshopId, role, seq);
    if (data.events.length === 0) throw new CommandError('invalid', 'There is nothing at that revision.');
    return this.importData(data, ` (copy at revision ${seq})`);
  }
}
