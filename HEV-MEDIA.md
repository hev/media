# hev / media

A small web-branding fork of [Immich](https://github.com/immich-app/immich),
based on **v3.3.1**, licensed under the upstream AGPL-3.0 license.

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
- App identity changes only; retain Immich credits, support links and licenses.
- No database schema, metadata storage, API or media-processing changes.
- Our future metadata service will own stable IDs and annotations outside the
  browsing index. It is not implemented by this branding change.

`hev/main` follows the deployed release plus our changes. Keep `upstream` pointed
at immich-app/immich, update deliberately by release, and test against that same
server release. Do not use the fork's unmodified upstream `main` for deployment.

## Web-only image

Build the SDK and web application from the lockfile, then layer `web/build` onto
the pinned upstream server image using `Dockerfile.hev`. The server code and
database version stay at v3.3.1. Deployment settings and private paths belong in
the private `hev/lab` repository, never in this public fork.

```sh
npx --yes pnpm@11.27.1 --filter immich-web... install --frozen-lockfile
npx --yes pnpm@11.27.1 --filter @immich/sdk build
npx --yes pnpm@11.27.1 --filter immich-web check:svelte
npx --yes pnpm@11.27.1 --filter immich-web check:typescript
IMMICH_BUILD=hev-media-v3.3.1 npx --yes pnpm@11.27.1 --filter immich-web build
docker build -f Dockerfile.hev --build-arg HEV_SOURCE_COMMIT="$(git rev-parse HEAD)" -t hev/media:v3.3.1 .
```

Select the intended Docker context explicitly when more than one is installed.
The Dockerfile-specific ignore file sends only the web output as build context.
