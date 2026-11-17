# hev-meta: local transcripts

hev-meta is the metadata service HEV-MEDIA.md reserves: it owns annotations
outside Immich's browsing index. It transcribes external-library videos on
the host with whisper.cpp (Metal) and stores the results beside the library
and in a local SQLite index. Immich's database, API and media processing are
unchanged.

Run it on the mini with Node 24 or newer. There are no npm dependencies.

## Engine

- `whisper-cli` (Homebrew whisper.cpp) with `ggml-large-v3-turbo.bin`.
- Silero VAD (`ggml-silero-v5.1.2.bin`, from `ggml-org/whisper-vad`), so
  silent GoPro or drone footage does not produce hallucinated text.
- `-l auto` language detection, `-ml 84 -sow` caption-sized segments. Segment
  times are VAD-remapped by whisper.cpp. Word timestamps are not stored:
  whisper.cpp 1.9.5 does not remap token offsets through VAD.
- An optional per-asset vocabulary prompt (names, terms) is passed as
  whisper's initial prompt. Whisper still prefers common spellings
  ("Megan"), so a small spelling pass replaces capitalized near-misses of
  capitalized vocabulary words of five or more letters. The original text is
  kept as `raw` on changed segments.
- ffmpeg and whisper run under `taskpolicy -b` (background CPU, GPU and I/O
  priority) so editing on the mini keeps priority. One asset runs at a time.

## Pipeline per asset

1. Look up the asset in Immich: the caller's session (HTTP) or the scoped API
   key (CLI, poller). Only external-library videos with a checksum qualify.
2. Extract 16 kHz mono WAV to a private temp dir on the internal disk. Set
   `HEV_META_SOURCE_CONTAINER` (and `HEV_META_DOCKER_CONTEXT`) to decode
   through the existing read-only `/external` container mount, as hev-edit
   does: LaunchAgents cannot reliably read the removable volume (board #377).
   Without it, ffmpeg reads the mapped host path directly.
3. Run whisper, write `transcript.json`, `transcript.vtt` and `transcript.srt`
   atomically under `HEV_META_TRANSCRIPTS/<assetId>/`, index the segments,
   then delete the temp audio.

`transcript.json` records the asset ID, Immich checksum, language and its
probability, model, VAD model, engine version, prompt, audio duration,
elapsed time and segments (`start`, `end` in seconds, `text`).

## Store

`HEV_META_DATA/meta.sqlite` (internal disk) holds the queue, the transcripts
(including their JSON, so reads never touch the external disk) and an FTS5
index over segment text keyed by asset ID and segment start/end. Transcripts
are keyed by Immich asset ID and the original's checksum: a request for a
current checksum is a logged no-op; a changed checksum re-transcribes.

## Commands

```sh
hev-meta transcribe ASSET_ID [--prompt "Name, Term"] [--force] [--queue]
hev-meta transcribe --path /Volumes/EXTERNAL/Trip/clip.mp4
hev-meta search vibe coding
hev-meta status
hev-meta poll-init            # record the new-video high-water mark (install)
hev-meta serve                # HTTP API + queue worker + optional poller
```

`transcribe` queues the asset and runs it in the foreground when nothing else
is transcribing; otherwise it waits for the worker. `--queue` only queues.

## HTTP API

Loopback only (`HEV_META_BIND`, default `127.0.0.1`; `HEV_META_PORT`, default
2292). Every request except `GET /health` validates the caller's Immich
session (bearer token or `immich_access_token` cookie) with `/users/me` and
reads the asset as that caller.

- `GET /transcripts/:assetId`: `{state: none|queued|running|failed|done,
  position?, transcript?}`. A transcript is returned only for the asset's
  current checksum. `?format=vtt` or `?format=srt` returns captions.
- `POST /transcripts/:assetId` `{prompt?, force?}`: administrators only;
  queues a transcript (idempotent).

No paths, tokens or upstream errors are returned or logged. hev-chat reaches
it at `HEV_META_URL` (the Colima host gateway, like `HEV_EDIT_URL`) and
forwards only the caller's session. To route it on the tailnet like hev-chat:

```sh
tailscale serve --bg --https=2283 --set-path=/hev-meta http://127.0.0.1:2292
```

## New-video poller

`HEV_META_POLL=600` polls every ten minutes for videos whose Immich record was
created after the stored high-water mark. Without a mark the poller does
nothing, so it can never enqueue the existing library: run
`hev-meta poll-init` once at install. There is no library backfill.

## Configuration

| Variable | Default |
| --- | --- |
| `HEV_META_DATA` | `~/.local/share/hev-meta` |
| `HEV_META_TRANSCRIPTS` | `/Volumes/EXTERNAL/.immich/hev-meta/transcripts` |
| `HEV_META_EXTERNAL_ROOT` | `/Volumes/EXTERNAL` (container `/external`) |
| `HEV_META_IMMICH_URL` | `http://127.0.0.1:2283/api` |
| `HEV_META_IMMICH_API_KEY` | scoped key (`asset.read`, `user.read`, `library.read`) for CLI and poller |
| `HEV_META_MODEL`, `HEV_META_VAD_MODEL` | `~/video/models/ggml-large-v3-turbo.bin`, `~/video/models/ggml-silero-v5.1.2.bin` |
| `HEV_META_WHISPER` | `whisper-cli` |
| `HEV_META_SOURCE_CONTAINER`, `HEV_META_DOCKER_CONTEXT` | unset, `default` |
| `HEV_META_POLL` | `0` (off) |

Keep the API key in the private deployment env file (mode 600) beside
hev-edit's, never in this repository.

## LaunchAgent

`launchd.plist.example` runs `hev-meta serve` from a launcher script that
sources the private env file. Install it as
`~/Library/LaunchAgents/com.hev.media-meta.plist`, then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hev.media-meta.plist
launchctl print gui/$(id -u)/com.hev.media-meta
```

`npm test --prefix hev-meta` runs the unit tests (no Immich, model or network).
