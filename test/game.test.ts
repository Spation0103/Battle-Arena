import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BTN, MAX_HP, PLAYER_RADIUS, RESPAWN_TICKS, WORLD_W } from '../src/shared/constants';
import { OBSTACLES } from '../src/shared/map';
import { quantAngle } from '../src/shared/protocol';
import { stepMove } from '../src/shared/sim';
import { Game } from '../src/server/game';

test('movement stays inside the world and outside obstacles', () => {
  const p = { x: 500, y: 700 };
  for (let i = 0; i < 3000; i++) stepMove(p, BTN.RIGHT | (i % 400 < 200 ? BTN.DOWN : BTN.UP));
  assert.ok(p.x <= WORLD_W - PLAYER_RADIUS + 1e-9);
  for (const o of OBSTACLES) {
    const cx = Math.max(o.x, Math.min(p.x, o.x + o.w));
    const cy = Math.max(o.y, Math.min(p.y, o.y + o.h));
    assert.ok(Math.hypot(p.x - cx, p.y - cy) >= PLAYER_RADIUS - 1e-6);
  }
});

test('diagonal is not faster than straight', () => {
  const a = { x: 100, y: 700 };
  const b = { x: 100, y: 700 };
  for (let i = 0; i < 30; i++) {
    stepMove(a, BTN.RIGHT);
    stepMove(b, BTN.RIGHT | BTN.DOWN);
  }
  const da = Math.hypot(a.x - 100, a.y - 700);
  const db = Math.hypot(b.x - 100, b.y - 700);
  assert.ok(Math.abs(da - db) < 1e-6);
});

const fakeWs = () => ({ readyState: 1, send() {}, bufferedAmount: 0 }) as never;

test('bullets hit, kill, score and respawn', () => {
  const g = new Game({ botFill: 0 });
  const shooter = g.addPlayer('a', fakeWs())!;
  const target = g.addPlayer('b', fakeWs())!;
  shooter.x = 500; shooter.y = 700;
  target.x = 700; target.y = 700;
  shooter.invulnUntil = target.invulnUntil = 0;

  let seq = 0;
  for (let t = 0; t < 200 && target.alive; t++) {
    g.handleInput(shooter, { seq: ++seq, buttons: BTN.FIRE, aimQ: quantAngle(0) });
    g.step();
  }
  assert.equal(target.alive, false);
  assert.equal(target.hp, 0);
  assert.equal(shooter.score, 1);

  for (let t = 0; t < RESPAWN_TICKS + 2; t++) g.step();
  assert.equal(target.alive, true);
  assert.equal(target.hp, MAX_HP);
});

test('input flooding cannot speed a player up', () => {
  const g = new Game({ botFill: 0 });
  const p = g.addPlayer('cheat', fakeWs())!;
  p.x = 100; p.y = 700;
  for (let i = 1; i <= 1000; i++) g.handleInput(p, { seq: i, buttons: BTN.RIGHT, aimQ: 0 });
  for (let t = 0; t < 30; t++) g.step();
  // 30 ticks of budget (+ initial bank) => at most 36 steps of 260/60 px
  assert.ok(p.x - 100 <= 36 * (260 / 60) + 1e-6, `moved ${p.x - 100}`);
});
