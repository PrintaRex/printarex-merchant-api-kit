import { validationFailed } from './errors.ts';

/** Cursor format used by production: base64url("<ISO instant>|<id>"), at most 200 characters. */
function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(raw: string | null): { at: Date; id: string } | null {
  if (raw === null) return null;
  const invalid = validationFailed('The cursor is not valid. Use next_cursor from a previous response.', 'cursor');
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid;
  const [instant, id, ...rest] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  const at = new Date(instant ?? '');
  if (!id || rest.length > 0 || Number.isNaN(at.getTime())) throw invalid;
  return { at, id };
}

/** Cuts one page from rows already sorted and filtered past the cursor. */
export function cursorPage<T extends { id: string }>(rows: T[], limit: number, instantOf: (row: T) => Date): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { page, nextCursor: rows.length > limit && last ? encodeCursor(instantOf(last), last.id) : null };
}

export function pageLimit(query: URLSearchParams): number {
  const raw = query.get('limit');
  if (raw === null) return 50;
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || limit < 1 || limit > 100) throw validationFailed('limit must be between 1 and 100.', 'limit');
  return limit;
}

/** RFC 3339 timestamp with an explicit offset, like Java's OffsetDateTime.parse. */
export function parseTimestamp(raw: string, field: string): Date {
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i.test(raw);
  const parsed = new Date(raw);
  if (!valid || Number.isNaN(parsed.getTime())) throw validationFailed(`${field} must be an RFC 3339 timestamp.`, field);
  return parsed;
}
