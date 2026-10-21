import { ApiError, SCHEMA_MISMATCH } from './errors.ts';

/**
 * "Parse, don't validate": a declared shape both enforces the real service's strict JSON binding (unknown
 * properties and wrong JSON types are refused with `422 validation_failed` and the dotted path in `field`)
 * and gives the parsed body its type. Missing values and nulls pass here and are typed as absent; each
 * handler reports a missing required value with its own message.
 */
type StringShape = { readonly kind: 'string' };
type NumberShape = { readonly kind: 'number' };
interface ObjectShape<F extends Fields> {
  readonly kind: 'object';
  readonly fields: F;
}
interface ArrayShape<I extends Shape> {
  readonly kind: 'array';
  readonly items: I;
}
interface Fields {
  readonly [name: string]: Shape;
}
export type Shape = StringShape | NumberShape | ObjectShape<Fields> | ArrayShape<Shape>;
/** A request body is always a JSON object. */
export type BodyShape = ObjectShape<Fields>;

export const str: StringShape = { kind: 'string' };
export const num: NumberShape = { kind: 'number' };
export const obj = <F extends Fields>(fields: F): ObjectShape<F> => ({ kind: 'object', fields });
export const arr = <I extends Shape>(items: I): ArrayShape<I> => ({ kind: 'array', items });

/** A value that was sent and not null. Every property and array item can still be absent or null. */
export type Present<S extends Shape> = S extends StringShape
  ? string
  : S extends NumberShape
    ? number
    : S extends ObjectShape<infer F>
      ? { readonly [K in keyof F]?: Parsed<F[K]> }
      : S extends ArrayShape<infer I>
        ? readonly Parsed<I>[]
        : never;

/** What a field of this shape holds after parsing: the value, or null/undefined when it was sent as null or left out. */
export type Parsed<S extends Shape> = Present<S> | null | undefined;

/** True for a value that was sent and not null; narrows the type for the business-rule checks that follow. */
export const isPresent = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

/**
 * Refuses unknown properties and wrong types, then returns the same object typed by the shape. It is
 * deliberately not a copy: the idempotency hash must see the body exactly as it was sent.
 */
export function parseObject<S extends BodyShape>(body: Record<string, unknown>, shape: S): Present<S> {
  checkShape(body, shape);
  return body as Present<S>;
}

function checkShape(value: unknown, shape: Shape, path = ''): void {
  if (value === null || value === undefined) return;
  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') throw mismatch(path);
      return;
    case 'number':
      if (typeof value !== 'number') throw mismatch(path);
      return;
    case 'array':
      if (!Array.isArray(value)) throw mismatch(path);
      value.forEach((item, index) => checkShape(item, shape.items, `${path}[${index}]`));
      return;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) throw mismatch(path);
      for (const [key, child] of Object.entries(value)) {
        const childShape = shape.fields[key];
        const childPath = path ? `${path}.${key}` : key;
        if (!childShape) throw mismatch(childPath);
        checkShape(child, childShape, childPath);
      }
    }
  }
}

function mismatch(path: string): ApiError {
  return new ApiError('validation_failed', SCHEMA_MISMATCH, { field: sanitizeField(path) || null });
}

function sanitizeField(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]-]/g, '_').slice(0, 120);
}

export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
