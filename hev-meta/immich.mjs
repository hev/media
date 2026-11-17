// Minimal Immich API calls. Every call carries an explicit identity: the
// caller's session token for HTTP requests, or the scoped API key for the CLI
// and the new-video poller.
import { ASSET_ID } from "./core.mjs";

export class SessionError extends Error {}

export function sessionAuth(headers) {
  const bearer = headers.authorization;
  let token = typeof bearer === "string" && /^Bearer \S+$/i.test(bearer) ? bearer.slice(7) : undefined;
  const cookie =
    typeof headers.cookie === "string"
      ? headers.cookie
          .split(";")
          .map((p) => p.trim())
          .find((p) => p.startsWith("immich_access_token="))
      : undefined;
  if (!token && cookie) {
    try {
      token = decodeURIComponent(cookie.slice("immich_access_token=".length));
    } catch {
      throw new SessionError();
    }
  }
  if (!token || /[\r\n]/.test(token)) throw new SessionError();
  return { Authorization: `Bearer ${token}` };
}
export const keyAuth = (key) => {
  if (!key) throw Error("HEV_META_IMMICH_API_KEY is not configured");
  return { "x-api-key": key };
};

export async function api(base, auth, path, init = {}, fetcher = fetch) {
  const response = await fetcher(base + path, {
    ...init,
    headers: { ...init.headers, ...auth, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (response.status === 401) throw new SessionError();
  if (!response.ok) throw Error(`Immich ${response.status}`);
  return response.json();
}

export const me = (base, auth, f) => api(base, auth, "/users/me", {}, f);
export async function asset(base, auth, id, f) {
  if (!ASSET_ID.test(id)) throw Error("Invalid asset id");
  return api(base, auth, `/assets/${id}`, {}, f);
}
export async function assetByPath(base, auth, originalPath, f) {
  const result = await api(base, auth, "/search/metadata", { method: "POST", body: JSON.stringify({ originalPath, size: 10 }) }, f);
  return result.assets.items.find((a) => a.originalPath === originalPath);
}
// Videos whose Immich record was created after the high-water mark.
export async function newVideos(base, auth, after, f) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const result = await api(
      base,
      auth,
      "/search/metadata",
      { method: "POST", body: JSON.stringify({ type: "VIDEO", createdAfter: after, size: 250, page }) },
      f,
    );
    found.push(...result.assets.items.filter((a) => Date.parse(a.createdAt) > Date.parse(after)));
    if (!result.assets.nextPage) break;
  }
  return found;
}
// Only external-library originals are transcribed.
export function eligible(a) {
  if (!a || !["VIDEO", "AUDIO"].includes(a.type) || !a.originalPath?.startsWith("/external/") || !a.checksum)
    throw Error("Only external-library videos can be transcribed");
  return { assetId: a.id, checksum: a.checksum, originalPath: a.originalPath };
}
