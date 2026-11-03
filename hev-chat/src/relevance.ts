import { relevantAssets } from './ux.js';
import type { sessionOptions } from './immich.js';
// Re-score authenticated thumbnails locally. Immich's public search response omits CLIP distances.
// Cache vectors only, never original footage; all inference remains on the private Compose network.
const vectors = new Map<string, number[]>();
async function encode(value: string | Blob, model: string) {
  const form = new FormData();
  const kind = typeof value === 'string' ? 'textual' : 'visual';
  form.append(
    'entries',
    JSON.stringify({ clip: { [kind]: { modelName: model } } }),
  );
  form.append(typeof value === 'string' ? 'text' : 'image', value);
  const response = await fetch(
    process.env.HEV_ML_URL ?? 'http://immich-machine-learning:3003/predict',
    { method: 'POST', body: form, signal: AbortSignal.timeout(45000) },
  );
  if (!response.ok) throw Error('Local relevance unavailable');
  const result = (await response.json()) as any;
  const vector =
    typeof result.clip === 'string' ? JSON.parse(result.clip) : result.clip;
  if (!Array.isArray(vector) || !vector.every(Number.isFinite))
    throw Error('Invalid CLIP vector');
  return vector as number[];
}
export async function rerank(
  query: string,
  assets: any[],
  options: ReturnType<typeof sessionOptions>,
) {
  const model = process.env.HEV_CLIP_MODEL ?? 'ViT-B-32__openai';
  const text = await encode(query, model);
  const ranked = [];
  for (const asset of assets) {
    const key = model + ':' + asset.id;
    let vector = vectors.get(key);
    if (!vector) {
      const response = await fetch(
        `${options.baseUrl}/assets/${asset.id}/thumbnail?size=thumbnail`,
        { headers: options.headers, signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) continue;
      vector = await encode(await response.blob(), model);
      if (vectors.size > 2000) vectors.clear();
      vectors.set(key, vector);
    }
    if (vector.length !== text.length) throw Error('CLIP model mismatch');
    const dot = vector.reduce((sum, n, i) => sum + n * text[i], 0);
    const norm = Math.sqrt(
      vector.reduce((s, n) => s + n * n, 0) *
        text.reduce((s, n) => s + n * n, 0),
    );
    ranked.push({ ...asset, distance: 1 - dot / norm });
  }
  return relevantAssets(ranked);
}
