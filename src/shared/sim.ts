// Deterministic movement step. The SAME function runs on the server (authority)
// and in the client (prediction). Only + - * / and Math.sqrt are used, because
// those are exactly specified by IEEE-754 (unlike Math.hypot/sin/cos, whose
// results may differ between JS engines).

import { BTN, DT, PLAYER_RADIUS, PLAYER_SPEED, WORLD_H, WORLD_W } from './constants';
import { OBSTACLES } from './map';

export interface Vec {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Pushes a circle out of the obstacles and keeps it inside the world. */
export function resolveCollisions(p: Vec, r: number): void {
  for (let iter = 0; iter < 2; iter++) {
    for (const o of OBSTACLES) {
      const cx = clamp(p.x, o.x, o.x + o.w);
      const cy = clamp(p.y, o.y, o.y + o.h);
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= r * r) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const k = (r - d) / d;
        p.x += dx * k;
        p.y += dy * k;
      } else {
        // Centre is inside the rectangle: exit through the nearest side.
        const l = p.x - o.x;
        const rr = o.x + o.w - p.x;
        const t = p.y - o.y;
        const b = o.y + o.h - p.y;
        const m = Math.min(l, rr, t, b);
        if (m === l) p.x = o.x - r;
        else if (m === rr) p.x = o.x + o.w + r;
        else if (m === t) p.y = o.y - r;
        else p.y = o.y + o.h + r;
      }
    }
    p.x = clamp(p.x, r, WORLD_W - r);
    p.y = clamp(p.y, r, WORLD_H - r);
  }
}

/** Advance one player by one fixed tick given the pressed buttons. */
export function stepMove(p: Vec, buttons: number): void {
  let dx = ((buttons & BTN.RIGHT) !== 0 ? 1 : 0) - ((buttons & BTN.LEFT) !== 0 ? 1 : 0);
  let dy = ((buttons & BTN.DOWN) !== 0 ? 1 : 0) - ((buttons & BTN.UP) !== 0 ? 1 : 0);
  if (dx !== 0 || dy !== 0) {
    const inv = 1 / Math.sqrt(dx * dx + dy * dy);
    dx *= inv;
    dy *= inv;
    p.x += dx * PLAYER_SPEED * DT;
    p.y += dy * PLAYER_SPEED * DT;
  }
  resolveCollisions(p, PLAYER_RADIUS);
}

export function pointInObstacle(x: number, y: number): boolean {
  for (const o of OBSTACLES) {
    if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return true;
  }
  return false;
}
