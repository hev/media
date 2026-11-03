# hev / media

A small web-branding fork of [Immich](https://github.com/immich-app/immich),
based on **v3.3.5**, licensed under the upstream AGPL-3.0 license.

The photo grid, navigation, rounded controls, responsive layouts and playback
remain upstream Immich. The hev palette, camera-head icon, wordmark, browser
icons and installable-app identity are the customization. Google's Photos-style
browsing is the reference behavior, not a new layout to redesign.

Brand guide: https://hevmind.com/brand/. The generated icon uses the existing
hev mascot head as a Gemini reference. Original output is retained under
`web/static/brand/`, with pixel-preserving exports for app icons. JetBrains Mono
is self-hosted for the wordmark and includes its OFL license. Upstream UI fonts
remain for the familiar browsing layout. Status/error colors keep their meaning.

## Keep the fork small

- `web/src/lib/branding/`: logo component and light/dark token overrides.
- The purchase prompt is removed by choice; Immich credits, About and licenses stay.
- No database schema, metadata storage, API or media-processing changes.
- Our future metadata service will own stable IDs and annotations outside the
  browsing index. It is not implemented by this branding change.

`hev/main` follows the deployed release plus our changes. Keep `upstream` pointed
at immich-app/immich, update deliberately by release, and test against that same
server release. Do not use the fork's unmodified upstream `main` for deployment.

## Web-only image

Build the SDK and web application from the lockfile, then layer `web/build` onto
the pinned upstream server image using `Dockerfile.hev`. The server code and
database version stay at v3.3.5. Deployment settings and private paths belong in
the private `hev/lab` repository, never in this public fork.

```sh
npx --yes pnpm@11.27.1 --filter immich-web... install --frozen-lockfile
npx --yes pnpm@11.27.1 --filter @immich/sdk build
npx --yes pnpm@11.27.1 --filter immich-web check:svelte
npx --yes pnpm@11.27.1 --filter immich-web check:typescript
IMMICH_BUILD=hev-media-v3.3.5 npx --yes pnpm@11.27.1 --filter immich-web build
docker build -f Dockerfile.hev --build-arg HEV_SOURCE_COMMIT="$(git rev-parse HEAD)" -t hev/media:v3.3.5 .
```

Select the intended Docker context explicitly when more than one is installed.
The Dockerfile-specific ignore file sends only the web output as build context.

The companion machine-learning image must also be pinned to
`ghcr.io/immich-app/immich-machine-learning:v3.3.5`.

## Original HEVC playback

Configure video transcoding through Immich's administrator settings or
`PUT /api/system-config`. The playback policy is `ffmpeg.transcode: required`
with `ffmpeg.acceptedVideoCodecs: [h264, hevc]`. These are runtime settings;
this web-only fork does not pin or override the server's configuration.

Required-only conversion ignores the target resolution for compatible originals,
so accepted 4K HEVC footage can play without a 720p H.264 copy. Keep the audio
and container compatibility checks enabled. ProRes, incompatible audio and
unsupported containers still need conversion or remuxing. Upstream v3.3.5 also
requires a pixel format ending in `420p` for direct playback; accepting HEVC
does not bypass its conversion of 10-bit pixel formats.

Existing encoded copies continue to take precedence in normal playback until
removed. Verify **Play original video** in the viewer in Safari and Chrome
before cleanup. For compatible, available, unedited originals, use Immich's
**Refresh encoded videos** asset action (`POST /api/assets/jobs` with
`name: transcode-video` and the selected `assetIds`). The upstream conversion
job re-evaluates the policy and removes an unnecessary encoded file together
with its `asset_file` record. Inventory the selected copies and their size
before running it; retain copies for incompatible or unavailable originals.
Do not delete encoded files by hand or edit database rows.

Edit and Resolve handoffs consume original external-library paths and stage
their own revision media. Before cleanup on any deployment, verify those flows
have no dependency on Immich's encoded copies.

## Read-only photo chat

`/chat/<threadId>` restores a persistent thread; `/chat` streams a transcript and photo results from the separate `hev-chat/`
Node service. It uses the caller's Immich session cookie or bearer token, validates
it with `/users/me`, and passes that identity to every SDK call. There is no service
API key and no media mutation tool. Search results open Immich's normal viewer.
Questions and selected metadata go to Anthropic; original photos are not uploaded.

Build from the repository root:

```sh
docker build -f hev-chat/Dockerfile -t hev/media-chat:v3.3.5 .
```

For local development, build `packages/sdk`, then run
`npm ci --prefix hev-chat`, `npm test --prefix hev-chat`, and
`npm run build --prefix hev-chat`. Start with `npm start --prefix hev-chat`.

Configure the companion container:

- `IMMICH_URL=http://immich-server:2283/api` (internal server URL, including `/api`).
- `ANTHROPIC_API_KEY` from the deployment secret store, injected at runtime only.
- `ANTHROPIC_MODEL` defaults to `claude-sonnet-5-5`; choose an available model
  for the deployment's Anthropic account if that identifier is unavailable.
- `PORT=2290` by default. Publish only to `127.0.0.1:<port>:2290`, on the same
  private Compose network as Immich. Mount a named volume at `/data` (owned by uid 1000). `HEV_CHAT_DATA` defaults to `/data` in the image. SQLite stores user-owned threads, transcripts, selections and job ownership there; back it up before recreation.

Route the service at the existing origin with:

```sh
tailscale serve --https=2283 --set-path=/hev-chat http://127.0.0.1:<port>
```

Serve strips the prefix; the service also accepts `/hev-chat/chat` for proxies
that preserve it. The browser posts only to `/hev-chat/chat`, with same-origin
cookies. Do not expose it on a separate browser origin or enable CORS. `/health`
is a simple unauthenticated liveness check; `/chat` always validates a session.
The service does not log requests, tokens, upstream errors or the Anthropic key.
An interrupted request cancels the model stream. Requests are limited to 32 KB,
20 transcript messages and eight model/tool rounds.

## Video edit drafts

Administrators can shortlist external-library videos, confirm in a later chat
turn, then launch an edit. `hev-edit/` is the private host launcher; its README
covers configuration, queue recovery, and the separate Buffer integration gate.
`start_edit`, `edit_status`, and `revise_edit` use the caller's session to check
administrator access. Paths travel only from chat to the authenticated launcher,
never to the model or browser. An admin session is checked on every preview
request, including byte ranges. The chat transcript shows updating edit cards
and a header list. Instagram posting remains a separate human action in Buffer.

Revisions retain their own previews. The Publish button sends only the chosen
revision to Buffer as a draft, once; rendering and revising never create drafts.
An ambiguous publish failure stays claimed for ledger inspection before recovery.

## Resolve handoff

Use **Open in Resolve** on a rendered revision. The card tracks the queued/building/ready/failed state. Copy `resolve-open JOB REVISION` on the laptop (install `hev-edit/bin/resolve-open`), or use **Download for Resolve**. Unzip into `~/Movies/hev-video/`, then File → Import Project → the `.drp`. Import `captions.srt` as subtitles; titles and captions remain editable text. The FCPXML is a timeline fallback. Original media and up to four unused theme clips travel with the project; extras are in an Extras bin. No publishing occurs.

## Chat search and edit setup

Visual search re-scores authenticated thumbnails with the local Immich ML service
(`HEV_ML_URL`, default internal `/predict`; `HEV_CLIP_MODEL`, default
`ViT-B-32__openai`, must match the library). No thumbnails leave the private
network. Results must be within 0.025 cosine distance of the best result and
below 0.78; a large score gap ends the result set. At most four assets per day
and 24 per response remain, with 12 initially visible. These are visual matches,
not a guarantee that every subject is present. If local scoring fails, chat
reports a search failure rather than displaying an unfiltered batch.

Use **Add to chat** in the asset viewer or timeline selection bar to add up to
20 owned assets to a recent thread or a new one. `/search`, `/edit`, `/revise`,
`/resolve`, and `/publish` wrap the existing actions. `/edit` opens the persisted
setup card; its shortlist and settings are the confirmation. Start edit or
“give it a go” starts the chosen edit. The worker checks both cut metadata and
actual output dimensions; Resolve reads those same cut dimensions.

Rendering and revision previews stay local. Only the explicit Publish action
uploads the selected revision and creates a Buffer draft for human review.

## Chat inspection and worker progress

Chat uses a fullscreen thread / conversation / edit layout; Edit details opens
as a sheet on narrow screens. Assistant Markdown uses an allowlist of text,
bold, inline code, lists and HTTP(S)/mailto links. It never renders raw HTML or
loads Markdown images. Tool steps persist executed inputs, candidate/filtered/
displayed counts and elapsed time with each assistant turn.

New threads have an explicit automatic-title marker. Search subjects become
video-style titles; edit setup can refine them until a manual rename. Legacy
threads are never automatically retitled. Natural assent only confirms the
latest pending setup; an intervening conversation turn consumes that scope.

The edit launcher persists worker state changes and reads each revision's
`progress-N.json` written atomically by the worker. Only recognized stages are
shown (reviewing, transcribing, cutting, rendering, reviewing frames); raw log
text, paths and arbitrary worker messages never enter the browser. The UI shows
the actual agent/model, elapsed time and finish/failure in the transcript and
sidebar. Resolve builds report their actual native builder states separately.
Polling copies histories into the thread without overwriting newer turns or
settings. Rendered revisions expose safe source IDs, cut durations and measured
output duration for the edit summary.
