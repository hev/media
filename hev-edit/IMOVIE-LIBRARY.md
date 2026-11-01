# Native iMovie handoff

Open in iMovie queues a revision-specific library build on the mini. The manual
kit stays available. GET reads state without creating work; POST starts a build.
The chat proxy applies the same session, administrator and thread ownership checks
as the manual kit. No publishing or Buffer operation is involved.

The queue coalesces requests, persists state, and holds `/tmp/hev-imovie-screen.lock`
through native work. Another active mini peer or an existing lock leaves the job
waiting. Never delete a lock until its owner and the desktop are inspected. A
service interruption marks unfinished work failed rather than replaying UI changes.
Queued builds which have not begun resume on restart. A coordinator doing only
shell/headless work can explicitly release its own desktop reservation for thirty
minutes with `bin/imovie-release-screen`; `--reclaim` ends that release. Leases
match the exact peer PID/start time and expire; they cannot exempt another agent.
The coordinator must avoid desktop use until the builder releases its lock.
Failures retain private input, logs and partial libraries for inspection. They are
not automatically retried. After inspecting and preserving evidence, an operator
can move the failed state file aside to admit a fresh request.

A build prepares numbered media directly from staged originals using the rendered
cut's fit/focus settings, output canvas and cadence, retaining the kit's handles.
Extras remain in the event. A constrained native worker uses the iMovie and
computer-use skills, checks exact frame timecodes, native titles and playback,
then quits iMovie. Builds stop if the subscription usage gate is unknown or at
85%. A blocked screen reports waiting; the worker never handles permission
prompts. The worker is agent-driven and requires configured Codex CUA access on
the mini; this is not a binary-only iMovie API.

Before ready, the service requires timeline verification, a quit iMovie process,
internal Original Media and no escaping symlinks. Apple's bookmark format is
opaque; a copied-library playback check remains part of release acceptance.
Libraries and ZIPs stay private under the job's `imovie/` directory.

Mac iMovie 10.4.3 supports portrait projects through File → New App Preview.
**Export using Share → App Preview** for 1080×1920. Export File at 1080p produced
608×1080 in the test; its 1080p label is not a 1080-pixel portrait width.
Native titles work in the portrait canvas. Normal Movie projects use 16:9.

FOH installs `bin/imovie-open` on the laptop's PATH. It needs only macOS sh, ssh,
scp, sed, ditto and open. `imovie-open JOB [REVISION]` uses the existing mini SSH
alias, chooses the latest revision if omitted, copies the ready ZIP, extracts it,
removes the ZIP and opens the library. An existing local library is opened as-is
so local edits are preserved. `IMOVIE_HOST=localhost` supports mini-side testing;
no laptop GUI automation is involved.
