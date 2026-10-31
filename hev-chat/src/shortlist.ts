type Asset = {
  id: string;
  originalFileName?: string;
  localDateTime?: string;
  type?: string;
};
export class Shortlists {
  private sessions = new Map<string, { assets: Asset[]; expires: number }>();
  remember(session: string, assets: Asset[]) {
    const previous = this.get(session);
    const merged = new Map(previous.map((asset) => [asset.id, asset]));
    for (const asset of assets) merged.set(asset.id, asset);
    this.sessions.set(session, {
      assets: [...merged.values()].slice(-200),
      expires: Date.now() + 30 * 60 * 1000,
    });
    for (const [key, value] of this.sessions)
      if (value.expires < Date.now()) this.sessions.delete(key);
  }
  get(session: string) {
    const entry = this.sessions.get(session);
    return entry && entry.expires > Date.now() ? entry.assets : [];
  }
  consume(
    session: string,
    shown: Asset[],
    ids: unknown,
    latest: string,
    hadAssistant: boolean,
  ) {
    if (
      !hadAssistant ||
      !/^(yes[,.! ]*|confirm(?:ed)?[,.! ]*|go ahead[,.! ]*|start the edit[,.! ]*|make the reel[,.! ]*)$/i.test(
        latest.trim(),
      ) ||
      !Array.isArray(ids) ||
      !ids.length ||
      !this.sessions.has(session) ||
      !ids.every((id) => shown.some((asset) => asset.id === id))
    )
      return false;
    this.sessions.delete(session);
    return true;
  }
}
