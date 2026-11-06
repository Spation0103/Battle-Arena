import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';
import { BTN } from '../src/shared/constants';
import {
  decodeServerMessage,
  encodeInput,
  encodeJoin,
  encodePing,
  type ServerMessage,
  type Snapshot,
} from '../src/shared/protocol';
import { stepMove } from '../src/shared/sim';
import { startServer, type RunningServer } from '../src/server/server';

let srv: RunningServer;
before(async () => {
  srv = await startServer({ port: 0, host: '127.0.0.1', staticDir: 'dist/public', botFill: 0 });
});
after(async () => {
  await srv.close();
});

function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
  const msgs: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d: Buffer) => {
    const m = decodeServerMessage(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    if (m) msgs.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const until = async <T>(pick: () => T | undefined, ms = 3000): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (Date.now() - t0 > ms) throw new Error('timeout');
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  const opened = new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, msgs, until, opened };
}

test('join -> welcome -> snapshots; ping/pong', async () => {
  const c = connect();
  await c.opened;
  c.ws.send(encodeJoin('tester'));
  const welcome = await c.until(() => c.msgs.find((m) => m.type === 'welcome'));
  assert.ok(welcome.type === 'welcome' && welcome.id > 0);
  await c.until(() => c.msgs.find((m) => m.type === 'snapshot'));
  c.ws.send(encodePing(4242));
  const pong = await c.until(() => c.msgs.find((m) => m.type === 'pong'));
  assert.ok(pong.type === 'pong' && pong.stamp === 4242);
  c.ws.close();
});

test('server position == client-side replay of the same inputs (prediction contract)', async () => {
  const c = connect();
  await c.opened;
  c.ws.send(encodeJoin('predict'));
  const welcome = await c.until(() => c.msgs.find((m) => m.type === 'welcome'));
  const id = welcome.type === 'welcome' ? welcome.id : -1;
  const first = await c.until(() => {
    const m = c.msgs.find((x) => x.type === 'snapshot');
    return m && m.type === 'snapshot' ? m.snapshot : undefined;
  });
  const start = first.players.find((p) => p.id === id)!;

  const plan = [BTN.RIGHT, BTN.RIGHT | BTN.DOWN, BTN.DOWN, BTN.LEFT | BTN.DOWN, BTN.LEFT];
  const N = 100;
  const predicted = { x: start.x, y: start.y };
  for (let seq = 1; seq <= N; seq++) {
    const buttons = plan[Math.floor((seq - 1) / 20) % plan.length];
    c.ws.send(encodeInput({ seq, buttons, aimQ: 0 }));
    stepMove(predicted, buttons);
    await new Promise((r) => setTimeout(r, 17)); // real clients send at 60 Hz
  }
  const last: Snapshot = await c.until(() => {
    for (let i = c.msgs.length - 1; i >= 0; i--) {
      const m = c.msgs[i];
      if (m.type === 'snapshot' && m.snapshot.ack >= N) return m.snapshot;
    }
    return undefined;
  });
  const me = last.players.find((p) => p.id === id)!;
  assert.ok(Math.abs(me.x - predicted.x) < 0.1, `x ${me.x} vs ${predicted.x}`);
  assert.ok(Math.abs(me.y - predicted.y) < 0.1, `y ${me.y} vs ${predicted.y}`);
  c.ws.close();
});

test('protocol violations are disconnected; wrong version rejected', async () => {
  const a = connect();
  await a.opened;
  const closed = new Promise<number>((r) => a.ws.on('close', (code) => r(code)));
  a.ws.send('text is not allowed');
  assert.equal(await closed, 1008);

  const b = connect();
  await b.opened;
  const closedB = new Promise<number>((r) => b.ws.on('close', (code) => r(code)));
  const bad = encodeJoin('x');
  bad[1] = 99;
  b.ws.send(bad);
  assert.equal(await closedB, 4000);
});

test('a busy port rejects cleanly instead of crashing the process', async () => {
  await assert.rejects(
    startServer({ port: srv.port, host: '127.0.0.1', staticDir: 'dist/public', botFill: 0 }),
    (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE',
  );
});

test('malformed URL escape returns 400 and the server keeps serving', async () => {
  const bad = await fetch(`http://127.0.0.1:${srv.port}/%E0%A4%A`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
  assert.equal(ok.status, 200);
});
