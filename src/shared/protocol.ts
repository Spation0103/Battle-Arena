// Binary wire protocol (little-endian). No JSON, no per-field keys.
//
// Client -> Server
//   JOIN   [u8 0x01][u8 version][u8 nameLen][name utf8]
//   INPUT  [u8 0x02][u32 seq][u8 buttons][u16 aim]                      (8 bytes)
//   PING   [u8 0x03][u32 stamp]                                         (5 bytes)
//
// Server -> Client
//   WELCOME  [u8 0x81][u16 yourId][u32 tick]
//   SNAPSHOT [u8 0x82][u32 tick][u32 ackSeq]
//              [u16 nPlayers] nPlayers x { u16 id, u16 x, u16 y, u16 aim, u8 hp, u8 flags, u16 score }  (12 B each)
//              [u16 nBullets] nBullets x { u16 id, u16 owner, u16 x, u16 y }                            (8 B each)
//   KILL     [u8 0x83][u16 killer][u16 victim][u16 x][u16 y]
//   JOINED   [u8 0x84][u16 id][u8 nameLen][name utf8]
//   LEFT     [u8 0x85][u16 id]
//   PONG     [u8 0x86][u32 stamp][u32 tick]
//
// Positions are quantised to 1/32 px (u16 covers 0..2047 px), angles to 2π/65536.

import { BTN_MASK, MAX_NAME_LEN, PROTOCOL_VERSION } from './constants';

export const C2S = { JOIN: 0x01, INPUT: 0x02, PING: 0x03 } as const;
export const S2C = {
  WELCOME: 0x81,
  SNAPSHOT: 0x82,
  KILL: 0x83,
  JOINED: 0x84,
  LEFT: 0x85,
  PONG: 0x86,
} as const;

export const FLAG_ALIVE = 1;
export const FLAG_INVULN = 2;

const TWO_PI = Math.PI * 2;
export const POS_SCALE = 32;
const ANGLE_SCALE = 65536 / TWO_PI;

export const quantPos = (v: number): number => {
  const q = Math.round(v * POS_SCALE);
  return q < 0 ? 0 : q > 65535 ? 65535 : q;
};
export const dequantPos = (q: number): number => q / POS_SCALE;

export const quantAngle = (a: number): number => {
  let t = a % TWO_PI;
  if (t < 0) t += TWO_PI;
  return Math.round(t * ANGLE_SCALE) & 0xffff;
};
export const dequantAngle = (q: number): number => q / ANGLE_SCALE;

// ---------------------------------------------------------------- types

export interface InputCmd {
  seq: number;
  buttons: number;
  aimQ: number; // quantised aim angle
}

export interface WirePlayer {
  id: number;
  x: number;
  y: number;
  aimQ: number;
  hp: number;
  flags: number;
  score: number;
}
export interface WireBullet {
  id: number;
  owner: number;
  x: number;
  y: number;
}

export interface PlayerState {
  id: number;
  x: number;
  y: number;
  aim: number;
  hp: number;
  alive: boolean;
  invuln: boolean;
  score: number;
}
export interface BulletState {
  id: number;
  owner: number;
  x: number;
  y: number;
}
export interface Snapshot {
  tick: number;
  ack: number;
  players: PlayerState[];
  bullets: BulletState[];
}

export type ClientMessage =
  | { type: 'join'; version: number; name: string }
  | { type: 'input'; cmd: InputCmd }
  | { type: 'ping'; stamp: number };

export type ServerMessage =
  | { type: 'welcome'; id: number; tick: number }
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'kill'; killer: number; victim: number; x: number; y: number }
  | { type: 'joined'; id: number; name: string }
  | { type: 'left'; id: number }
  | { type: 'pong'; stamp: number; tick: number };

// ---------------------------------------------------------------- helpers

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const view = (u8: Uint8Array) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// ---------------------------------------------------------------- client -> server

