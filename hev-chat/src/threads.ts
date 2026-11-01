import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export type Turn = {
  role: 'user' | 'assistant';
  content: string;
  assets: any[];
  jobs?: string[];
};
export type Thread = {
  id: string;
  title: string;
  messages: Turn[];
  selected: any[];
  smartQuery?: string;
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
