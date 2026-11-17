#!/usr/bin/env node
// hev-meta transcribe ASSET_ID|--path PATH [--prompt TEXT] [--force] [--queue]
// hev-meta search QUERY | status | poll-init [--at ISO] | poll | serve
import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ASSET_ID, containerPath } from "./core.mjs";
import { asset, assetByPath, eligible, keyAuth } from "./immich.mjs";
import { config, transcribe } from "./pipeline.mjs";
import { poll, serve } from "./service.mjs";
import { Store } from "./store.mjs";

const usage = `usage: hev-meta transcribe ASSET_ID|--path PATH [--prompt TEXT] [--force] [--queue]
       hev-meta search QUERY
       hev-meta status
       hev-meta poll-init [--at ISO_TIME]
       hev-meta poll
       hev-meta serve`;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    path: { type: "string" },
    prompt: { type: "string" },
    force: { type: "boolean" },
    queue: { type: "boolean" },
    at: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...rest] = positionals;
if (values.help || !command) {
  console.log(usage);
  process.exit(command || values.help ? 0 : 2);
}
const cfg = config();
mkdirSync(cfg.data, { recursive: true, mode: 0o700 });
const store = new Store(path.join(cfg.data, "meta.sqlite"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (command === "transcribe") {
  const auth = keyAuth(cfg.apiKey);
  let info;
  if (values.path) {
    const original = await containerPath(values.path, cfg.external);
    info = await assetByPath(cfg.immich, auth, original);
    if (!info) throw Error(`${original} is not in Immich yet; rescan the external library first`);
  } else {
    if (!ASSET_ID.test(rest[0] ?? "")) {
      console.error(usage);
      process.exit(2);
    }
    info = await asset(cfg.immich, auth, rest[0]);
  }
  const result = store.request({ ...eligible(info), prompt: values.prompt?.trim() ?? "", source: "cli", force: values.force });
  if (result.noop && result.state === "done") {
    console.log(
      `hev-meta: asset ${info.id}: transcript current for checksum ${info.checksum} (${result.transcript.segments} segments, ${result.transcript.created_at}); nothing to do`,
    );
    process.exit(0);
  }
  if (result.noop) console.log(`hev-meta: asset ${info.id}: already ${result.state} as job ${result.job.id}; waiting`);
  else console.log(`hev-meta: asset ${info.id}: queued job ${result.job.id}`);
  if (values.queue) process.exit(0);
  // Run it here when nothing else is transcribing; otherwise wait for the worker.
  store.recover();
  for (;;) {
    const job = store.job(result.job.id);
    if (job.state === "done") break;
    if (job.state === "failed") {
      console.error(`hev-meta: job ${job.id} failed: ${job.error}`);
      process.exit(1);
    }
    const mine = job.state === "queued" && store.claim(process.pid, job.id);
    if (mine) {
      try {
        await transcribe(mine, cfg, store);
      } catch (error) {
        store.fail(mine.id, error.message);
        throw error;
      }
    } else await sleep(2000);
  }
} else if (command === "search") {
  const hits = store.search(rest.join(" "));
  for (const h of hits) console.log(`${h.assetId}\t${h.start.toFixed(2)}–${h.end.toFixed(2)}\t${h.snippet}`);
  if (!hits.length) console.log("no matches");
} else if (command === "status") {
  console.log(`high-water mark: ${store.setting("hwm") ?? "(not set; poller idle)"}`);
  const counts = store.counts();
  console.log(`queued: ${counts.queued ?? 0}, running: ${counts.running ?? 0}, done: ${counts.done ?? 0}, failed: ${counts.failed ?? 0}`);
  for (const j of store.jobs(20))
    console.log(`${j.id}\t${j.state}\t${j.source}\t${j.asset_id}\t${j.requested_at}${j.error ? `\t${j.error.slice(0, 80)}` : ""}`);
} else if (command === "poll-init") {
  const at = values.at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw Error("Invalid --at time");
  if (store.setting("hwm") && !values.force) console.log(`high-water mark already ${store.setting("hwm")}; pass --force to move it`);
  else {
    store.setting("hwm", at);
    console.log(`high-water mark set to ${at}; only videos added after it are polled`);
  }
} else if (command === "poll") {
  await poll(store, cfg);
} else if (command === "serve") {
  serve(store, cfg);
} else {
  console.error(usage);
  process.exit(2);
}
