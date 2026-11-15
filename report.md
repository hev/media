# Finished edit downloads

Requested by local:hev.

Deployed application revision: `d9d1bdcce1663253d4e482f51bee785679b6d79c`. Target branch: `brand/hev-media`. PR: pending creation.

`/open` (and `/open 2`) selects the thread's latest job and a rendered revision without inference. The existing Resolve builder supplies its progress and authenticated download. Job ordering follows the thread, including after launcher restarts. The sidebar puts Download edit and Files used before revision settings. Source entries link to the normal Immich photo/asset route and show capture date, duration in seconds and each used in/out range.

The same cached per-revision Resolve ZIP now includes the immutable rendered revision as `final.mp4`, originals under `media/`, native DRP, `timeline.fcpxml`, `captions.srt` and opening/file-list instructions in `README.txt`. Legacy archives require an explicit rebuild before download. Successful complete builds are atomically renamed into place; idle, building, failed and obsolete archives are unavailable for download. Existing limits remain: 20 selected sources, 60-second edit target, up to four related video extras and finite 180-second build commands. Full originals are included, so packages can be several GB; the UI says so. No smaller ZIP cap was invented.

## Acceptance

- Chat: 29/29 tests passed on the final server change; TypeScript check passed. Logs: `../chat-test-latest-order.log`, `../chat-check-order.log`. HTTP test **/open ready, building and no edit; downloads enforce admin and ownership including Range; setup starts exactly once** exercises deterministic ready/building/no-render behavior, reversed launcher ordering, unauthenticated access, nonadmin and other-owner rejection, including Range requests. Slash parsing covers revision arguments.
- Launcher: 37/37 passed, including existing Resolve/iMovie, dispatch and Buffer gate checks. Log: `../edit-test-release.log`. New tests **portable package includes immutable final, originals, native project, interchange, captions and file manifest** and **legacy cached ZIP cannot be served as a complete download package** cover actual ZIP creation and obsolete-cache refusal. No Node test failed or was rerun unchanged to chase green.
- Final web: Svelte check zero errors/warnings, TypeScript and production build passed. Logs: `../web-svelte-sidebar-fix.log`, `../web-types-sidebar-fix.log`, `../web-build-sidebar-fix.log`. The initial failed check is separately retained below.
- Live corrected candidate: [UAT 286](http://100.126.12.95:8800/#uat/286), **Open a finished edit and download its complete portable package**, passed on the deployed revision above. In the existing authorized job's thread, `/open` showed Download edit; `/open 1` reused the ready cache. The sidebar source name, capture date and all nine used ranges matched Immich and the immutable cut; numeric source duration displayed seconds. No browser page errors. No new edit jobs or Buffer actions.
- Downloaded the full approximately 2.8 GB ZIP through the browser's authenticated Download edit link. `unzip -t` passed. Required entries and README name/date/range/opening instructions were asserted. File list and full private source evidence remain on the mini, not in this repository.
- Deployed launcher copies match the candidate bytes. Both application containers are healthy; supporting services were not recreated.

Private evidence root: `/Users/hev/jobs/media-open-edit-20261115/`. Screenshots `02-download-and-files.png` and `03-ready-cached.png`; immutable run evidence under `evidence-002/` (recording, final screenshot, copied flow and result JSON). ZIP entry list: `zip-list.txt`; used-source metadata: `files-used.json`; downloaded instructions: `README.txt`. Studio recordings for UAT 285 and 286 were separately opened in a mini browser and playback advanced with video frames; `playback-285.json`, `playback-286.json` and matching screenshots retain that verification.

## Named failures / flaky or setup-dependent checks

These are not clean initial passes and have not been erased or relabeled.

1. **npm run check:svelte --prefix web** initially failed with 2,235 module-resolution errors because this fresh worktree lacked generated SvelteKit configuration. Retained log: `../web-svelte.log`. Ran `svelte-kit sync` to correct that setup, then the configured check passed. Treat the initial invocation as a failed/setup-dependent check, not an initially green run.
2. **Open a finished edit and download its complete portable package**, first run [UAT 285](http://100.126.12.95:8800/#uat/285), failed while waiting for the sidebar link. This was a real inherited sidebar defect, not harness timing: `settingsFor` mutated Svelte state during rendering, producing `state_unsafe_mutation` and a blank sidebar. Diagnostic evidence: `diagnostic.json`, `diagnostic.png`, and `evidence-001/`. Rolled back the deployment. Commit `d9d1bdcce` moves draft initialization into data/event handlers and corrects duration units. Only after that actual code fix and new web checks/build was UAT 286 run. The failed/flaky check remains reported by name; the passing corrected-candidate run does not turn UAT 285 into a pass.

## Deployment and rollback

Docker context `colima-immich`; live images `hev/media:open-edit-20261115` and `hev/media-chat:open-edit-20261115`. Tagged prior images before rollout as `hev/media:rollback-open-edit-20261115` and `hev/media-chat:rollback-open-edit-20261115`. Web image layers the compiled bundle on the prior deployed backend image. Only `immich-server` and `hev-chat` were recreated with `up -d --no-deps`. Launcher changes are limited to `resolve.mjs` and `server.mjs`, with the original launcher backed up at `/Users/hev/dispatch/media-open-edit-20261115/launcher.before/`. Restart readiness was checked through authenticated launcher requests and application health endpoints. No database access/mutation, migrations or Immich upgrades.

The retained rollback script restores the two image aliases, the prior compose file, and both launcher files, then restarts the launcher and recreates only the two application services. Run on the mini:

```sh
hev secrets run --caller media-open-edit-rollback \
  --env-file /Users/hev/.local/share/lab/immich/edit.env \
  --ref ANTHROPIC_API_KEY=op://layer-factory/hevmind-claude/credential \
  -- bash /Users/hev/dispatch/media-open-edit-20261115/rollback.sh
```

Underlying service command:

```sh
docker --context colima-immich compose --project-name lab-immich \
  --env-file /Users/hev/.local/share/lab/immich/.env \
  -f /Users/hev/.local/share/lab/immich/compose.yml \
  up -d --no-deps immich-server hev-chat
```

No functional blocker remains. The failed initial checks above remain part of the acceptance history.
