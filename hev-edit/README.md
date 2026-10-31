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
- `HEV_EDIT_CODEX`: optional executable, defaults to `codex`.
- `HEV_EDIT_PORT`: defaults to 2291; `HEV_EDIT_BIND` defaults to `127.0.0.1`.
- `HEV_EDIT_BUFFER_ENABLED`: unset by default. Only set `1` after the TWC
  integration has merged and been checked out in the configured main checkout.

Chat additionally needs `HEV_EDIT_URL` (Colima host gateway URL) and the same
`HEV_EDIT_SECRET`. Verify gateway connectivity before deploying; the host
listener must remain loopback. Secrets for R2 and Buffer are resolved by sourcing
`~/shell/op-env.sh` at the pipeline step, never written to a job brief or source.

`npm test --prefix hev-edit`; `npm start --prefix hev-edit`.

Jobs persist atomically in `<root>/<uuid>/job.json`; worker logs and briefs are
private. One Codex worker runs at a time, with `gpt-6.1-sol`, using the video skill.
Interrupted active jobs become failed on restart so uploads/drafts are never
silently repeated. Queued jobs resume. Inspect the private worker log before a
revision. A revision retains the job ID and increments its revision/dedupe key.
It creates a new draft; previous human-reviewed drafts are not deleted.

States: queued → editing → rendered → uploading → drafted, or failed from any
active state. With Buffer disabled, a job stays uploading with an explicit R2
completion note. It can be revised after the queue is idle. There is no publish,
queue, schedule, or arbitrary-command endpoint. Output files and R2 uploads are
retained for review; this service does not implement retention deletion.
