# Laptop Resolve handler

Run `./hev-edit/laptop/install.sh` from a checkout on the laptop. Requires Xcode command-line tools (`xcrun swiftc`). It builds an ad-hoc signed `~/Applications/hev Media.app`, registers `hevmedia://resolve/JOB/REV`, and installs `~/.local/bin/resolve-open`. No agent runs for a Resolve build or transfer.

The handler accepts only a canonical lowercase UUID and a positive revision of at most six digits. It launches the fixed script with separate arguments, never a shell command. `resolve-open` copies the ready archive from `mini` over SSH/SCP into `~/Movies/hev-video/<project-name>/`, preserving an existing local folder. `RESOLVE_HOST=localhost` uses local copy for mini acceptance. Sources remain private.

It asks macOS to open the `.drp` with DaVinci Resolve. If that cannot launch, it opens the folder and prints the import step: **File → Import Project → choose the .drp**. If Resolve launches but does not import, use that same step; macOS launch success alone cannot prove import. Import `captions.srt` separately as subtitles. Free Resolve has not been tested on the laptop; mini acceptance uses Studio.

Validate URLs without launching anything:

```
HEV_HANDLER_BINARY="$HOME/Applications/hev Media.app/Contents/MacOS/hev-media" node --test hev-edit/laptop/handler.test.mjs
```
