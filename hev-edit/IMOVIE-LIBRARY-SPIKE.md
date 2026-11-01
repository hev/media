# Native iMovie library handoff

The portable-library path worked on iMovie 10.4.3 on Apple Silicon. A new
library built through iMovie's UI reopened from a different path with three
ordered, independently editable clips, a native title, and four extra clips
in its event. This is a manual spike, not an automated endpoint implementation.
Private footage, libraries, screenshots, and the detailed run report stay on
the mini under `~/jobs/media-imovie-library-spike-20261101/`.

## Reproduce

1. Reserve the shared mini desktop through peers. Resolve permission prompts
   through the operator. Create a new library using File → Open Library → New;
   save it in a dedicated job directory. Never use an existing family library.
2. Open that exact library before importing. Select its event explicitly:
   an import dialog can otherwise default to an event in another open library.
   Import the kit's numbered clips and extras, excluding the reference preview.
3. Create a movie. Select each numbered source in filename order. Read its
   Accessibility range-selection start before changing it: native source time
   can have a nonzero origin, even when the exported media file starts at zero.
   Set the selected range to `origin + in - range.start` through
   `origin + out - range.start`, then append with E.
4. Verify the actual timeline after every append. For the acceptance fixture,
   starts were 0, 2, and 4 seconds and each clip displayed 2.00 seconds. Native
   timecode ended at `00:00:06:00`; AX seconds ended at approximately 6.01.
   Do not treat rounded duration-field text as frame-accurate evidence.
5. Add an iMovie title from Titles. The tested Slide title accepts editable
   text; extend it over the intended range. Return to Projects to name/save the
   project, then reopen it and inspect the result.
6. Capture the built timeline, quit iMovie, and inspect the bundle read-only.
   All expected source files must be regular media files under Original Media,
   with hashes matching the kit. Reject links escaping the bundle. The tested
   `.fcpcache -> .` link is internal. No private database edits are needed.
7. Copy the closed bundle with `ditto`, open the copy, verify its sidebar path,
   play the timeline, and capture it. Inspect open media paths with `lsof` to
   confirm playback uses the copy's media. Verify extras remain in the event.
   Quit before producing the final ZIP with `ditto -c -k --sequesterRsrc
   --keepParent`.

The fixture's seven media files totaled 567,555,781 bytes; the closed library
was 569,754,344 logical bytes (about 544 MiB allocated). The recorded build
took 302 seconds, including an import permission interruption but excluding
the initial permission wait. A local APFS copy took 0.328 seconds; this is
not a network-transfer estimate. Laptop opening remains a separate check.

## Unreliable steps

- `imovie-cli imovie status` returned `ui_accessible: false` with System Events
  timeout `-1712`. It was not rerun until green. Native CUA access later worked
  after prompts cleared; that does not turn the failed CLI check into a pass.
- CUA import observation returned `noWindowsAvailable`, then `timeoutReached`
  while an iMovie Desktop access prompt was up. A later observation succeeded
  after the permission state changed. Treat this observation as flaky under
  permission sheets, not as an initially passing check.
- AX presses did not reliably focus the title timeline item; a click at its
  observed screen position did. Verify selection before editing duration.
- Setting a native duration to an integer could leave it one frame short.
  On this fixture, entering 2.033333 and 6.033333 produced the intended two-
  and six-second timecodes. These are observed corrections, not general timing
  constants. A production worker needs rate-aware calibration and assertions.
- Foreground Chrome windows interrupted the session. Desktop ownership and
  foreground checks must be enforced throughout, not just at launch.

## Mobile sample path

The mini's Mac App Store search offered desktop iMovie under Mac Apps, but
did not offer Apple iMovie under iPhone & iPad Apps. The public [mobile
listing](https://apps.apple.com/us/app/imovie/id377298193) also listed only
iPhone/iPad compatibility. No install, new sign-in, purchase, or app update
was performed. This path did not supply a genuine mobile project sample.

Mac iMovie's observed File → Share choices were Email, Social Platforms,
Image, and File. File → Import iMovie iOS Projects is an importer, not an
exporter. No mobile-project export was found. Apple's documented [file
export](https://support.apple.com/guide/imovie/export-a-movie-trailer-or-clip-as-a-file-move6e0cb2ad/mac)
is a rendered movie. Spike 1's guessed mobile keys remain unvalidated.

## Endpoint sketch only

Keep the existing manual kit usable. An explicit native-library request
would enqueue a job keyed by job ID, revision, and installed iMovie version.
The authenticated kit endpoint would return queued/running/blocked/ready
status, then an authorized download of `<job>.imovielibrary.zip` when ready.
Do not hold an HTTP request open for desktop work.

A mini launcher would consume one job at a time under a shared-desktop lock,
checking peers, login/unlocked state, foreground app, and permissions. If busy,
leave the request queued and expose the reason; never steal focus or dismiss
permissions. If interrupted mid-build, mark the scratch library incomplete,
release the desktop, and resume only after inspecting state. Do not publish
an archive from an unverified build. Use per-job libraries, consolidate/copy
media, close iMovie, audit files, reopen a fresh copy, verify clip order/ranges,
title, extras, and media resolution, then close and archive atomically. Cache
only successful artifacts for that revision. Retain the manual kit on failure.

This needs a supported native builder and acceptance automation before it can
be offered as a reliable product feature. The spike demonstrates the artifact
handoff, not unattended desktop scheduling.
