import type { WebSocket } from 'ws';
import {
  BTN,
  BULLET_DAMAGE,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_TTL_TICKS,
  DT,
  FIRE_COOLDOWN_TICKS,
  MAX_HP,
  MAX_INPUT_BUDGET,
  MAX_INPUT_QUEUE,
  MAX_PLAYERS,
  PLAYER_RADIUS,
  RESPAWN_TICKS,
  SNAPSHOT_EVERY,
  SPAWN_PROTECTION_TICKS,
  WORLD_H,
  WORLD_W,
} from '../shared/constants';
import { SPAWNS } from '../shared/map';
import {
  FLAG_ALIVE,
  FLAG_INVULN,
  dequantAngle,
  encodeJoined,
  encodeKill,
  encodeLeft,
  encodeSnapshot,
  encodeSnapshotBody,
  encodeWelcome,
  type InputCmd,
  type WireBullet,
  type WirePlayer,
} from '../shared/protocol';
import { pointInObstacle, stepMove } from '../shared/sim';
import { Bot } from './bots';

export class Player {
  x = 0;
  y = 0;
  aimQ = 0;
  hp = MAX_HP;
  alive = true;
  score = 0;
  respawnTick = 0;
  invulnUntil = 0;
  nextFireTick = 0;

  /** Commands received from the network, waiting for their tick. */
  queue: InputCmd[] = [];
  /** Token bucket: 1 command per tick, small bank for catching up. */
  budget = MAX_INPUT_BUDGET;
  lastRecvSeq = 0;
  /** Highest command seq applied; echoed to the owner so it can reconcile. */
  lastAck = 0;

  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly ws: WebSocket | null,
  ) {}

  get isBot(): boolean {
    return this.ws === null;
  }
}

interface Bullet {
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  expireTick: number;
}

export interface GameOptions {
  /** Bots keep the arena lively: total players are topped up to this number. */
  botFill: number;
}

const BOT_NAMES = ['ion', 'quark', 'muon', 'gluon', 'lepton', 'boson', 'kaon', 'pion'];

export class Game {
  tick = 0;
  readonly players = new Map<number, Player>();
  private bullets: Bullet[] = [];
  private bots = new Map<number, Bot>();
  private nextPlayerId = 1;
  private nextBulletId = 1;

  constructor(private readonly opts: GameOptions) {}

  // ------------------------------------------------------------ lifecycle

  humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  addPlayer(name: string, ws: WebSocket | null): Player | null {
    if (this.players.size >= MAX_PLAYERS) return null;
    const p = new Player(this.allocPlayerId(), name, ws);
    this.respawn(p);
    this.players.set(p.id, p);

    // Tell the newcomer who is here, and everyone else who arrived.
    this.sendTo(p, encodeWelcome(p.id, this.tick));
    const joined = encodeJoined(p.id, p.name);
    for (const o of this.players.values()) {
      this.sendTo(p, encodeJoined(o.id, o.name));
      if (o !== p) this.sendTo(o, joined);
    }
    return p;
  }

  removePlayer(p: Player): void {
    if (!this.players.delete(p.id)) return;
    this.bots.delete(p.id);
    this.broadcast(encodeLeft(p.id));
  }

  private allocPlayerId(): number {
    for (;;) {
      const id = this.nextPlayerId;
      this.nextPlayerId = this.nextPlayerId >= 0xfffe ? 1 : this.nextPlayerId + 1;
      if (!this.players.has(id)) return id;
    }
  }

  // ------------------------------------------------------------ input

  /** Called by the network layer. Only enqueues; simulation happens in step(). */
  handleInput(p: Player, cmd: InputCmd): void {
    if (cmd.seq <= p.lastRecvSeq) return; // replay / reorder
    if (p.queue.length >= MAX_INPUT_QUEUE) return; // flooding
    p.lastRecvSeq = cmd.seq;
    p.queue.push(cmd);
  }

  private applyInput(p: Player, cmd: InputCmd): void {
    p.lastAck = cmd.seq;
    p.aimQ = cmd.aimQ;
    if (!p.alive) return; // dead players still ack, so the client's queue drains
    stepMove(p, cmd.buttons);
    if ((cmd.buttons & BTN.FIRE) !== 0) this.tryFire(p);
  }

  private tryFire(p: Player): void {
    if (this.tick < p.nextFireTick) return;
    p.nextFireTick = this.tick + FIRE_COOLDOWN_TICKS;
    const a = dequantAngle(p.aimQ);
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const off = PLAYER_RADIUS + BULLET_RADIUS;
    this.bullets.push({
      id: this.nextBulletId,
      owner: p.id,
      x: p.x + dx * off,
      y: p.y + dy * off,
      vx: dx * BULLET_SPEED,
      vy: dy * BULLET_SPEED,
      expireTick: this.tick + BULLET_TTL_TICKS,
    });
    this.nextBulletId = this.nextBulletId >= 0xffff ? 1 : this.nextBulletId + 1;
  }

