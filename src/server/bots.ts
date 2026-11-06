import { BTN } from '../shared/constants';
import { quantAngle, type InputCmd } from '../shared/protocol';
import type { Player } from './game';

/** A deliberately simple bot: chase / retreat / strafe, shoot when close. */
export class Bot {
  private seq = 0;
  private strafe = 1;
  private nextDecision = 0;

  constructor(public readonly player: Player) {}

  think(tick: number, players: Iterable<Player>): InputCmd {
    const p = this.player;
    if (tick >= this.nextDecision) {
      this.nextDecision = tick + 30 + Math.floor(Math.random() * 60);
      this.strafe = Math.random() < 0.5 ? -1 : 1;
    }

    let target: Player | null = null;
    let best = Infinity;
    for (const o of players) {
      if (o === p || !o.alive) continue;
      const d2 = (o.x - p.x) ** 2 + (o.y - p.y) ** 2;
      if (d2 < best) {
        best = d2;
        target = o;
      }
    }

    let buttons = 0;
    let aim = 0;
    if (target) {
      const dx = target.x - p.x;
      const dy = target.y - p.y;
      const d = Math.sqrt(best) || 1;
      aim = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.18;
      const want = d > 380 ? 1 : d < 200 ? -1 : 0;
      const fx = dx / d;
      const fy = dy / d;
      const mx = fx * want - fy * this.strafe * 0.8;
      const my = fy * want + fx * this.strafe * 0.8;
      if (mx > 0.3) buttons |= BTN.RIGHT;
      else if (mx < -0.3) buttons |= BTN.LEFT;
      if (my > 0.3) buttons |= BTN.DOWN;
      else if (my < -0.3) buttons |= BTN.UP;
      if (d < 650 && Math.random() < 0.6) buttons |= BTN.FIRE;
    }
    return { seq: ++this.seq, buttons, aimQ: quantAngle(aim) };
  }
}
