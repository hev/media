# iMovie iOS project spike

Verdict: **doesn't deliver a verified editable iMovie timeline**. This is an
experimental archive generator, not an implementation of Apple's project schema.
Do not add its output to the handoff kit as a working project.

```
node hev-edit/imovie-project.mjs /private/job/cut.json /private/job/test.iMovieMobile --experimental
node --test hev-edit/imovie-project.test.mjs
```

The generator preserves clip order and source trim metadata in `hev-timeline.json`,
re-encodes each trim into `Assets/0000.mp4` etc. (retaining source audio unless
`audio: false`), and creates a ZIP with `iMovieMobileProject.plist`. The plist's
`name`, `clips`, `media`, `start`, `duration`, and `audio` keys are **guesses**.
`HEVUnverifiedSchema` records that fact inside the archive. Syntax validity does
not establish importer compatibility. Overlays/captions survive only as manifest
metadata. Titles, transitions, separate music, crop/focus, and native audio
behavior are unimplemented. Existing outputs are refused; failed builds clean
up their temporary media. Source files are read only.

## Findings and evidence

- Apple's [Mac import guide](https://support.apple.com/en-gb/guide/imovie/mov6c9c43596/mac)
  documents File → Import iMovie iOS Projects, destination library selection,
  and Import. It warns newer mobile projects can fail to import.
- Apple's [iPhone project export guide](https://support.apple.com/en-euro/guide/imovie-iphone/knaf0c276dc0/ios)
  documents exporting the project and media together. This is a mobile-side
  export path; no Mac-to-iOS project export was established in this spike.
- Local iMovie 10.4.3 `Flexo.framework` contains the literal filenames
  `iMovieMobileProject.plist` and `iMovieMobileHoldme.plist`. That establishes
  filenames only, not required keys or the Holdme file's semantics.
- No sample `.iMovieMobile`/`.imovietrailer` was found under Movies, jobs,
  or Downloads. Web and GitHub repository searches found no usable schema or
  sample. No genuine minimal variants were available to diff. None of the
  candidate's timeline keys should be mistaken for reverse-engineered facts.
- imovie-cli reference was cloned into the private job directory; doctor passed.
  Its renderer and project JSON are separate from Apple's native project format.
- Native testing was blocked before launch by an existing Automation permission
  dialog (`python3.15` requesting control of `Codex Computer Use`). Per the
  computer-use skill it was neither dismissed nor granted. No existing iMovie
  library was opened or modified, and no throwaway library was created.

## Acceptance limits and next experiment

There is no imported-timeline screenshot and no native pass. The private job
contains `initial.png` showing the blocker, `beach-candidate.iMovieMobile`, its
extracted contents, and `media-check.json`. Footage is never committed.

Once the desktop is available, first obtain genuine iPhone/iPad exports of
one clip, then two clips, a nonzero trim, title, transition and muted audio.
Compare decoded plists (including binary archives, if any) and media references
before replacing guessed keys. Create a new `spike.imovielibrary` through iMovie,
close other libraries, and use the documented iOS import menu. Capture the
resulting timeline and verify individual clip durations and audio.

One-click handoff through double-click or `open -a iMovie file.iMovieMobile`
has **not** been tested. Only the menu route is documented here; do not promise
one-click handoff. Version risk is high: this is an undocumented format and even
Apple warns about compatibility between official versions. Keep a known-good
sample and repeat native acceptance after iMovie updates.
