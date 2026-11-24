/**
 * Storage adapter. The app only needs these few operations, so swapping
 * SQLite for Postgres/Supabase means implementing this interface once.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { StoredEvent } from '../shared/commands';

export interface WorkshopRow {
  id: string;
  joinCode: string;
  facilitatorKeyHash: string;
  createdAt: string;
}

export interface Store {
  createWorkshop(row: WorkshopRow, firstEvents: StoredEvent[]): void;
  getWorkshop(id: string): WorkshopRow | undefined;
  getWorkshopByCode(code: string): WorkshopRow | undefined;
  listWorkshops(): WorkshopRow[];
  appendEvent(workshopId: string, event: StoredEvent): void;
  listEvents(workshopId: string): StoredEvent[];
  setParticipantKey(workshopId: string, participantId: string, keyHash: string): void;
  findParticipantByKey(workshopId: string, keyHash: string): string | undefined;
  close(): void;
}

export class MemoryStore implements Store {
  private workshops = new Map<string, WorkshopRow>();
  private events = new Map<string, StoredEvent[]>();
  private keys = new Map<string, Map<string, string>>();

  createWorkshop(row: WorkshopRow, firstEvents: StoredEvent[]): void {
    this.workshops.set(row.id, row);
    this.events.set(row.id, structuredClone(firstEvents));
    this.keys.set(row.id, new Map());
  }
  getWorkshop(id: string) {
    return this.workshops.get(id);
  }
  getWorkshopByCode(code: string) {
    return [...this.workshops.values()].find((w) => w.joinCode === code);
  }
  listWorkshops() {
    return [...this.workshops.values()];
  }
  appendEvent(workshopId: string, event: StoredEvent): void {
    this.events.get(workshopId)!.push(structuredClone(event));
  }
  listEvents(workshopId: string): StoredEvent[] {
    return structuredClone(this.events.get(workshopId) ?? []);
  }
  setParticipantKey(workshopId: string, participantId: string, keyHash: string): void {
    this.keys.get(workshopId)!.set(participantId, keyHash);
  }
  findParticipantByKey(workshopId: string, keyHash: string): string | undefined {
    for (const [pid, hash] of this.keys.get(workshopId) ?? []) if (hash === keyHash) return pid;
    return undefined;
  }
  close(): void {}
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS workshops (
        id TEXT PRIMARY KEY,
        join_code TEXT NOT NULL UNIQUE,
        facilitator_key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participant_keys (
        workshop_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        PRIMARY KEY (workshop_id, participant_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        workshop_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        cmd TEXT NOT NULL,
        PRIMARY KEY (workshop_id, seq)
      );
    `);
  }

  private insertEvent(workshopId: string, e: StoredEvent): void {
    this.db.prepare('INSERT INTO events (workshop_id, seq, at, actor, cmd) VALUES (?, ?, ?, ?, ?)').run(workshopId, e.seq, e.at, JSON.stringify(e.actor), JSON.stringify(e.cmd));
  }

  createWorkshop(row: WorkshopRow, firstEvents: StoredEvent[]): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO workshops (id, join_code, facilitator_key_hash, created_at) VALUES (?, ?, ?, ?)').run(row.id, row.joinCode, row.facilitatorKeyHash, row.createdAt);
      for (const e of firstEvents) this.insertEvent(row.id, e);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private toRow(r: Record<string, unknown> | undefined): WorkshopRow | undefined {
    if (!r) return undefined;
    return { id: String(r.id), joinCode: String(r.join_code), facilitatorKeyHash: String(r.facilitator_key_hash), createdAt: String(r.created_at) };
  }
  getWorkshop(id: string) {
    return this.toRow(this.db.prepare('SELECT * FROM workshops WHERE id = ?').get(id) as Record<string, unknown> | undefined);
  }
  getWorkshopByCode(code: string) {
    return this.toRow(this.db.prepare('SELECT * FROM workshops WHERE join_code = ?').get(code) as Record<string, unknown> | undefined);
  }
  listWorkshops(): WorkshopRow[] {
    return (this.db.prepare('SELECT * FROM workshops ORDER BY created_at').all() as Record<string, unknown>[]).map((r) => this.toRow(r)!);
  }
  appendEvent(workshopId: string, event: StoredEvent): void {
    this.insertEvent(workshopId, event);
  }
  listEvents(workshopId: string): StoredEvent[] {
    const rows = this.db.prepare('SELECT seq, at, actor, cmd FROM events WHERE workshop_id = ? ORDER BY seq').all(workshopId) as Record<string, unknown>[];
    return rows.map((r) => ({ seq: Number(r.seq), at: String(r.at), actor: JSON.parse(String(r.actor)), cmd: JSON.parse(String(r.cmd)) }));
  }
  setParticipantKey(workshopId: string, participantId: string, keyHash: string): void {
    this.db
      .prepare('INSERT INTO participant_keys (workshop_id, participant_id, key_hash) VALUES (?, ?, ?) ON CONFLICT (workshop_id, participant_id) DO UPDATE SET key_hash = excluded.key_hash')
      .run(workshopId, participantId, keyHash);
  }
  findParticipantByKey(workshopId: string, keyHash: string): string | undefined {
    const r = this.db.prepare('SELECT participant_id FROM participant_keys WHERE workshop_id = ? AND key_hash = ?').get(workshopId, keyHash) as Record<string, unknown> | undefined;
    return r ? String(r.participant_id) : undefined;
  }
  close(): void {
    this.db.close();
  }
}
