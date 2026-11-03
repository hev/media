import type { EditSetup } from './ux.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export type ToolStep = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  elapsedMs?: number;
  before?: number;
  after?: number;
  shown?: number;
};
export type Turn = {
  role: 'user' | 'assistant';
  content: string;
  assets: any[];
  jobs?: string[];
  steps?: ToolStep[];
};
export type Thread = {
  id: string;
  title: string;
  messages: Turn[];
  selected: any[];
  smartQuery?: string;
  autoTitle?: boolean;
  setupAfter?: number;
  workers?: Record<string, unknown[]>;
  setup?: EditSetup;
  jobs: string[];
  updatedAt: number;
};
export class Threads {
  db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(
      'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, owner TEXT NOT NULL, thread TEXT NOT NULL);',
    );
  }
  list(owner: string): Thread[] {
    return (
      this.db
        .prepare('SELECT data FROM threads WHERE owner=?')
        .all(owner) as any[]
    )
      .map((r) => JSON.parse(r.data))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(owner: string, id: string): Thread | undefined {
    const row = this.db
      .prepare('SELECT data FROM threads WHERE owner=? AND id=?')
      .get(owner, id) as any;
    return row && JSON.parse(row.data);
  }
  save(owner: string, thread: Thread) {
    if (!this.get(owner, thread.id)) throw Error('Thread unavailable');
    thread.updatedAt = Date.now();
    this.db
      .prepare('UPDATE threads SET data=? WHERE owner=? AND id=?')
      .run(JSON.stringify(thread), owner, thread.id);
  }
  create(owner: string, title = 'New thread') {
    const t: Thread = {
      id: randomUUID(),
      title,
      autoTitle: title === 'New thread',
      messages: [],
      selected: [],
      jobs: [],
      updatedAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO threads VALUES(?,?,?)')
      .run(t.id, owner, JSON.stringify(t));
    return t;
  }
  recordWorkers(owner: string, id: string, updates: Record<string, unknown[]>) {
    // Re-read after async launcher requests so polling never overwrites a newer setup/title/turn.
    const current = this.get(owner, id);
    if (!current) return;
    // Viewing a legacy thread must not mutate it when no new worker has reported.
    const reported = Object.fromEntries(
      Object.entries(updates).filter(([, steps]) => steps.length > 0),
    );
    if (Object.keys(reported).length === 0) return;
    const workers = { ...current.workers, ...reported };
    if (JSON.stringify(workers) === JSON.stringify(current.workers)) return;
    current.workers = workers;
    this.save(owner, current);
  }
  delete(owner: string, id: string) {
    this.db
      .prepare('DELETE FROM threads WHERE owner=? AND id=?')
      .run(owner, id);
  }
  claim(owner: string, thread: Thread, job: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO jobs VALUES(?,?,?)')
      .run(job, owner, thread.id);
    if (!this.owns(owner, thread.id, job)) throw Error('Job unavailable');
    if (!thread.jobs.includes(job)) thread.jobs.push(job);
    this.save(owner, thread);
  }
  owns(owner: string, thread: string, job: string) {
    return !!this.db
      .prepare('SELECT id FROM jobs WHERE id=? AND owner=? AND thread=?')
      .get(job, owner, thread);
  }
  assigned(job: string) {
    return !!this.db.prepare('SELECT id FROM jobs WHERE id=?').get(job);
  }
}
