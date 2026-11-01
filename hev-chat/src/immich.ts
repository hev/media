import * as sdk from '@immich/sdk';

export class SessionError extends Error {}

// Never set SDK globals: concurrent callers must retain their own identity.
export function sessionOptions(
  headers: Record<string, string | string[] | undefined>,
  baseUrl: string,
) {
  const bearer = headers.authorization;
  const cookie =
    typeof headers.cookie === 'string'
      ? headers.cookie
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('immich_access_token='))
      : undefined;
  let token =
    typeof bearer === 'string' && /^Bearer \S+$/i.test(bearer)
      ? bearer.slice(7)
      : undefined;
  if (!token && cookie) {
    try {
      token = decodeURIComponent(cookie.slice('immich_access_token='.length));
    } catch {
      throw new SessionError();
    }
  }
  if (!token || /[\r\n]/.test(token)) throw new SessionError();
  return { baseUrl, headers: { Authorization: `Bearer ${token}` } };
}

export async function requireSession(
  headers: Record<string, string | string[] | undefined>,
  baseUrl: string,
) {
  const options = sessionOptions(headers, baseUrl);
  try {
    await sdk.getMyUser(options);
  } catch {
    throw new SessionError();
  }
  return options;
}

const object = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};
export const tools = [
  {
    name: 'smart',
    description: 'Find photos using a natural-language visual query.',
    input_schema: {
      ...object,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'metadata',
    description:
      'Search photo metadata. Dates are ISO strings; personIds come from person search.',
    input_schema: {
      ...object,
      properties: {
        type: { type: 'string', enum: ['IMAGE', 'VIDEO'] },
        city: { type: 'string' },
        country: { type: 'string' },
        takenAfter: { type: 'string' },
        takenBefore: { type: 'string' },
        personIds: { type: 'array', items: { type: 'string' } },
        isFavorite: { type: 'boolean' },
      },
    },
  },
  {
    name: 'person',
    description: 'Find people by name.',
    input_schema: {
      ...object,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'places',
    description: 'Find place names.',
    input_schema: {
      ...object,
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
  {
    name: 'suggestions',
    description: 'List available metadata values.',
    input_schema: {
      ...object,
      properties: {
        type: {
          type: 'string',
          enum: ['country', 'state', 'city', 'camera-make', 'camera-model'],
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'statistics',
    description: 'Count the library: returns images (photos), videos, and total separately.',
    input_schema: object,
  },
  {
    name: 'get_asset',
    description: 'Read details for a photo ID.',
    input_schema: {
      ...object,
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
];

export async function runTool(
  name: string,
  input: unknown,
  options: ReturnType<typeof sessionOptions>,
  api = sdk,
) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool || !input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid tool');
  const args = input as Record<string, unknown>;
  const properties = tool.input_schema.properties as Record<
    string,
    { type: string; enum?: string[] }
  >;
  for (const [key, value] of Object.entries(args)) {
    const schema = properties[key];
    if (
      !schema ||
      (schema.type === 'array'
        ? !Array.isArray(value) ||
          value.some((item) => typeof item !== 'string')
        : typeof value !== schema.type) ||
      (schema.enum && !schema.enum.includes(value as string))
    )
      throw new Error('Invalid tool arguments');
    if (typeof value === 'string' && value.length > 2000)
      throw new Error('Tool argument too long');
  }
  for (const key of ('required' in tool.input_schema
    ? tool.input_schema.required
    : []) as string[]) {
    if (typeof args[key] !== 'string' || !args[key])
      throw new Error('Missing tool argument');
  }
  switch (name) {
    case 'smart':
      return api.searchSmart(
        { smartSearchDto: { query: args.query as string, size: 40 } },
        options,
      );
    case 'metadata':
      return api.searchAssets(
        { metadataSearchDto: { ...args, size: 40 } },
        options,
      );
    case 'person':
      return api.searchPerson(
        { name: args.name as string, withHidden: false },
        options,
      );
    case 'places':
      return api.searchPlaces({ name: args.name as string }, options);
    case 'suggestions':
      return api.getSearchSuggestions(
        { $type: args.type as sdk.SearchSuggestionType },
        options,
      );
    case 'statistics':
      return api.getAssetStatistics({}, options);
    case 'get_asset':
      return api.getAssetInfo({ id: args.id as string }, options);
    default:
      throw new Error('Invalid tool');
  }
}

// Send only useful display metadata to the LLM, never file paths, EXIF or people biometrics.
export function summarizeResult(name: string, result: any) {
  const assets =
    name === 'smart' || name === 'metadata'
      ? result.assets?.items
      : name === 'get_asset'
        ? [result]
        : undefined;
  if (assets)
    return {
      assets: assets.map((asset: any) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        localDateTime: asset.localDateTime,
        type: asset.type,
      })),
    };
  if (name === 'person')
    return result.map((person: any) => ({ id: person.id, name: person.name }));
  return result;
}
