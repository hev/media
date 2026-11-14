# Host edit launcher

Run on the media host with Node 24 or newer. The service binds loopback, requires
an independent shared secret on every request, and never accepts an Immich token.
Chat validates the caller session and administrator role before proxying jobs or
video bytes. Keep the listener private; do not add a public proxy route to it.

Configuration (private values belong outside this public repository):

- `HEV_EDIT_ROOT`: private job directory, e.g. `~/dispatch/edits` (absolute path).
- `HEV_EDIT_EXTERNAL_ROOT`: host root corresponding to container `/external`.
- `HEV_EDIT_SECRET`: random shared secret, also injected into chat.
- `HEV_EDIT_PROMO_SCRIPTS`: absolute path to reviewed TWC `promo/scripts` on main.
- `HEV_EDIT_VIDEO_SKILL`: absolute path to the video skill.
- `HEV_EDIT_SOURCE_CONTAINER`: optional existing container with originals mounted
  read-only at `/external`. When set, stage private original copies through
  `docker exec cat` before launching the editor; this supports macOS LaunchAgents
  without granting removable-volume access. `HEV_EDIT_DOCKER_CONTEXT` selects
  its Docker context. No container or volume is created or changed.
- `HEV_EDIT_DISPATCH`: kit executable path, defaults to `hev`.
- `HEV_EDIT_DISPATCH_REPO`: admitted internal-disk scratch repo, defaults to
  `edit-scratch` (main branch). See setup below.
- `HEV_EDIT_PORT`: defaults to 2291; `HEV_EDIT_BIND` defaults to `127.0.0.1`.
- `HEV_EDIT_BUFFER_ENABLED`: unset by default. Only set `1` after the TWC
  integration has merged and been checked out in the configured main checkout.

Chat additionally needs `HEV_EDIT_URL` (Colima host gateway URL) and the same
`HEV_EDIT_SECRET`. Verify gateway connectivity before deploying; the host
listener must remain loopback. Secrets for R2 and Buffer are resolved by sourcing
`~/shell/op-env.sh` at the pipeline step, never written to a job brief or source.

`npm test --prefix hev-edit`; `npm start --prefix hev-edit`.

Jobs persist atomically in `<root>/<uuid>/job.json`; worker logs and briefs are
private. Each revision records `dispatchRun` in job.json and progress entries.
Inspect it with `hev dispatch logs NAME --host mini`, attach with
`hev dispatch attach NAME --host mini`, or stop with
`hev dispatch stop NAME --host mini`. One Codex worker runs at a time, with `gpt-6.1-sol`, using the video skill.
Editing jobs reattach to their recorded live kit run on restart; completed runs
continue output collection. Missing/ended unsuccessful runs fail. Other interrupted
active states fail as before so uploads/drafts are never silently repeated. Queued jobs resume. Inspect the private worker log before a
revision. A revision retains the job ID and increments its revision/dedupe key.
It renders a new preview; only an explicit Publish request creates a Buffer draft. Previous drafts are retained.

States: queued → editing → rendered → uploading → drafted, or failed from any
active state. With Buffer disabled, a job stays uploading with an explicit R2
completion note. It can be revised after the queue is idle. There is a draft-only `/jobs/:id/publish` endpoint; there is no public publish,
queue, schedule, or arbitrary-command endpoint. Output files and R2 uploads are
retained for review; this service does not implement retention deletion.


## Resolve handoff

Use **Open in Resolve** on a rendered revision. The card tracks the queued/building/ready/failed state. Copy `resolve-open JOB REVISION` on the laptop (install `hev-edit/bin/resolve-open`), or use **Download for Resolve**. Unzip into `~/Movies/hev-video/`, then File → Import Project → the `.drp`. Import `captions.srt` as subtitles; titles and captions remain editable text. The FCPXML is a timeline fallback. Original media and up to four unused theme clips travel with the project; extras are in an Extras bin. No publishing occurs.

## Kit setup on the mini

The launcher must run on the mini with kit configured `[hosts.mini] local = true`.
Use an admitted repo on the internal disk: `~/workspace/media` points onto
`/Volumes/EXTERNAL`, which SSH/tmux workers cannot reliably read. Do not move it.
Default `edit-scratch` is a proposed private scratch repo, not an assumed existing
admission. Create a tiny private remote named `edit-scratch` with a committed `main` branch, then run
`hev admission add PRIVATE_GIT_URL --host mini` with the host's
workspace configured on the internal disk. Check `hev admission ls --host mini`
and confirm the resolved path is internal before starting the launcher. Override
`HEV_EDIT_DISPATCH_REPO` for a different admitted internal-disk repo.

Orders live privately at `<HEV_EDIT_ROOT>/<uuid>/order-N.md`. Kit creates its
incidental worktree/branch; the editor is instructed to work only in the absolute
job dir and never commit, push, create a branch or open a PR. It checks original
readability and video tools before editing. The original editing prompt and
output names are unchanged. Kit bounds each run to 180 minutes and host capacity;
capacity exhaustion keeps the local job queued with 1–30 second exponential
backoff. The local queue remains held, so only one editing worker can run.
After output validation, `hev dispatch clean` removes the incidental worktree
while retaining the run record. Cleanup failures appear in private progress for
administrator review and do not discard a finished edit.

Keep `HEV_EDIT_ROOT` and revision media staging on the internal disk. Retain
`HEV_EDIT_SOURCE_CONTAINER` when LaunchAgent volume access requires it (board
#377); verify the tmux worker can read those staged bytes. Kit workers inherit
kit's configured host environment, not arbitrary launcher environment variables:
install/expose ffmpeg, ffprobe, whisper and the video skill dependencies through
that host's normal worker PATH/configuration. Confirm them in a real dispatched
worker before accepting deployment. No permissions or container changes are needed.

On Linux test hosts, the existing Resolve integration tests also require ffmpeg
on PATH and `HEV_EDIT_TEST_KIT` pointing at the video skill's `kit` directory.
