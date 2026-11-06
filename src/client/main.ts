import { BULLET_RADIUS, MAX_HP, TICK_MS } from '../shared/constants';
import { encodeInput, encodeJoin, encodePing } from '../shared/protocol';
import { ClientGame } from './game';
import { Input } from './input';
import { Net } from './net';
import { Renderer, colorOf } from './render';

interface LevelTarget {
  x: number;
  y: number;
  r: number;
  alive: boolean;
}

interface LevelDef {
  id: number;
  name: string;
  targets: Array<{ x: number; y: number; r: number }>;
}

const LEVELS: LevelDef[] = [
  {
    id: 1,
    name: 'Початок',
    targets: [
      { x: 520, y: 380, r: 18 },
      { x: 760, y: 380, r: 18 },
      { x: 640, y: 600, r: 20 },
    ],
  },
  {
    id: 2,
    name: 'Блокада',
    targets: [
      { x: 420, y: 260, r: 18 },
      { x: 680, y: 260, r: 18 },
      { x: 1020, y: 260, r: 18 },
      { x: 520, y: 620, r: 18 },
      { x: 860, y: 620, r: 18 },
    ],
  },
  {
    id: 3,
    name: 'Поріг',
    targets: [
      { x: 420, y: 340, r: 16 },
      { x: 620, y: 340, r: 16 },
      { x: 820, y: 340, r: 16 },
      { x: 1020, y: 340, r: 16 },
      { x: 520, y: 620, r: 18 },
      { x: 840, y: 620, r: 18 },
      { x: 1140, y: 620, r: 18 },
    ],
  },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('game');
const menu = $('menu');
const introPane = $('menu-intro');
const pausePane = $('pause-menu');
const optionsPane = $('options-menu');
const nameInput = $<HTMLInputElement>('name');
const playBtn = $<HTMLButtonElement>('play');
const resumeBtn = $<HTMLButtonElement>('resume');
const optionsBtn = $<HTMLButtonElement>('options');
const quitBtn = $<HTMLButtonElement>('quit');
const optionsBackBtn = $<HTMLButtonElement>('options-back');
const predictionToggle = $<HTMLInputElement>('opt-prediction');
const debugToggle = $<HTMLInputElement>('opt-debug');
const hudToggle = $<HTMLInputElement>('opt-hud');
const levelSelect = $<HTMLSelectElement>('level-select');
const status = $('status');
const hpFill = $('hp-fill');
const hpText = $('hp-text');
const board = $('board');
const feed = $('feed');
const debug = $('debug');
const deadNote = $('dead');

const params = new URLSearchParams(location.search);
const lagMs = Math.max(0, Number(params.get('lag') ?? 0) || 0);

const renderer = new Renderer(canvas);
const input = new Input(canvas);
const game = new ClientGame();
let net: Net | null = null;
let running = false;
let menuOpen = true;
let currentLevel: LevelDef | null = null;
let levelTargets: LevelTarget[] = [];
let levelCleared = false;

function buildLevelState(level: LevelDef): LevelTarget[] {
  return level.targets.map((t) => ({ ...t, alive: true }));
}

function selectLevelFromMenu(): void {
  const idx = Number(levelSelect.value) || 0;
  currentLevel = LEVELS[idx] ?? LEVELS[0];
  levelTargets = buildLevelState(currentLevel);
  levelCleared = false;
  if (status) status.textContent = `Вибрано: ${currentLevel.name}.`;
}

function maybeAdvanceLevel(): void {
  const level = currentLevel;
  if (!level) return;
  const idx = LEVELS.findIndex((l) => l.id === level.id);
  const next = LEVELS[(idx + 1) % LEVELS.length];
  levelSelect.value = String(LEVELS.indexOf(next));
  currentLevel = next;
  levelTargets = buildLevelState(currentLevel);
  levelCleared = false;
  if (status) status.textContent = `Рівень пройдено! Далі: ${currentLevel.name}.`;
}

function readOption(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === '1' || raw === 'true';
}

function writeOption(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode */
  }
}

function applyOptions(): void {
  game.prediction = predictionToggle.checked;
  debug.style.display = debugToggle.checked ? '' : 'none';
  const hudVisible = hudToggle.checked;
  document.body.classList.toggle('hud-hidden', !hudVisible);
  writeOption('neon-prediction', game.prediction);
  writeOption('neon-debug', debugToggle.checked);
  writeOption('neon-hud', hudVisible);
}

