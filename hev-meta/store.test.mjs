import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Store } from "./store.mjs";
import { handler, poll, publicStatus } from "./service.mjs";

const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222",
  C = "33333333-3333-4333-8333-333333333333";
const transcript = (segments) => ({
  language: "en",
  model: "large-v3-turbo",
  engine: "whisper.cpp 1.9.5",
  prompt: "",
  duration: 60,
  createdAt: "2026-11-17T00:00:00.000Z",
  segments,
});
const req = (asset, checksum = "sum1", extra = {}) => ({ assetId: asset, checksum, originalPath: `/external/${asset}.mp4`, ...extra });

test("checksum keys idempotency: same checksum is a no-op, a changed one re-transcribes", () => {
  const store = new Store(":memory:");
  const first = store.request(req(A));
  assert.equal(first.noop, false);
  assert.equal(store.request(req(A)).noop, true, "duplicate while queued is a no-op");
  const job = store.claim(1);
  assert.equal(store.request(req(A)).state, "running");
  store.finish(job.id, transcript([{ start: 0, end: 2, text: "hello" }]), "/dir");
  const again = store.request(req(A));
  assert.deepEqual([again.noop, again.state], [true, "done"]);
  assert.equal(store.current(A, "sum2"), undefined);
  const changed = store.request(req(A, "sum2"));
  assert.equal(changed.noop, false);
  assert.equal(store.request(req(A, "sum2", { force: true })).noop, true, "active job for the same checksum");
  // A newer checksum supersedes a still-queued older one.
  const third = store.request(req(A, "sum3"));
  assert.equal(store.job(changed.job.id).state, "superseded");
  assert.equal(third.job.checksum, "sum3");
});

test("queue runs one job at a time, explicit requests before poller, FIFO within priority", () => {
  const store = new Store(":memory:");
  const polled = store.request(req(A, "a", { source: "poller", priority: 1 })).job;
  const first = store.request(req(B, "b")).job;
  const second = store.request(req(C, "c")).job;
  assert.deepEqual([store.position(first.id), store.position(second.id), store.position(polled.id)], [0, 1, 2]);
  const running = store.claim(10);
  assert.equal(running.id, first.id);
  assert.equal(store.claim(11), undefined, "no second concurrent job");
  assert.equal(store.claim(11, second.id), undefined, "the CLI cannot jump a running job either");
  store.fail(running.id, "boom");
  assert.equal(store.claim(10).id, second.id);
  // A crashed runner's job returns to the queue; a live one is left alone.
  store.recover(() => true);
  assert.equal(store.job(second.id).state, "running");
  store.recover(() => false);
  assert.equal(store.job(second.id).state, "queued");
  assert.equal(store.claim(12, polled.id).id, polled.id, "the CLI may claim its own job when idle");
});

test("FTS indexes segments by asset and timestamps and replaces on re-transcription", () => {
  const store = new Store(":memory:");
  const job = (asset, sum) => store.claim(1, store.request(req(asset, sum)).job.id);
  store.finish(job(A, "1").id, transcript([
    { start: 10.5, end: 14, text: "Vibe coding with agents is fun" },
    { start: 14, end: 20, text: "Data Fuel is a podcast" },
  ]), "/a");
  store.finish(job(B, "1").id, transcript([{ start: 3, end: 4, text: "the agent wrote tests" }]), "/b");
  const hits = store.search("agents");
  assert.deepEqual(hits.map((h) => [h.assetId, h.start, h.end]).sort(), [[A, 10.5, 14], [B, 3, 4]]);
  assert.match(hits.find((h) => h.assetId === A).snippet, /\[agents\]/);
  assert.deepEqual(store.search('podcast" OR *'), store.search("podcast OR"), "query syntax is quoted away");
  store.finish(job(A, "2").id, transcript([{ start: 1, end: 2, text: "only this now" }]), "/a");
  assert.equal(store.search("podcast").length, 0);
  assert.equal(store.search("only").length, 1);
});

