// Everything here is shared by client and server. Changing a value changes the
// protocol/simulation contract, so bump PROTOCOL_VERSION when you do.

export const PROTOCOL_VERSION = 1;

// Simulation: one input command == one fixed step of DT seconds.
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

// Server sends snapshots every N ticks (60 / 2 = 30 Hz).
export const SNAPSHOT_EVERY = 2;
export const SNAPSHOT_MS = TICK_MS * SNAPSHOT_EVERY;

// Remote entities are rendered this far in the past so we can interpolate.
export const INTERP_DELAY_MS = 100;

export const WORLD_W = 2000;
export const WORLD_H = 1400;

export const PLAYER_RADIUS = 16;
export const PLAYER_SPEED = 260; // px/s
export const MAX_HP = 100;

export const BULLET_RADIUS = 4;
export const BULLET_SPEED = 720; // px/s
export const BULLET_TTL_TICKS = 70; // ~1.17 s -> ~840 px range
export const BULLET_DAMAGE = 20;
export const FIRE_COOLDOWN_TICKS = 12; // 5 shots/s

export const RESPAWN_TICKS = 120; // 2 s
export const SPAWN_PROTECTION_TICKS = 90; // 1.5 s

export const MAX_PLAYERS = 24;
export const MAX_NAME_LEN = 16;

// Anti-speedhack: the server grants each player 1 input per tick, with a small
// "bank" so a network hiccup can be caught up, but a flood of inputs can't.
export const MAX_INPUT_BUDGET = 6;
export const MAX_INPUT_QUEUE = 30;

// Input button bits (1 byte on the wire).
export const BTN = {
  UP: 1,
  DOWN: 2,
  LEFT: 4,
  RIGHT: 8,
  FIRE: 16,
} as const;
export const BTN_MASK = 0x1f;