function showIntroMenu(): void {
  menuOpen = true;
  introPane.classList.remove('hidden');
  pausePane.classList.add('hidden');
  optionsPane.classList.add('hidden');
  menu.classList.remove('hidden');
  input.enabled = false;
  status.textContent = '';
}

function showPauseMenu(): void {
  menuOpen = true;
  introPane.classList.add('hidden');
  pausePane.classList.remove('hidden');
  optionsPane.classList.add('hidden');
  menu.classList.remove('hidden');
  input.enabled = false;
}

function hideMenu(): void {
  menuOpen = false;
  menu.classList.add('hidden');
  input.enabled = !!net && running;
}

function disconnectToMenu(): void {
  running = false;
  input.enabled = false;
  if (net) {
    net.close();
    net = null;
  }
  game.myId = 0;
  game.names.clear();
  showIntroMenu();
  playBtn.disabled = false;
  playBtn.textContent = 'Грати';
  status.textContent = 'Вийшли в меню.';
}

nameInput.value = localStorage.getItem('neon-name') ?? '';
levelSelect.value = String(localStorage.getItem('neon-level') ? Number(localStorage.getItem('neon-level')) : 0);
predictionToggle.checked = readOption('neon-prediction', true);
debugToggle.checked = readOption('neon-debug', true);
hudToggle.checked = readOption('neon-hud', true);
applyOptions();
selectLevelFromMenu();
showIntroMenu();

// ---------------------------------------------------------------- connect

function connect(): void {
  const name = nameInput.value.trim() || 'player';
  const idx = Number(levelSelect.value) || 0;
  try {
    localStorage.setItem('neon-name', name);
    localStorage.setItem('neon-level', String(idx));
  } catch {
    /* private mode */
  }
  selectLevelFromMenu();
  playBtn.disabled = true;
  status.textContent = `Підключення… ${currentLevel?.name ?? 'Рівень'}`;
  menu.classList.remove('hidden');

  net = new Net(
    {
      onOpen: () => net!.send(encodeJoin(name)),
      onClose: (reason) => {
        running = false;
        input.enabled = false;
        showIntroMenu();
        playBtn.disabled = false;
        playBtn.textContent = 'Зʼєднатись знову';
        status.textContent = `Зʼєднання розірвано (${reason}).`;
        if (net) {
          net = null;
        }
      },
      onMessage: (m) => {
        switch (m.type) {
          case 'welcome':
            game.myId = m.id;
            menu.classList.add('hidden');
            menuOpen = false;
            input.enabled = true;
            if (!running) {
              running = true;
              last = performance.now();
              acc = 0;
              requestAnimationFrame(frame);
            }
            break;
          case 'joined':
            game.names.set(m.id, m.name);
            break;
          case 'left':
            game.names.delete(m.id);
            break;
          case 'snapshot':
            game.onSnapshot(m.snapshot, performance.now());
            break;
          case 'kill': {
            renderer.burst(m.x, m.y, colorOf(m.victim));
            const killer = game.names.get(m.killer) ?? '?';
            const victim = game.names.get(m.victim) ?? '?';
            const row = document.createElement('div');
            row.textContent = `${killer} → ${victim}`;
            row.style.color = colorOf(m.killer);
            feed.prepend(row);
            setTimeout(() => row.remove(), 5000);
            while (feed.children.length > 5) feed.lastElementChild?.remove();
            break;
          }
          case 'pong':
            game.rttMs = ((Math.floor(performance.now()) >>> 0) - m.stamp) >>> 0;
            break;
        }
      },
    },
    lagMs,
  );
}

levelSelect.addEventListener('change', () => {
  selectLevelFromMenu();
  const idx = Number(levelSelect.value) || 0;
  try {
    localStorage.setItem('neon-level', String(idx));
  } catch {
    /* private mode */
  }
});
playBtn.addEventListener('click', connect);
resumeBtn.addEventListener('click', () => {
  if (net) {
    hideMenu();
    input.enabled = true;
  }
});
optionsBtn.addEventListener('click', () => {
  introPane.classList.add('hidden');
  pausePane.classList.add('hidden');
  optionsPane.classList.remove('hidden');
});
optionsBackBtn.addEventListener('click', () => {
  if (running && net) {
    showPauseMenu();
  } else {
    showIntroMenu();
  }
});
quitBtn.addEventListener('click', () => disconnectToMenu());
predictionToggle.addEventListener('change', () => {
  game.prediction = predictionToggle.checked;
  writeOption('neon-prediction', game.prediction);
});
debugToggle.addEventListener('change', () => {
  debug.style.display = debugToggle.checked ? '' : 'none';
  writeOption('neon-debug', debugToggle.checked);
});
hudToggle.addEventListener('change', () => {
  document.body.classList.toggle('hud-hidden', !hudToggle.checked);
  writeOption('neon-hud', hudToggle.checked);
});
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect();
});
input.onToggle = () => {
  game.prediction = !game.prediction;
  predictionToggle.checked = game.prediction;
  writeOption('neon-prediction', game.prediction);
};
input.onEscape = () => {
  if (!net) return;
  if (menuOpen) {
    hideMenu();
  } else {
    showPauseMenu();
  }
};

