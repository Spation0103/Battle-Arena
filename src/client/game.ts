import { INTERP_DELAY_MS, TICK_MS } from '../shared/constants';
import { quantAngle, type BulletState, type InputCmd, type PlayerState, type Snapshot } from '../shared/protocol';
import { stepMove } from '../shared/sim';

export interface RenderPlayer extends PlayerState {
  isMe: boolean;
}

export interface RenderState {
  players: RenderPlayer[];
  bullets: BulletState[];
}

interface TimedSnapshot {
  t: number; // server time of the snapshot (ms)
  s: Snapshot;
}

const TWO_PI = Math.PI * 2;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * k;
}

export class ClientGame {
  myId = 0;
  names = new Map<number, string>();
  /** Toggle with P: off = show the raw server position (feel the latency). */
  prediction = true;
  rttMs = 0;
  /** Size of the last server correction in px (debug HUD). */
  lastCorrection = 0;

  private seq = 0;
  private pending: InputCmd[] = [];
  private pred = { x: 0, y: 0 };
  private predReady = false;
  private predAlive = false;
  /** Visual smoothing: hides a correction by decaying it over ~100 ms. */
  private vis = { x: 0, y: 0 };

  private snaps: TimedSnapshot[] = [];
  private latest: Snapshot | null = null;
  private offset = 0; // serverTime - localTime estimate
  private hasOffset = false;

  get pendingCount(): number {
    return this.pending.length;
  }
  get latestSnapshot(): Snapshot | null {
    return this.latest;
  }

  // ------------------------------------------------------------ prediction

  /** Runs at a fixed 60 Hz. Produces the command to send AND applies it locally. */
  step(buttons: number, aim: number): InputCmd {
    const cmd: InputCmd = { seq: ++this.seq, buttons, aimQ: quantAngle(aim) };
    this.pending.push(cmd);
    if (this.pending.length > 180) this.pending.shift();
    if (this.predReady && this.predAlive) stepMove(this.pred, buttons);
    return cmd;
  }

  /** Called once per rendered frame. */
  updateVisual(dtSec: number): void {
    const k = Math.exp(-dtSec * 12);
    this.vis.x *= k;
    this.vis.y *= k;
  }

  onSnapshot(s: Snapshot, now: number): void {
    // Clock sync (coarse): smoothed estimate of server time minus local time.
    const t = s.tick * TICK_MS;
    const sample = t - now;
    if (!this.hasOffset) {
      this.offset = sample;
      this.hasOffset = true;
    } else {
      this.offset += (sample - this.offset) * 0.05;
    }
    this.snaps.push({ t, s });
    if (this.snaps.length > 40) this.snaps.shift();
    this.latest = s;

    const me = s.players.find((p) => p.id === this.myId);
    if (!me) return;

    // Reconciliation: take the server's state at `ack`, then re-apply every
    // input the server has not processed yet.
    while (this.pending.length > 0 && this.pending[0].seq <= s.ack) this.pending.shift();
    const prevX = this.pred.x + this.vis.x;
    const prevY = this.pred.y + this.vis.y;

    this.pred.x = me.x;
    this.pred.y = me.y;
    this.predAlive = me.alive;
    if (me.alive) for (const cmd of this.pending) stepMove(this.pred, cmd.buttons);

    if (!this.predReady) {
      this.predReady = true;
      this.vis.x = this.vis.y = 0;
      return;
    }
    const ex = prevX - this.pred.x;
    const ey = prevY - this.pred.y;
    this.lastCorrection = Math.sqrt(ex * ex + ey * ey);
    if (this.lastCorrection > 120) {
      this.vis.x = this.vis.y = 0; // teleport (respawn): snap
    } else {
      this.vis.x = ex; // keep the picture continuous, decay in updateVisual()
      this.vis.y = ey;
    }
  }

  /** Where the local player is drawn / where the camera looks. */
  myPosition(): { x: number; y: number } | null {
    if (!this.predReady) return null;
    if (!this.prediction) {
      const me = this.latest?.players.find((p) => p.id === this.myId);
      return me ? { x: me.x, y: me.y } : null;
    }
    return { x: this.pred.x + this.vis.x, y: this.pred.y + this.vis.y };
  }

  // ------------------------------------------------------------ interpolation

  getRenderState(now: number, localAim: number): RenderState {
    const snaps = this.snaps;
    if (snaps.length === 0) return { players: [], bullets: [] };

    // Everyone else is shown INTERP_DELAY_MS in the past, between two snapshots.
    const rt = now + this.offset - INTERP_DELAY_MS;
    let a = snaps[0];
    let b = snaps[0];
    const last = snaps[snaps.length - 1];
    if (rt >= last.t) {
      a = b = last;
    } else if (rt > snaps[0].t) {
      for (let i = snaps.length - 1; i > 0; i--) {
        if (snaps[i - 1].t <= rt) {
          a = snaps[i - 1];
          b = snaps[i];
          break;
        }
      }
    }
    const k = a === b ? 1 : (rt - a.t) / (b.t - a.t);

    const before = new Map<number, PlayerState>();
    for (const p of a.s.players) before.set(p.id, p);

    const players: RenderPlayer[] = [];
    for (const pb of b.s.players) {
      const isMe = pb.id === this.myId;
      const pa = before.get(pb.id);
      let x = pb.x;
      let y = pb.y;
      let aim = pb.aim;
      if (pa && pa.alive && pb.alive && a !== b) {
        const jump = Math.abs(pb.x - pa.x) + Math.abs(pb.y - pa.y);
        if (jump < 300) {
          x = lerp(pa.x, pb.x, k);
          y = lerp(pa.y, pb.y, k);
          aim = lerpAngle(pa.aim, pb.aim, k);
        }
      }
      if (isMe) {
        // Own state: newest snapshot for hp/score, prediction for position.
        const mine = this.latest?.players.find((p) => p.id === this.myId) ?? pb;
        const pos = this.myPosition();
        players.push({ ...mine, x: pos ? pos.x : mine.x, y: pos ? pos.y : mine.y, aim: localAim, isMe: true });
      } else {
        players.push({ ...pb, x, y, aim, isMe: false });
      }
    }

    const beforeB = new Map<number, BulletState>();
    for (const bl of a.s.bullets) beforeB.set(bl.id, bl);
    const bullets: BulletState[] = b.s.bullets.map((bl) => {
      const o = beforeB.get(bl.id);
      return o && a !== b ? { ...bl, x: lerp(o.x, bl.x, k), y: lerp(o.y, bl.y, k) } : bl;
    });

    return { players, bullets };
  }
}
