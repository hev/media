// HTTP API, queue worker and optional new-video poller (`hev-meta serve`).
import { createServer } from "node:http";
import { ASSET_ID, toSrt, toVtt } from "./core.mjs";
import { SessionError, asset, eligible, keyAuth, me, newVideos, sessionAuth } from "./immich.mjs";
import { transcribe } from "./pipeline.mjs";

export function publicStatus(store, assetId, checksum) {
  const row = store.current(assetId, checksum);
  if (row) {
    const t = JSON.parse(row.json);
    return {
      assetId,
      state: "done",
      transcript: {
        language: t.language,
        model: t.model,
        engine: t.engine,
        prompt: t.prompt,
        duration: t.duration,
        createdAt: t.createdAt,
        segments: t.segments.map(({ start, end, text }) => ({ start, end, text })),
      },
    };
  }
  const job = store.latestJob(assetId);
  if (!job || job.checksum !== checksum || ["done", "superseded"].includes(job.state)) return { assetId, state: "none" };
  return {
    assetId,
    state: job.state,
    requestedAt: job.requested_at,
    startedAt: job.started_at ?? undefined,
    position: store.position(job.id),
  };
}

// Routes: GET /health; GET /transcripts/:id[?format=vtt|srt]; POST /transcripts/:id.
// Every non-health request validates the caller's Immich session and reads
// the asset as that caller; transcription requests are admin only.
export function handler({ store, cfg, wake = () => {}, fetcher = fetch }) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/^\/hev-meta(?=\/)/, "");
    if (route === "/health" && req.method === "GET") return void res.end("ok");
    const match = route.match(/^\/transcripts\/([^/]+)$/);
    if (!match || !["GET", "POST"].includes(req.method)) return void res.writeHead(404).end();
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).host !== req.headers.host) return void res.writeHead(403).end();
      } catch {
        return void res.writeHead(403).end();
      }
    }
    try {
      if (!ASSET_ID.test(match[1])) return void res.writeHead(400).end();
      const auth = sessionAuth(req.headers);
      const user = await me(cfg.immich, auth, fetcher);
      const info = await asset(cfg.immich, auth, match[1], fetcher);
      if (req.method === "POST") {
        if (!user.isAdmin) return void res.writeHead(403).end();
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 4000) return void res.writeHead(413).end();
        }
        const input = JSON.parse(body || "{}");
        if ((input.prompt !== undefined && (typeof input.prompt !== "string" || input.prompt.length > 600)) || (input.force !== undefined && typeof input.force !== "boolean"))
          return void res.writeHead(400).end();
        const result = store.request({ ...eligible(info), prompt: input.prompt?.trim() ?? "", source: "api", force: input.force });
        console.log(
          `hev-meta: api request asset ${info.id} by ${user.id}: ${result.noop ? `no-op (${result.state})` : `queued job ${result.job.id}`}`,
        );
        wake();
      }
      const status = publicStatus(store, info.id, info.checksum);
      const format = url.searchParams.get("format");
      if (format === "vtt" || format === "srt") {
        if (status.state !== "done") return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8" });
        return void res.end((format === "vtt" ? toVtt : toSrt)(status.transcript.segments));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (error) {
      // Never serialize upstream errors; they may carry tokens or paths.
      if (!res.headersSent) res.writeHead(error instanceof SessionError ? 401 : 400);
      res.end();
    }
  };
}

export function worker(store, cfg, log = console.log) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      let job;
      while ((job = store.claim(process.pid))) {
        try {
          await transcribe(job, cfg, store, log);
        } catch (error) {
          store.fail(job.id, error.message);
          log(`hev-meta: job ${job.id} asset ${job.asset_id} failed: ${error.message.split("\n")[0].slice(0, 200)}`);
        }
      }
    } finally {
      busy = false;
    }
  };
  return tick;
}

// Enqueue only videos created after the recorded high-water mark. Without a
// mark (set by `hev-meta poll-init` at install) the poller does nothing, so it
// can never enqueue the existing library.
export async function poll(store, cfg, log = console.log, fetcher = fetch) {
  const mark = store.setting("hwm");
  if (!mark) {
    log("hev-meta: poller idle: no high-water mark; run hev-meta poll-init");
    return 0;
  }
  const videos = await newVideos(cfg.immich, keyAuth(cfg.apiKey), mark, fetcher);
  let queued = 0,
    latest = mark;
  for (const v of videos) {
    if (Date.parse(v.createdAt) > Date.parse(latest)) latest = v.createdAt;
    try {
      const r = store.request({ ...eligible(v), source: "poller", priority: 1 });
      if (!r.noop) queued++;
    } catch {
      /* not an external-library video */
    }
  }
  if (latest !== mark) store.setting("hwm", latest);
  log(`hev-meta: poller: ${videos.length} new videos since ${mark}, ${queued} queued`);
  return queued;
}

export function serve(store, cfg) {
  store.recover();
  const tick = worker(store, cfg);
  setInterval(tick, 5000).unref();
  void tick();
  if (cfg.poll > 0)
    setInterval(() => poll(store, cfg).then((n) => n && tick()).catch((e) => console.log(`hev-meta: poller failed: ${e.message}`)), cfg.poll * 1000);
  const server = createServer(handler({ store, cfg, wake: () => void tick() }));
  server.listen(cfg.port, cfg.bind, () => console.log(`hev-meta: listening on ${cfg.bind}:${cfg.port}`));
  return server;
}