export function encodeJoin(name: string): Uint8Array {
  const nb = textEncoder.encode(name).subarray(0, MAX_NAME_LEN);
  const out = new Uint8Array(3 + nb.length);
  out[0] = C2S.JOIN;
  out[1] = PROTOCOL_VERSION;
  out[2] = nb.length;
  out.set(nb, 3);
  return out;
}

export function encodeInput(cmd: InputCmd): Uint8Array {
  const out = new Uint8Array(8);
  const v = view(out);
  v.setUint8(0, C2S.INPUT);
  v.setUint32(1, cmd.seq >>> 0, true);
  v.setUint8(5, cmd.buttons & BTN_MASK);
  v.setUint16(6, cmd.aimQ & 0xffff, true);
  return out;
}

export function encodePing(stamp: number): Uint8Array {
  const out = new Uint8Array(5);
  const v = view(out);
  v.setUint8(0, C2S.PING);
  v.setUint32(1, stamp >>> 0, true);
  return out;
}

/** Strict: anything malformed returns null (server just drops it). */
export function decodeClientMessage(u8: Uint8Array): ClientMessage | null {
  if (u8.length < 1) return null;
  const v = view(u8);
  switch (u8[0]) {
    case C2S.JOIN: {
      if (u8.length < 3) return null;
      const len = u8[2];
      if (len > MAX_NAME_LEN) return null;
      if (u8.length !== 3 + len) return null;
      return { type: 'join', version: u8[1], name: textDecoder.decode(u8.subarray(3, 3 + len)) };
    }
    case C2S.INPUT:
      if (u8.length !== 8) return null;
      return {
        type: 'input',
        cmd: { seq: v.getUint32(1, true), buttons: v.getUint8(5) & BTN_MASK, aimQ: v.getUint16(6, true) },
      };
    case C2S.PING:
      if (u8.length !== 5) return null;
      return { type: 'ping', stamp: v.getUint32(1, true) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- server -> client

export function encodeWelcome(id: number, tick: number): Uint8Array {
  const out = new Uint8Array(7);
  const v = view(out);
  v.setUint8(0, S2C.WELCOME);
  v.setUint16(1, id, true);
  v.setUint32(3, tick >>> 0, true);
  return out;
}

export function encodeJoined(id: number, name: string): Uint8Array {
  const nb = textEncoder.encode(name).subarray(0, MAX_NAME_LEN);
  const out = new Uint8Array(4 + nb.length);
  const v = view(out);
  v.setUint8(0, S2C.JOINED);
  v.setUint16(1, id, true);
  v.setUint8(3, nb.length);
  out.set(nb, 4);
  return out;
}

export function encodeLeft(id: number): Uint8Array {
  const out = new Uint8Array(3);
  const v = view(out);
  v.setUint8(0, S2C.LEFT);
  v.setUint16(1, id, true);
  return out;
}

export function encodeKill(killer: number, victim: number, x: number, y: number): Uint8Array {
  const out = new Uint8Array(9);
  const v = view(out);
  v.setUint8(0, S2C.KILL);
  v.setUint16(1, killer, true);
  v.setUint16(3, victim, true);
  v.setUint16(5, quantPos(x), true);
  v.setUint16(7, quantPos(y), true);
  return out;
}

export function encodePong(stamp: number, tick: number): Uint8Array {
  const out = new Uint8Array(9);
  const v = view(out);
  v.setUint8(0, S2C.PONG);
  v.setUint32(1, stamp >>> 0, true);
  v.setUint32(5, tick >>> 0, true);
  return out;
}

const SNAP_HEADER = 9;

/**
 * The part of a snapshot that is identical for every client. Encoded once per
 * tick; only the 9-byte header (tick + per-client ack) differs.
 */
export function encodeSnapshotBody(players: WirePlayer[], bullets: WireBullet[]): Uint8Array {
  const out = new Uint8Array(2 + players.length * 12 + 2 + bullets.length * 8);
  const v = view(out);
  let o = 0;
  v.setUint16(o, players.length, true);
  o += 2;
  for (const p of players) {
    v.setUint16(o, p.id, true);
    v.setUint16(o + 2, quantPos(p.x), true);
    v.setUint16(o + 4, quantPos(p.y), true);
    v.setUint16(o + 6, p.aimQ, true);
    v.setUint8(o + 8, p.hp);
    v.setUint8(o + 9, p.flags);
    v.setUint16(o + 10, p.score & 0xffff, true);
    o += 12;
  }
  v.setUint16(o, bullets.length, true);
  o += 2;
  for (const b of bullets) {
    v.setUint16(o, b.id, true);
    v.setUint16(o + 2, b.owner, true);
    v.setUint16(o + 4, quantPos(b.x), true);
    v.setUint16(o + 6, quantPos(b.y), true);
    o += 8;
  }
  return out;
}

export function encodeSnapshot(tick: number, ack: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(SNAP_HEADER + body.length);
  const v = view(out);
  v.setUint8(0, S2C.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint32(5, ack >>> 0, true);
  out.set(body, SNAP_HEADER);
  return out;
}

/** Throws on truncated data (the client wraps this in try/catch). */
export function decodeServerMessage(u8: Uint8Array): ServerMessage | null {
  if (u8.length < 1) return null;
  const v = view(u8);
  try {
    switch (u8[0]) {
      case S2C.WELCOME:
        if (u8.length < 7) return null;
        return { type: 'welcome', id: v.getUint16(1, true), tick: v.getUint32(3, true) };
      case S2C.SNAPSHOT: {
        if (u8.length < SNAP_HEADER) return null;
        const tick = v.getUint32(1, true);
        const ack = v.getUint32(5, true);
        let o = SNAP_HEADER;
        const np = v.getUint16(o, true);
        o += 2;
        const players: PlayerState[] = new Array(np);
        for (let i = 0; i < np; i++) {
          if (o + 12 > u8.length) return null;
          const flags = v.getUint8(o + 9);
          players[i] = {
            id: v.getUint16(o, true),
            x: dequantPos(v.getUint16(o + 2, true)),
            y: dequantPos(v.getUint16(o + 4, true)),
            aim: dequantAngle(v.getUint16(o + 6, true)),
            hp: v.getUint8(o + 8),
            alive: (flags & FLAG_ALIVE) !== 0,
            invuln: (flags & FLAG_INVULN) !== 0,
            score: v.getUint16(o + 10, true),
          };
          o += 12;
        }
        const nb = v.getUint16(o, true);
        o += 2;
        const bullets: BulletState[] = new Array(nb);
        for (let i = 0; i < nb; i++) {
          if (o + 8 > u8.length) return null;
          bullets[i] = {
            id: v.getUint16(o, true),
            owner: v.getUint16(o + 2, true),
            x: dequantPos(v.getUint16(o + 4, true)),
            y: dequantPos(v.getUint16(o + 6, true)),
          };
          o += 8;
        }
        return { type: 'snapshot', snapshot: { tick, ack, players, bullets } };
      }
      case S2C.KILL:
        if (u8.length < 9) return null;
        return {
          type: 'kill',
          killer: v.getUint16(1, true),
          victim: v.getUint16(3, true),
          x: dequantPos(v.getUint16(5, true)),
          y: dequantPos(v.getUint16(7, true)),
        };
      case S2C.JOINED: {
        if (u8.length < 4) return null;
        const len = v.getUint8(3);
        if (len > MAX_NAME_LEN || u8.length !== 4 + len) return null;
        return { type: 'joined', id: v.getUint16(1, true), name: textDecoder.decode(u8.subarray(4, 4 + len)) };
      }
      case S2C.LEFT:
        if (u8.length < 3) return null;
        return { type: 'left', id: v.getUint16(1, true) };
      case S2C.PONG:
        if (u8.length < 9) return null;
        return { type: 'pong', stamp: v.getUint32(1, true), tick: v.getUint32(5, true) };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