  // ------------------------------------------------------------ simulation

  /** One fixed 1/60 s step. */
  step(): void {
    this.tick++;

    // Bots produce commands exactly like a client would.
    for (const bot of this.bots.values()) {
      this.applyInput(bot.player, bot.think(this.tick, this.players.values()));
    }

    // Humans: consume queued commands, at most `budget` per tick.
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      p.budget = Math.min(p.budget + 1, MAX_INPUT_BUDGET);
      while (p.budget >= 1 && p.queue.length > 0) {
        p.budget -= 1;
        this.applyInput(p, p.queue.shift()!);
      }
    }

    this.stepBullets();

    for (const p of this.players.values()) {
      if (!p.alive && this.tick >= p.respawnTick) this.respawn(p);
    }

    if (this.tick % 60 === 0) this.balanceBots();
    if (this.tick % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();
  }

  private stepBullets(): void {
    const reach = PLAYER_RADIUS + BULLET_RADIUS;
    const reach2 = reach * reach;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * DT;
      b.y += b.vy * DT;

      let dead =
        this.tick >= b.expireTick ||
        b.x < 0 ||
        b.y < 0 ||
        b.x > WORLD_W ||
        b.y > WORLD_H ||
        pointInObstacle(b.x, b.y);

      if (!dead) {
        for (const p of this.players.values()) {
          if (p.id === b.owner || !p.alive || p.invulnUntil > this.tick) continue;
          const dx = p.x - b.x;
          const dy = p.y - b.y;
          if (dx * dx + dy * dy <= reach2) {
            this.damage(p, b.owner);
            dead = true;
            break;
          }
        }
      }

      if (dead) {
        this.bullets[i] = this.bullets[this.bullets.length - 1];
        this.bullets.pop();
      }
    }
  }

  private damage(victim: Player, killerId: number): void {
    victim.hp -= BULLET_DAMAGE;
    if (victim.hp > 0) return;
    victim.hp = 0;
    victim.alive = false;
    victim.respawnTick = this.tick + RESPAWN_TICKS;
    const killer = this.players.get(killerId);
    if (killer) killer.score++;
    this.broadcast(encodeKill(killerId, victim.id, victim.x, victim.y));
  }

  private respawn(p: Player): void {
    // Spawn as far as possible from everyone alive (plus a little randomness).
    let best = SPAWNS[0];
    let bestScore = -Infinity;
    for (const s of SPAWNS) {
      let nearest = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const d = Math.hypot(o.x - s.x, o.y - s.y);
        if (d < nearest) nearest = d;
      }
      const score = (nearest === Infinity ? 0 : nearest) + Math.random() * 250;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    p.x = best.x;
    p.y = best.y;
    p.hp = MAX_HP;
    p.alive = true;
    p.invulnUntil = this.tick + SPAWN_PROTECTION_TICKS;
  }

  // ------------------------------------------------------------ bots

  private balanceBots(): void {
    const humans = this.humanCount();
    // Nobody watching -> no bots (saves CPU on a small instance).
    const want = humans === 0 ? 0 : Math.max(0, this.opts.botFill - humans);
    while (this.bots.size < want) {
      const name = `bot-${BOT_NAMES[(this.nextPlayerId + this.bots.size) % BOT_NAMES.length]}`;
      const p = this.addPlayer(name, null);
      if (!p) break;
      this.bots.set(p.id, new Bot(p));
    }
    while (this.bots.size > want) {
      const [id] = this.bots.keys();
      const p = this.players.get(id);
      if (p) this.removePlayer(p);
      else this.bots.delete(id);
    }
  }

  // ------------------------------------------------------------ networking

  private sendTo(p: Player, data: Uint8Array): void {
    if (p.ws && p.ws.readyState === 1) p.ws.send(data, { binary: true });
  }

  private broadcast(data: Uint8Array): void {
    for (const p of this.players.values()) this.sendTo(p, data);
  }

  private broadcastSnapshot(): void {
    const wp: WirePlayer[] = [];
    for (const p of this.players.values()) {
      wp.push({
        id: p.id,
        x: p.x,
        y: p.y,
        aimQ: p.aimQ,
        hp: p.hp,
        flags: (p.alive ? FLAG_ALIVE : 0) | (p.invulnUntil > this.tick ? FLAG_INVULN : 0),
        score: p.score,
      });
    }
    const wb: WireBullet[] = this.bullets.map((b) => ({ id: b.id, owner: b.owner, x: b.x, y: b.y }));
    const body = encodeSnapshotBody(wp, wb);

    for (const p of this.players.values()) {
      const ws = p.ws;
      if (!ws || ws.readyState !== 1) continue;
      // A slow client: skip this snapshot instead of queueing stale data.
      if (ws.bufferedAmount > 128 * 1024) continue;
      ws.send(encodeSnapshot(this.tick, p.lastAck, body), { binary: true });
    }
  }
}