test("poller does nothing without a high-water mark and only enqueues newer videos", async () => {
  const store = new Store(":memory:");
  const logs = [];
  const items = [
    { id: A, type: "VIDEO", originalPath: "/external/old.mp4", checksum: "o", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: B, type: "VIDEO", originalPath: "/external/new.mp4", checksum: "n", createdAt: "2026-11-17T20:00:00.000Z" },
    { id: C, type: "VIDEO", originalPath: "/upload/phone.mp4", checksum: "p", createdAt: "2026-11-17T21:00:00.000Z" },
  ];
  let bodies = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return Response.json({ assets: { items: items.filter((i) => i.createdAt >= body.createdAfter), nextPage: null } });
  };
  const cfg = { immich: "http://immich/api", apiKey: "k" };
  assert.equal(await poll(store, cfg, (l) => logs.push(l), fetcher), 0);
  assert.equal(bodies.length, 0, "no Immich query without a mark");
  store.setting("hwm", "2026-11-17T19:00:00.000Z");
  assert.equal(await poll(store, cfg, (l) => logs.push(l), fetcher), 1);
  assert.deepEqual(store.jobs().map((j) => [j.asset_id, j.source]), [[B, "poller"]]);
  assert.equal(store.setting("hwm"), "2026-11-17T21:00:00.000Z");
  assert.equal(await poll(store, cfg, (l) => logs.push(l), fetcher), 0);
  assert.equal(bodies[0].type, "VIDEO");
});

function call(h, { method = "GET", url, headers = {}, body }) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers });
  return new Promise((resolve) => {
    const res = {
      status: 200,
      headers: {},
      headersSent: false,
      setHeader(k, v) { this.headers[k] = v; },
      writeHead(s, h) { this.status = s; Object.assign(this.headers, h); this.headersSent = true; return this; },
      end(b = "") { resolve({ status: this.status, body: String(b), headers: this.headers }); },
    };
    h(req, res);
  });
}

test("HTTP API validates the session, reads as the caller, and limits requests to admins", async () => {
  const store = new Store(":memory:");
  const users = { admin: { id: "u1", isAdmin: true }, viewer: { id: "u2", isAdmin: false } };
  const seen = [];
  const fetcher = async (url, init) => {
    const token = init.headers.Authorization?.slice(7);
    seen.push([url, token]);
    if (!users[token]) return new Response("", { status: 401 });
    if (url.endsWith("/users/me")) return Response.json(users[token]);
    return Response.json({ id: A, type: "VIDEO", originalPath: "/external/a.mp4", checksum: "sum" });
  };
  let woke = 0;
  const h = handler({ store, cfg: { immich: "http://immich/api" }, wake: () => woke++, fetcher });
  const url = `/hev-meta/transcripts/${A}`;
  assert.equal((await call(h, { url })).status, 401);
  assert.equal((await call(h, { url, headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await call(h, { url: "/health" })).body, "ok");
  assert.equal((await call(h, { method: "POST", url, headers: { authorization: "Bearer viewer" }, body: {} })).status, 403);
  assert.equal(store.jobs().length, 0);
  const posted = await call(h, { method: "POST", url, headers: { cookie: "a=b; immich_access_token=admin" }, body: { prompt: "Meghan" } });
  assert.equal(posted.status, 200);
  assert.deepEqual(JSON.parse(posted.body), { assetId: A, state: "queued", requestedAt: store.jobs()[0].requested_at, position: 0 });
  assert.equal(woke, 1);
  assert.ok(seen.some(([u, t]) => u.endsWith(`/assets/${A}`) && t === "admin"), "asset read with the caller's token");
  const job = store.claim(1);
  store.finish(job.id, { ...transcript([{ start: 0, end: 1, text: "hi" }]), prompt: "Meghan" }, "/d");
  const done = JSON.parse((await call(h, { url, headers: { authorization: "Bearer viewer" } })).body);
  assert.equal(done.state, "done");
  assert.deepEqual(done.transcript.segments, [{ start: 0, end: 1, text: "hi" }]);
  assert.ok(!JSON.stringify(done).includes("/external"), "no paths leave the service");
  const vtt = await call(h, { url: url + "?format=vtt", headers: { authorization: "Bearer viewer" } });
  assert.match(vtt.body, /^WEBVTT/);
  assert.equal((await call(h, { url, headers: { authorization: "Bearer admin", origin: "https://evil.example", host: "media" } })).status, 403);
  assert.equal(publicStatus(store, A, "changed").state, "none");
});
