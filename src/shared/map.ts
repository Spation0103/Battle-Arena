import { WORLD_H, WORLD_W } from './constants';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const mirror = (r: Rect, mx: boolean, my: boolean): Rect => ({
  x: mx ? WORLD_W - r.x - r.w : r.x,
  y: my ? WORLD_H - r.y - r.h : r.y,
  w: r.w,
  h: r.h,
});

// One quadrant, mirrored into all four -> a fair, symmetric arena.
const quadrant: Rect[] = [
  { x: 250, y: 220, w: 220, h: 40 },
  { x: 250, y: 220, w: 40, h: 180 },
  { x: 600, y: 420, w: 60, h: 60 },
  { x: 430, y: 560, w: 120, h: 30 },
];

export const OBSTACLES: Rect[] = [
  { x: 900, y: 620, w: 200, h: 160 }, // centre block
  { x: 780, y: 300, w: 440, h: 30 }, // top bar
  { x: 780, y: 1070, w: 440, h: 30 }, // bottom bar
  ...quadrant.flatMap((r) => [r, mirror(r, true, false), mirror(r, false, true), mirror(r, true, true)]),
];

export const SPAWNS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 120, y: 120 },
  { x: 1880, y: 120 },
  { x: 120, y: 1280 },
  { x: 1880, y: 1280 },
  { x: 1000, y: 140 },
  { x: 1000, y: 1260 },
  { x: 140, y: 700 },
  { x: 1860, y: 700 },
];
