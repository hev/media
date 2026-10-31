import { realpath } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual, randomUUID } from "node:crypto";
export function authorized(header, secret) {
  if (!secret || typeof header !== "string") return false;
  const a = Buffer.from(header),
    b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function originalPath(original, root) {
  if (
    typeof original !== "string" ||
    !original.startsWith("/external/") ||
    original.split("/").includes("..")
  )
    throw Error("Original is outside /external");
  const base = await realpath(root);
  const target = await realpath(
    path.join(base, original.slice("/external/".length)),
  );
  if (!target.startsWith(base + path.sep))
    throw Error("Original escapes external root");
  return target;
}
export function validate(input) {
  if (
    !input ||
    Object.keys(input).some(
      (k) =>
        ![
          "assets",
          "brief",
          "length",
          "caption",
          "threadId",
          "ownerId",
        ].includes(k),
    ) ||
    !Array.isArray(input.assets) ||
    input.assets.length < 1 ||
    input.assets.length > 20 ||
    input.assets.some(
      (a) =>
        !a ||
        !/^[a-f0-9-]{36}$/i.test(a.id) ||
        typeof a.originalPath !== "string",
    ) ||
    typeof input.brief !== "string" ||
    !input.brief.trim() ||
    input.brief.length > 8000 ||
    typeof input.caption !== "string" ||
    input.caption.length > 2200 ||
    !Number.isFinite(input.length) ||
    input.length < 1 ||
    input.length > 60
  )
    throw Error("Invalid edit brief");
  if (
    input.threadId !== undefined &&
    (!/^[a-f0-9-]{36}$/.test(input.threadId) ||
      typeof input.ownerId !== "string")
  )
    throw Error("Invalid thread");
  return input;
}
const next = {
  queued: ["editing", "failed"],
  editing: ["rendered", "failed"],
  rendered: ["uploading", "failed"],
  uploading: ["drafted", "failed"],
  drafted: [],
  failed: [],
};
export function transition(job, state, note) {
  if (!next[job.state]?.includes(state)) throw Error("Invalid job transition");
  Object.assign(job, { state, note, updatedAt: new Date().toISOString() });
}
export class Queue {
  jobs = new Map();
  running = false;
  constructor(run, save = async () => {}) {
    this.run = run;
    this.save = save;
  }
  async add(input) {
    const job = {
      id: randomUUID(),
      state: "queued",
      note: "Waiting for editor",
      input,
      revision: 1,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    await this.save(job);
    void this.drain();
    return job;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs.values()) {
        if (job.state !== "queued") continue;
        const update = async (state, note) => {
          transition(job, state, note);
          await this.save(job);
        };
        try {
          await update("editing", "Editor is reviewing the footage");
          await this.run(job, update);
        } catch {
          if (next[job.state]?.includes("failed"))
            await update(
              "failed",
              "Edit failed; inspect the private job log before retrying",
            );
        }
      }
    } finally {
      this.running = false;
    }
  }
}
export function publicJob(job) {
  const { id, state, note, revision, createdAt, updatedAt, bufferUrl } = job;
  return {
    id,
    state,
    note,
    revision,
    createdAt,
    updatedAt,
    bufferUrl,
    threadId: job.input.threadId,
    revisions: (
      job.revisions ??
      (job.mediaUrl
        ? [{ revision: job.revision, bufferUrl: job.bufferUrl }]
        : [])
    )?.map((r) => ({
      revision: r.revision,
      bufferUrl: r.bufferUrl,
      preview: `/hev-chat/edits/${id}/preview?revision=${r.revision}`,
    })),
    preview: ["rendered", "uploading", "drafted"].includes(state)
      ? `/hev-chat/edits/${id}/preview`
      : undefined,
  };
}

// Persist the claim before making the outward request. Ambiguous failures remain
// claimed for inspection rather than risking a second draft on retry/restart.
export async function publishRevision(job, number, save, draft) {
  const revision = job.revisions?.find((r) => r.revision === number);
  if (!revision) throw Error("Revision unavailable");
  if (revision.bufferUrl) return revision;
  if (revision.publishing)
    throw Error("Publish already requested; inspect ledger before retry");
  revision.publishing = true;
  await save(job);
  revision.bufferUrl = await draft(revision);
  revision.publishing = false;
  if (number === job.revision) {
    job.bufferUrl = revision.bufferUrl;
    job.state = "drafted";
    job.note = "Draft saved in Buffer for human review";
  }
  await save(job);
  return revision;
}
