/**
 * The shape module, tested through its interface (str, num, obj, arr, parseObject, isPresent) and through the
 * two body readers that wrap it (jsonBody, optionalJsonBody). No server: a request context is just a raw body.
 *
 * Ways the module could fail, each covered below:
 *  1. An unknown property is accepted, is reported with the wrong path, or is not found when it sits inside an
 *     object that sits inside an array (the path must read `items[1].foo`).
 *  2. A wrong JSON type (number for string, string for number, array for object, object for array, a scalar for
 *     an object) is accepted, or is refused with a different code, message, status or path.
 *  3. null or a missing value is refused at any depth (field, nested object, array, array item), or is treated
 *     differently from absent.
 *  4. The parsed value is a copy or has been rewritten: the idempotency hash must see the body exactly as sent,
 *     so null fields, key order and amounts must survive.
 *  5. The type of the parsed value does not follow the declared shape: a string field typed as number, an
 *     object field typed as required, an array item typed as non-null. The `@ts-expect-error` lines below fail
 *     the type check when the types become looser or tighter than the contract.
 *  6. When a body has several problems, a different one wins than the first in key order.
 *  7. A hostile property name leaks control characters or an unbounded string into `field`.
 *  8. The body readers: an empty body, malformed JSON or a non-object body is mistaken for a valid body, or the
 *     shape check runs before the JSON check.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ApiError, INVALID_JSON, SCHEMA_MISMATCH } from '../src/errors.ts';
import { jsonBody, optionalJsonBody, type RequestContext } from '../src/http.ts';
import { arr, isPresent, num, obj, parseObject, type Parsed, type Present, str } from '../src/shape.ts';

const orderShape = obj({
  name: str,
  customer: obj({ email: str }),
  items: arr(obj({ variant_id: str, quantity: num })),
  tags: arr(str),
});

const refusedWith = (field: string | null) => (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'validation_failed');
  assert.equal(error.status, 422);
  assert.equal(error.message, SCHEMA_MISMATCH);
  assert.equal(error.field, field);
  return true;
};

const invalidJson = (error: unknown) => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.code, 'validation_failed');
  assert.equal(error.message, INVALID_JSON);
  assert.equal(error.field, null);
  return true;
};

const requestWithBody = (rawBody: string): RequestContext => ({
  method: 'POST',
  path: '/',
  query: new URLSearchParams(),
  params: {},
  headers: {},
  rawBody: Buffer.from(rawBody),
  requestId: 'req_test',
});

describe('unknown properties', () => {
  test('are refused at the root with the property name', () => {
    assert.throws(() => parseObject({ foo: 1 }, orderShape), refusedWith('foo'));
  });

  test('are refused in a nested object with a dotted path', () => {
    assert.throws(() => parseObject({ customer: { email: 'a@b.c', foo: 1 } }, orderShape), refusedWith('customer.foo'));
  });

  test('are refused inside an array item with the item index', () => {
    const body = { items: [{ variant_id: 'v', quantity: 1 }, { variant_id: 'v', quantity: 1, foo: true }] };
    assert.throws(() => parseObject(body, orderShape), refusedWith('items[1].foo'));
  });

  test('are refused even when their value is null', () => {
    assert.throws(() => parseObject({ foo: null }, orderShape), refusedWith('foo'));
  });
});

describe('wrong types', () => {
  test('a number where a string is declared', () => {
    assert.throws(() => parseObject({ name: 5 }, orderShape), refusedWith('name'));
  });

  test('a string where a number is declared, with the array path', () => {
    assert.throws(() => parseObject({ items: [{ quantity: '1' }] }, orderShape), refusedWith('items[0].quantity'));
  });

  test('a scalar, an array or a boolean where an object is declared', () => {
    for (const customer of ['x', 5, true, [], [{ email: 'a@b.c' }]]) {
      assert.throws(() => parseObject({ customer }, orderShape), refusedWith('customer'));
    }
  });

  test('an object or a scalar where an array is declared', () => {
    for (const items of [{}, 'x', 5, false]) {
      assert.throws(() => parseObject({ items }, orderShape), refusedWith('items'));
    }
  });

  test('a scalar array item where an object is declared', () => {
    assert.throws(() => parseObject({ items: [{ variant_id: 'v' }, 7] }, orderShape), refusedWith('items[1]'));
  });

  test('a wrong item inside an array of strings', () => {
    assert.throws(() => parseObject({ tags: ['a', 2] }, orderShape), refusedWith('tags[1]'));
  });

  test('a boolean or an object where a number is declared', () => {
    for (const quantity of [true, {}, []]) {
      assert.throws(() => parseObject({ items: [{ quantity }] }, orderShape), refusedWith('items[0].quantity'));
    }
  });

  test('the first problem in key order is the one reported', () => {
    assert.throws(() => parseObject({ zzz: 1, name: 5 }, orderShape), refusedWith('zzz'));
    assert.throws(() => parseObject({ name: 5, zzz: 1 }, orderShape), refusedWith('name'));
    assert.throws(() => parseObject({ customer: { email: 1 }, name: 5 }, orderShape), refusedWith('customer.email'));
  });

  test('a hostile property name is sanitised and bounded in the field', () => {
    const hostile = parseWithKey('bad key\nwith\u0000controls');
    assert.equal(hostile, 'bad_key_with_controls');
    assert.equal(parseWithKey('x'.repeat(500)).length, 120);
  });
});

function parseWithKey(key: string): string {
  try {
    parseObject({ [key]: 1 }, orderShape);
  } catch (error) {
    assert.ok(error instanceof ApiError);
    return error.field ?? '';
  }
  assert.fail('the unknown property was accepted');
}

describe('null and absent', () => {
  test('an empty object is accepted', () => {
    assert.deepEqual(parseObject({}, orderShape), {});
  });

  test('null is accepted at every depth, exactly like absent', () => {
    const body = { name: null, customer: null, items: null, tags: null };
    assert.doesNotThrow(() => parseObject(body, orderShape));
    assert.doesNotThrow(() => parseObject({ customer: { email: null }, items: [null, { variant_id: null, quantity: null }] }, orderShape));
  });

  test('a null array item is accepted and stays null', () => {
    const parsed = parseObject({ items: [null, { quantity: 2 }], tags: [null, 'a'] }, orderShape);
    assert.equal(parsed.items?.[0], null);
    assert.equal(parsed.items?.[1]?.quantity, 2);
    assert.equal(parsed.tags?.[0], null);
  });

  test('an empty string and zero are values, not absent', () => {
    const parsed = parseObject({ name: '', items: [{ quantity: 0 }] }, orderShape);
    assert.equal(parsed.name, '');
    assert.equal(parsed.items?.[0]?.quantity, 0);
  });

  test('isPresent separates null and undefined from every other value', () => {
    assert.equal(isPresent(null), false);
    assert.equal(isPresent(undefined), false);
    assert.equal(isPresent(0), true);
    assert.equal(isPresent(''), true);
    assert.equal(isPresent(false), true);
  });
});

describe('typed values', () => {
  const body = {
    name: 'Sara',
    customer: { email: 'sara@example.com' },
    items: [{ variant_id: 'var_1', quantity: 2 }, { variant_id: 'var_2', quantity: 1 }],
    tags: ['a', 'b'],
  };

  test('the parsed value is the body that was sent, not a copy', () => {
    assert.equal(parseObject(body, orderShape), body);
  });

  test('null fields, key order and numbers survive for the idempotency hash', () => {
    const sent = { tags: null, name: 'x', items: [{ quantity: 1.0, variant_id: null }] };
    const before = JSON.stringify(sent);
    const parsed = parseObject(sent, orderShape);
    assert.equal(JSON.stringify(parsed), before);
    assert.equal(Object.hasOwn(parsed, 'tags'), true);
  });

  test('values are readable with the declared types', () => {
    const parsed = parseObject(body, orderShape);
    const name: string | null | undefined = parsed.name;
    const email: string | null | undefined = parsed.customer?.email;
    const quantity: number | null | undefined = parsed.items?.[0]?.quantity;
    const tag: string | null | undefined = parsed.tags?.[1];
    assert.deepEqual([name, email, quantity, tag], ['Sara', 'sara@example.com', 2, 'b']);
  });

  test('the types follow the shape (a loosened or tightened type fails the type check)', () => {
    const parsed = parseObject(body, orderShape);
    // @ts-expect-error a string field is not a number
    const wrongName: number | null | undefined = parsed.name;
    // @ts-expect-error a number field is not a string
    const wrongQuantity: string | null | undefined = parsed.items?.[0]?.quantity;
    // @ts-expect-error a field can be absent, so it is not a plain string
    const requiredName: string = parsed.name;
    // @ts-expect-error an array item can be null, so it is not a plain object
    const requiredItem: { quantity?: number | null } = parsed.items?.[0];
    // @ts-expect-error an unknown property does not exist on the type
    const unknownField = parsed.foo;
    void [wrongName, wrongQuantity, requiredName, requiredItem, unknownField];
  });

  test('Present and Parsed describe a sent value and a possibly absent one', () => {
    const sent: Present<typeof orderShape> = body;
    const field: Parsed<typeof orderShape> = null;
    assert.equal(sent.name, 'Sara');
    assert.equal(field, null);
  });

  test('isPresent narrows an absent-or-value field for the checks that follow', () => {
    const quantity = parseObject(body, orderShape).items?.[0]?.quantity;
    if (!isPresent(quantity)) assert.fail('quantity was sent');
    const doubled: number = quantity * 2;
    assert.equal(doubled, 4);
  });
});

describe('body readers', () => {
  const shape = obj({ reason: str });

  test('jsonBody returns the typed object', () => {
    const body = jsonBody(requestWithBody('{"reason":"changed mind"}'), shape);
    const reason: string | null | undefined = body.reason;
    assert.equal(reason, 'changed mind');
  });

  test('jsonBody refuses an empty body, malformed JSON and a non-object body as invalid JSON', () => {
    for (const raw of ['', '{', 'null', '[]', '"s"', '5']) {
      assert.throws(() => jsonBody(requestWithBody(raw), shape), invalidJson, raw);
    }
  });

  test('optionalJsonBody returns null for an empty body and still refuses a malformed one', () => {
    assert.equal(optionalJsonBody(requestWithBody(''), shape), null);
    assert.throws(() => optionalJsonBody(requestWithBody('{'), shape), invalidJson);
    assert.throws(() => optionalJsonBody(requestWithBody('[]'), shape), invalidJson);
  });

  test('the JSON check runs before the shape check, and the shape check refuses what the JSON check passed', () => {
    assert.throws(() => jsonBody(requestWithBody('{"reason":5}'), shape), refusedWith('reason'));
    assert.throws(() => optionalJsonBody(requestWithBody('{"foo":1}'), shape), refusedWith('foo'));
  });

  test('a null field in the body is accepted and typed as absent', () => {
    assert.equal(jsonBody(requestWithBody('{"reason":null}'), shape).reason, null);
  });
});
