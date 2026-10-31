import * as sdk from '@immich/sdk';
import type { sessionOptions } from './immich.js';
type Options = ReturnType<typeof sessionOptions>;
const object = { type: 'object' as const, additionalProperties: false };
export const editTools = [
  {
    name: 'start_edit',
    description:
      'Start a video edit ONLY after showing the asset shortlist and receiving explicit confirmation in the latest user message. Admin only. Returns an edit job.',
    input_schema: {
      ...object,
      properties: {
        assetIds: { type: 'array', items: { type: 'string' } },
        brief: { type: 'string' },
        length: { type: 'number', description: 'Seconds, 1–60, default 30' },
        caption: { type: 'string' },
      },
      required: ['assetIds', 'brief', 'caption'],
    },
  },
  {
    name: 'edit_status',
    description:
      'Read an edit job status. Omit id to list existing jobs and their IDs before selecting one for revision. Admin only.',
    input_schema: {
      ...object,
      properties: { id: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'revise_edit',
    description:
      'Revise an existing edit after the user requests a change. Renders a new revision for review. Buffer drafts require the Publish button.',
    input_schema: {
      ...object,
      properties: { id: { type: 'string' }, change: { type: 'string' } },
      required: ['id', 'change'],
    },
  },
];
export async function launcher(path: string, init: RequestInit = {}) {
  const url = process.env.HEV_EDIT_URL,
    secret = process.env.HEV_EDIT_SECRET;
  if (!url || !secret) throw Error('Video editing is not configured');
  return fetch(url + path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${secret}` },
  });
}
export async function requireAdmin(options: Options, api = sdk) {
  if (!(await api.getMyUser(options)).isAdmin)
    throw Error('Video edits are available to administrators only.');
}
export async function runEditTool(
  name: string,
  input: any,
  options: Options,
  confirmed: boolean,
  api = sdk,
  request = launcher,
) {
  await requireAdmin(options, api);
  const spec = editTools.find((t) => t.name === name);
  if (
    !spec ||
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !(k in spec.input_schema.properties))
  )
    throw Error('Invalid edit arguments');
  let path = '/jobs',
    body: any;
  if (name === 'start_edit') {
    if (!confirmed)
      throw Error(
        'Show the shortlist and ask the user to confirm before starting.',
      );
    if (
      !Array.isArray(input.assetIds) ||
      input.assetIds.length < 1 ||
      input.assetIds.length > 20 ||
      input.assetIds.some(
        (id: unknown) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id),
      ) ||
      typeof input.brief !== 'string' ||
      !input.brief.trim() ||
      input.brief.length > 8000 ||
      typeof input.caption !== 'string' ||
      input.caption.length > 2200 ||
      !Number.isFinite(input.length ?? 30) ||
      (input.length ?? 30) < 1 ||
      (input.length ?? 30) > 60
    )
      throw Error('Invalid edit brief');
    const assets = [];
    for (const id of input.assetIds) {
      const asset = await api.getAssetInfo({ id }, options);
      if (
        asset.type !== 'VIDEO' ||
        !asset.originalPath?.startsWith('/external/')
      )
        throw Error('Select original videos in the external library.');
      assets.push({ id: asset.id, originalPath: asset.originalPath });
    }
    body = {
      assets,
      brief: input.brief,
      length: input.length ?? 30,
      caption: input.caption,
    };
  } else {
    if (name === 'edit_status' && input.id === undefined) {
      const response = await request('/jobs');
      if (!response.ok)
        throw Error('The edit service could not accept this request.');
      return response.json();
    }
    if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.id))
      throw Error('Invalid job id');
    path += '/' + input.id;
    if (name === 'revise_edit') {
      if (
        typeof input.change !== 'string' ||
        !input.change.trim() ||
        input.change.length > 8000
      )
        throw Error('Invalid revision');
      path += '/revise';
      body = { change: input.change };
    }
  }
  const response = await request(
    path,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {},
  );
  if (!response.ok)
    throw Error('The edit service could not accept this request.');
  return response.json();
}
