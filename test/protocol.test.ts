import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  encodeKill,
  encodePing,
  encodeSnapshot,
  encodeSnapshotBody,
  FLAG_ALIVE,
  quantAngle,
  dequantAngle,
} from '../src/shared/protocol';

test('input round-trips and is 8 bytes', () => {
  const buf = encodeInput({ seq: 123456, buttons: 0b10101, aimQ: 4242 });
  assert.equal(buf.length, 8);
  assert.deepEqual(decodeClientMessage(buf), { type: 'input', cmd: { seq: 123456, buttons: 21, aimQ: 4242 } });
});

test('join / ping round-trip, malformed is rejected', () => {
  assert.deepEqual(decodeClientMessage(encodeJoin('Даша')), { type: 'join', version: 1, name: 'Даша' });
  assert.deepEqual(decodeClientMessage(encodePing(99)), { type: 'ping', stamp: 99 });
  assert.equal(decodeClientMessage(new Uint8Array([2, 1, 2])), null); // truncated input
  assert.equal(decodeClientMessage(new Uint8Array([0xff])), null);
  assert.equal(decodeClientMessage(new Uint8Array(0)), null);
});

test('snapshot round-trips with quantisation error < 1/32 px', () => {
  const body = encodeSnapshotBody(
    [{ id: 7, x: 1234.567, y: 890.123, aimQ: quantAngle(1.5), hp: 60, flags: FLAG_ALIVE, score: 3 }],
    [{ id: 9, owner: 7, x: 10.5, y: 20.25 }],
  );
  const msg = decodeServerMessage(encodeSnapshot(500, 77, body));
  assert.ok(msg && msg.type === 'snapshot');
  const s = msg.snapshot;
  assert.equal(s.tick, 500);
  assert.equal(s.ack, 77);
  assert.ok(Math.abs(s.players[0].x - 1234.567) < 1 / 32);
  assert.ok(Math.abs(s.players[0].y - 890.123) < 1 / 32);
  assert.ok(Math.abs(s.players[0].aim - 1.5) < 1e-3);
  assert.equal(s.players[0].alive, true);
  assert.deepEqual(s.bullets[0], { id: 9, owner: 7, x: 10.5, y: 20.25 });
  // 9 header + 2 + 12 + 2 + 8
  assert.equal(encodeSnapshot(1, 1, body).length, 33);
});

test('kill event and angle helpers', () => {
  const k = decodeServerMessage(encodeKill(1, 2, 100, 200));
  assert.deepEqual(k, { type: 'kill', killer: 1, victim: 2, x: 100, y: 200 });
  for (const a of [0, 1, 3.14, 6.2, -1]) {
    const back = dequantAngle(quantAngle(a));
    const want = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    assert.ok(Math.abs(back - want) < 1e-3);
  }
});
