import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
const script = path.resolve("bin/imovie-open");
const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
test("pull command rejects invalid arguments before SSH", () => {
  for (const args of [
    [],
    ["../x"],
    [id, "0"],
    [id, "1;touch"],
    [id, "2", "extra"],
  ]) {
    const r = spawnSync(script, args, { encoding: "utf8" });
    assert.equal(r.status, 2, JSON.stringify(args));
  }
});
test("pull command retrieves, extracts, removes zip and opens library; default picks latest; repeat preserves edits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "imovie-pull-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const remote = `/Users/hev/dispatch/edits/${id}/imovie/beach-r2.imovielibrary.zip`;
  const scripts = {
    ssh: `case "$*" in *job.json*) echo '{"revision":2}';; *) echo '{"state":"ready","zip":"${remote}"}';; esac`,
    scp: 'echo "$*" >> "$HOME/copies"; touch "$2"',
    ditto: 'mkdir -p "$4/beach-r2.imovielibrary"',
    open: 'echo "$*" >> "$HOME/opened"',
  };
  for (const [name, body] of Object.entries(scripts))
    await writeFile(path.join(bin, name), "#!/bin/sh\n" + body + "\n", {
      mode: 0o700,
    });
  const env = {
    ...process.env,
    HOME: root,
    PATH: bin + ":/usr/bin:/bin",
    IMOVIE_HOST: "localhost",
  };
  let r = spawnSync(script, [id], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(
    await readFile(path.join(root, "opened"), "utf8"),
    /beach-r2.imovielibrary/,
  );
  r = spawnSync(script, [id, "2"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    (await readFile(path.join(root, "copies"), "utf8")).trim().split("\n")
      .length,
    1,
  );
  r = spawnSync(script, [id, "2"], {
    env: { ...env, IMOVIE_HOST: "-malicious" },
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
});
