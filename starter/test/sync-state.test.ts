/**
 * Exercises the Sync state module (`Db`) through its interface, with no server or sandbox.
 *
 * Ways the module could fail, each covered below:
 *  1. A redelivered event id is acted on twice.
 *  2. An event with a LOWER sequence than the one applied overwrites newer data.
 *  3. An event with an EQUAL sequence is dropped, although several events from one change share one.
 *  4. The high-water mark moves down when an older event is completed, or moves for an event that was never completed.
 *  5. An event whose handling failed is remembered as processed, so its retry is ignored.
 *  6. Sequences of different resources interfere with each other.
 *  7. Events without a sequence or resource (ping) are wrongly dropped as stale.
 *  8. A change is not written to disk, or the file is only half written.
 *  9. An older db.json without newer fields no longer loads.
 * 10. db.json, which holds buyer emails, phones and addresses, is readable by other users, or stays
 *     readable because a temporary file left by a crash had looser permissions.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type EventReceipt, Db } from '../src/db.ts';

const freshDir = () => mkdtempSync(join(tmpdir(), 'sync-state-'));
const receipt = (overrides: Partial<EventReceipt> = {}): EventReceipt => ({ id: 'evt-1', type: 'product.updated', sequence: 5, resourceKey: 'product:A', ...overrides });
const outcomes = (db: Db) => db.data.webhookLog.map((entry) => entry.outcome);

describe('Sync state', () => {
  test('a redelivered event id is ignored once it was completed', () => {
    const db = new Db(freshDir());
    assert.equal(db.admitEvent(receipt()), true);
    db.completeEvent(receipt());
    assert.equal(db.admitEvent(receipt()), false);
    assert.deepEqual(outcomes(db), ['duplicate, ignored', 'processed']);
  });

  test('a lower sequence is dropped, an equal or higher one is accepted', () => {
    const db = new Db(freshDir());
    db.completeEvent(receipt({ id: 'evt-1', sequence: 5 }));
    assert.equal(db.admitEvent(receipt({ id: 'evt-2', sequence: 4 })), false);
    assert.equal(db.admitEvent(receipt({ id: 'evt-3', sequence: 5 })), true);
    assert.equal(db.admitEvent(receipt({ id: 'evt-4', sequence: 6 })), true);
    assert.equal(outcomes(db)[0], 'stale sequence, ignored');
  });

  test('completing an older event never lowers the mark, and an event that was only admitted does not raise it', () => {
    const db = new Db(freshDir());
    db.completeEvent(receipt({ id: 'evt-1', sequence: 5 }));
    db.completeEvent(receipt({ id: 'evt-2', sequence: 3 }));
    assert.equal(db.data.sequences['product:A'], 5);
    assert.equal(db.admitEvent(receipt({ id: 'evt-3', sequence: 9 })), true);
    assert.equal(db.data.sequences['product:A'], 5);
  });

  test('an event that was admitted but never completed may be delivered again', () => {
    const db = new Db(freshDir());
    assert.equal(db.admitEvent(receipt()), true);
    assert.equal(db.admitEvent(receipt()), true);
  });

  test('resources do not share a sequence', () => {
    const db = new Db(freshDir());
    db.completeEvent(receipt({ resourceKey: 'product:A', sequence: 9 }));
    assert.equal(db.admitEvent(receipt({ id: 'evt-2', resourceKey: 'product:B', sequence: 1 })), true);
    assert.equal(db.isStale('order:X', 1), false);
  });

  test('events without a sequence or a resource are never stale', () => {
    const db = new Db(freshDir());
    db.completeEvent(receipt({ sequence: 9 }));
    assert.equal(db.admitEvent(receipt({ id: 'evt-2', type: 'ping', sequence: null, resourceKey: null })), true);
    assert.equal(db.admitEvent(receipt({ id: 'evt-3', sequence: null })), true);
  });

  test('update saves the change together with the sequence it applied, and a reload sees both', () => {
    const dataDir = freshDir();
    const db = new Db(dataDir);
    db.update((data) => {
      data.connectionDisabledReason = 'key revoked';
    }, { resourceKey: 'order:X', sequence: 7 });
    db.completeEvent(receipt({ id: 'evt-9' }));

    const reloaded = new Db(dataDir);
    assert.equal(reloaded.data.connectionDisabledReason, 'key revoked');
    assert.equal(reloaded.isStale('order:X', 6), true);
    assert.equal(reloaded.isStale('order:X', 7), false);
    assert.equal(reloaded.admitEvent(receipt({ id: 'evt-9' })), false);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), []);
  });

  test('a db.json written before newer fields existed still loads', () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, 'db.json'), JSON.stringify({ listings: {}, orders: {}, processedEventIds: ['old-1'], sequences: { 'product:A': 4 } }));
    const db = new Db(dataDir);
    assert.equal(db.admitEvent(receipt({ id: 'old-1' })), false);
    assert.equal(db.isStale('product:A', 3), true);
    assert.equal(db.data.lastReconciledAt, null);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'db.json'), 'utf8')).processedEventIds, ['old-1']);
  });

  test('the remembered event ids and the webhook log stay bounded', () => {
    const db = new Db(freshDir());
    for (let index = 0; index < 5002; index++) db.completeEvent(receipt({ id: `evt-${index}`, resourceKey: null, sequence: null }));
    assert.equal(db.data.processedEventIds.length, 5000);
    assert.equal(db.admitEvent(receipt({ id: 'evt-0', resourceKey: null })), true);
    assert.equal(db.data.webhookLog.length, 100);
  });

  test('db.json is readable only by its owner, even after a crash left a loose temporary file', () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, 'db.json.tmp'), 'left over', { mode: 0o644 });
    const db = new Db(dataDir);
    db.update((data) => {
      data.connectionDisabledReason = 'x';
    });
    assert.equal(statSync(join(dataDir, 'db.json')).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), []);
  });
});
