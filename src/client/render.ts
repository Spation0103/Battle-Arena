import { MAX_HP, PLAYER_RADIUS, BULLET_RADIUS, WORLD_H, WORLD_W } from '../shared/constants';
import { OBSTACLES } from '../shared/map';
import type { RenderState } from './game';

// Palette: classic tank battle / brick arena.
const COL = {
  outside: '#0f1a13',
  floor: '#203a2e',
  grid: '#142b20',
  wall: '#6d4c2c',
  wallEdge: '#dca85d',
  border: '#d5d7b3',
  text: '#f4f3d9',
};
const PLAYER_COLORS = ['#7fe3cb', '#f7b267', '#f4d35e', '#ff7f50', '#cfe8ff', '#ffd6a5', '#b8f2e6', '#fff1e6'];
export const colorOf = (id: number): string => PLAYER_COLORS[id % PLAYER_COLORS.length];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  cssW = 0;
  cssH = 0;
  zoom = 1;
  camX = 0;
  camY = 0;
  private particles: Particle[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = window.innerWidth;
    this.cssH = window.innerHeight;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    // Everyone sees at least ~1100x700 world units regardless of screen size.
    this.zoom = Math.min(this.cssW / 1100, this.cssH / 700);
  }

  /** World -> CSS pixels (used for aiming). */
  screenOf(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.camX) * this.zoom, y: (y - this.camY) * this.zoom };
  }

  burst(x: number, y: number, color: string): void {
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 80 + Math.random() * 320;
      const max = 0.4 + Math.random() * 0.5;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: max, max, color });
    }
  }

  drawLevelTargets(targets: Array<{ x: number; y: number; r: number; alive: boolean }>): void {
    const { ctx, zoom } = this;
    const s = this.dpr * zoom;
    ctx.setTransform(s, 0, 0, s, -this.camX * s, -this.camY * s);
    for (const t of targets) {
      if (!t.alive) continue;
      ctx.fillStyle = '#e9ba5f';
      ctx.strokeStyle = '#f7f4d9';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(t.x - t.r, t.y - t.r, t.r * 2, t.r * 2, 8);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#5a3310';
      ctx.fillRect(t.x - t.r / 2, t.y - 8, t.r, 16);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  draw(
    state: RenderState,
    focus: { x: number; y: number } | null,
    names: Map<number, string>,
    now: number,
    dtSec: number,
  ): void {
    const { ctx, zoom } = this;
    const viewW = this.cssW / zoom;
    const viewH = this.cssH / zoom;
    const fx = focus?.x ?? WORLD_W / 2;
    const fy = focus?.y ?? WORLD_H / 2;
    this.camX = viewW >= WORLD_W ? (WORLD_W - viewW) / 2 : Math.max(0, Math.min(WORLD_W - viewW, fx - viewW / 2));
    this.camY = viewH >= WORLD_H ? (WORLD_H - viewH) / 2 : Math.max(0, Math.min(WORLD_H - viewH, fy - viewH / 2));

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.outside;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const s = this.dpr * zoom;
    ctx.setTransform(s, 0, 0, s, -this.camX * s, -this.camY * s);

    // Floor + grid
    ctx.fillStyle = COL.floor;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    const gx0 = Math.max(0, Math.floor(this.camX / 100) * 100);
    const gy0 = Math.max(0, Math.floor(this.camY / 100) * 100);
    for (let x = gx0; x <= Math.min(WORLD_W, this.camX + viewW); x += 100) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, WORLD_H);
    }
    for (let y = gy0; y <= Math.min(WORLD_H, this.camY + viewH); y += 100) {
      ctx.moveTo(0, y);
      ctx.lineTo(WORLD_W, y);
    }
    ctx.stroke();

    // Walls
    ctx.lineWidth = 2.5;
    ctx.fillStyle = COL.wall;
    ctx.strokeStyle = COL.wallEdge;
    for (const o of OBSTACLES) {
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
    }
    ctx.lineWidth = 6;
    ctx.strokeStyle = COL.border;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

    // Bullets
    for (const b of state.bullets) {
      ctx.fillStyle = colorOf(b.owner);
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }

    // Players (classic tank silhouettes)
    ctx.textAlign = 'center';
    ctx.font = '600 13px ui-monospace, Menlo, Consolas, monospace';
    for (const p of state.players) {
      if (!p.alive) continue;
      const color = colorOf(p.id);
      const blink = p.invuln && Math.floor(now / 90) % 2 === 0;
      ctx.globalAlpha = blink ? 0.35 : 1;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.aim);

      // tracks
      ctx.fillStyle = '#1d1d1d';
      ctx.fillRect(-18, -14, 36, 8);
      ctx.fillRect(-18, 6, 36, 8);

      // hull
      ctx.fillStyle = color;
      ctx.fillRect(-14, -11, 28, 22);
      ctx.fillStyle = '#f0efe4';
      ctx.fillRect(-6, -7, 12, 14);

      // turret/cannon
      ctx.fillStyle = color;
      ctx.fillRect(-3, -2, 22, 4);
      ctx.fillStyle = '#1d1d1d';
      ctx.fillRect(12, -2, 8, 4);
      ctx.restore();

      if (p.isMe) {
        ctx.strokeStyle = '#f4f3d9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_RADIUS + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // hp bar + name
      const w = 40;
      const top = p.y - PLAYER_RADIUS - 16;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(p.x - w / 2, top, w, 5);
      ctx.fillStyle = p.hp > 40 ? color : COL.border;
      ctx.fillRect(p.x - w / 2, top, (w * p.hp) / MAX_HP, 5);
      ctx.fillStyle = COL.text;
      ctx.fillText(names.get(p.id) ?? '?', p.x, top - 6);
    }

    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dtSec;
      if (q.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      q.x += q.vx * dtSec;
      q.y += q.vy * dtSec;
      ctx.globalAlpha = q.life / q.max;
      ctx.fillStyle = q.color;
      ctx.fillRect(q.x - 2, q.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }
}