setInterval(() => {
  net?.send(encodePing(Math.floor(performance.now()) >>> 0));
}, 1000);

// ---------------------------------------------------------------- loop

let last = 0;
let acc = 0;
let fps = 60;
let hudTimer = 0;

/** One fixed simulation step: sample input -> predict locally -> send. */
function fixedStep(): void {
  if (menuOpen || !input.enabled) return;
  const pos = game.myPosition();
  let aim = 0;
  if (pos) {
    const s = renderer.screenOf(pos.x, pos.y);
    aim = Math.atan2(input.mouseY - s.y, input.mouseX - s.x);
  }
  const cmd = game.step(input.buttons(), aim);
  net?.send(encodeInput(cmd));
}

function frame(now: number): void {
  if (!running) return;
  requestAnimationFrame(frame);

  let dt = now - last;
  last = now;
  if (dt > 100) dt = 100; // tab was in the background: don't fast-forward
  fps += (1000 / Math.max(dt, 1) - fps) * 0.05;

  acc += dt;
  let steps = 0;
  while (acc >= TICK_MS && steps < 6) {
    fixedStep();
    acc -= TICK_MS;
    steps++;
  }
  if (acc > TICK_MS) acc = 0;

  const dtSec = dt / 1000;
  game.updateVisual(dtSec);

  const pos = game.myPosition();
  let aim = 0;
  if (pos) {
    const s = renderer.screenOf(pos.x, pos.y);
    aim = Math.atan2(input.mouseY - s.y, input.mouseX - s.x);
  }
  const state = game.getRenderState(now, aim);
  if (levelTargets.length > 0) {
    for (const target of levelTargets) {
      if (!target.alive) continue;
      for (const bullet of state.bullets) {
        if (Math.hypot(bullet.x - target.x, bullet.y - target.y) <= target.r + BULLET_RADIUS + 2) {
          target.alive = false;
        }
      }
    }
    const alive = levelTargets.filter((t) => t.alive).length;
    if (alive === 0 && !levelCleared) {
      levelCleared = true;
      status.textContent = `Рівень пройдено: ${currentLevel?.name ?? 'Готово'}!`;
      maybeAdvanceLevel();
    }
  }

  renderer.draw(state, pos, game.names, now, dtSec);
  renderer.drawLevelTargets(levelTargets);

  hudTimer += dt;
  if (hudTimer > 120) {
    hudTimer = 0;
    updateHud(state.players);
  }
}

function updateHud(players: { id: number; hp: number; score: number; isMe: boolean; alive: boolean }[]): void {
  const me = players.find((p) => p.isMe);
  if (me) {
    hpFill.style.width = `${(me.hp / MAX_HP) * 100}%`;
    hpText.textContent = String(me.hp);
    deadNote.classList.toggle('hidden', me.alive);
  }
  const top = [...players].sort((a, b) => b.score - a.score).slice(0, 8);
  board.replaceChildren(
    ...top.map((p) => {
      const row = document.createElement('div');
      row.className = p.isMe ? 'row me' : 'row';
      const n = document.createElement('span');
      n.textContent = game.names.get(p.id) ?? '?';
      n.style.color = colorOf(p.id);
      const s = document.createElement('span');
      s.textContent = String(p.score);
      row.append(n, s);
      return row;
    }),
  );
  debug.textContent =
    `${fps.toFixed(0)} fps · ping ${game.rttMs} мс${lagMs ? ` (+${lagMs} імітація)` : ''} · ` +
    `непідтв. вводів ${game.pendingCount} · корекція ${game.lastCorrection.toFixed(1)} px · ` +
    `передбачення ${game.prediction ? 'увімк' : 'вимк'} (P)`;
}
