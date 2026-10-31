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

## Read-only photo chat

`/chat` streams a transcript and photo results from the separate `hev-chat/`
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
  private Compose network as Immich. No volume or database is needed.

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
