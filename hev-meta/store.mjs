// SQLite index and queue for hev-meta. Lives in a data dir on internal disk;
// transcript files are written separately beside the library.
import { DatabaseSync } from "node:sqlite";

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS transcripts(asset_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, language TEXT, model TEXT, engine TEXT, prompt TEXT, duration REAL, segments INTEGER, dir TEXT, created_at TEXT, json TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS segments USING fts5(text, asset_id UNINDEXED, start UNINDEXED, end UNINDEXED, tokenize='porter unicode61');
      CREATE TABLE IF NOT EXISTS jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, checksum TEXT NOT NULL, original_path TEXT NOT NULL, prompt TEXT, priority INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, state TEXT NOT NULL, pid INTEGER, error TEXT, requested_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state, priority, id);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  transcript(assetId) {
    return this.db.prepare("SELECT * FROM transcripts WHERE asset_id=?").get(assetId);
  }
  // A transcript is current only for the checksum it was made from.
  current(assetId, checksum) {
    const row = this.transcript(assetId);
    return row && row.checksum === checksum ? row : undefined;
  }
  active(assetId) {
    return this.db
      .prepare("SELECT * FROM jobs WHERE asset_id=? AND state IN ('queued','running') ORDER BY id LIMIT 1")
      .get(assetId);
  }
  latestJob(assetId) {
    return this.db.prepare("SELECT * FROM jobs WHERE asset_id=? ORDER BY id DESC LIMIT 1").get(assetId);
  }
  // Idempotent: a current transcript or an equivalent active job is a no-op.
  request({ assetId, checksum, originalPath, prompt = "", source = "api", priority = 0, force = false }) {
    return this.tx(() => {
      const done = this.current(assetId, checksum);
      if (done && !force) return { noop: true, state: "done", transcript: done };
      const active = this.active(assetId);
      if (active && active.checksum === checksum) return { noop: true, state: active.state, job: active };
      // A queued request for an older checksum is superseded.
      if (active?.state === "queued")
        this.db.prepare("UPDATE jobs SET state='superseded', finished_at=? WHERE id=?").run(now(), active.id);
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO jobs(asset_id, checksum, original_path, prompt, priority, source, state, requested_at) VALUES(?,?,?,?,?,?,'queued',?)",
        )
        .run(assetId, checksum, originalPath, prompt, priority, source, now());
      return { noop: false, state: "queued", job: this.job(Number(lastInsertRowid)) };
    });
  }
  job(id) {
    return this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
  }
  // One asset at a time across the worker and CLI: refuse while any job runs.
  claim(pid, id) {
    return this.tx(() => {
      if (this.db.prepare("SELECT id FROM jobs WHERE state='running'").get()) return undefined;
      const job = id
        ? this.db.prepare("SELECT * FROM jobs WHERE id=? AND state='queued'").get(id)
        : this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY priority, id LIMIT 1").get();
      if (!job) return undefined;
      this.db.prepare("UPDATE jobs SET state='running', pid=?, started_at=? WHERE id=?").run(pid, now(), job.id);
      return this.job(job.id);
    });
  }
  position(id) {
    const job = this.job(id);
    if (job?.state !== "queued") return 0;
    return Number(
      this.db
        .prepare(
          "SELECT COUNT(*) n FROM jobs WHERE state='running' OR (state='queued' AND (priority<? OR (priority=? AND id<?)))",
        )
        .get(job.priority, job.priority, job.id).n,
    );
  }
  finish(id, transcript, dir) {
    this.tx(() => {
      const job = this.job(id);
      this.db.prepare("DELETE FROM segments WHERE asset_id=?").run(job.asset_id);
      const insert = this.db.prepare("INSERT INTO segments(text, asset_id, start, end) VALUES(?,?,?,?)");
      for (const s of transcript.segments) insert.run(s.text, job.asset_id, s.start, s.end);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO transcripts(asset_id, checksum, language, model, engine, prompt, duration, segments, dir, created_at, json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          job.asset_id,
          job.checksum,
          transcript.language,
          transcript.model,
          transcript.engine,
          transcript.prompt,
          transcript.duration,
          transcript.segments.length,
          dir,
          transcript.createdAt,
          JSON.stringify(transcript),
        );
      this.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(now(), id);
    });
  }
  fail(id, error) {
    this.db.prepare("UPDATE jobs SET state='failed', error=?, finished_at=? WHERE id=?").run(String(error).slice(0, 500), now(), id);
  }
  // After a crash, return running jobs whose process is gone to the queue.
  recover(alive = processAlive) {
    for (const job of this.db.prepare("SELECT * FROM jobs WHERE state='running'").all())
      if (!alive(job.pid)) this.db.prepare("UPDATE jobs SET state='queued', pid=NULL, started_at=NULL WHERE id=?").run(job.id);
  }
  counts() {
    return Object.fromEntries(this.db.prepare("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all().map((r) => [r.state, Number(r.n)]));
  }
  jobs(limit = 20) {
    return this.db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit);
  }
  // Each word is quoted, so user input never reaches FTS5 query syntax.
  search(query, limit = 20) {
    const terms = String(query).match(/[\p{L}\p{N}'’]+/gu) ?? [];
    if (!terms.length) return [];
    return this.db
      .prepare(
        "SELECT asset_id AS assetId, start, end, snippet(segments, 0, '[', ']', '…', 12) AS snippet FROM segments WHERE segments MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" "), limit)
      .map((r) => ({ ...r }));
  }
  setting(key, value) {
    if (value === undefined) return this.db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
    this.db.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(key, String(value));
  }
}
const now = () => new Date().toISOString();
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
