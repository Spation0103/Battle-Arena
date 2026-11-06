import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { MAX_NAME_LEN, PROTOCOL_VERSION, TICK_MS } from '../shared/constants';
import { decodeClientMessage, encodePong } from '../shared/protocol';
import { Game, type Player } from './game';

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir: string;
  botFill: number;
  /** Cache static files in memory (production). */
  cache?: boolean;
  /** Serve static files from memory instead of disk (single-file .exe). Keys: 'index.html', 'main.js'. */
  assets?: Map<string, Buffer>;
}

export interface RunningServer {
  port: number;
  game: Game;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface CachedFile {
  body: Buffer;
  gz: Buffer | null;
  type: string;
}

const MAX_MSGS_PER_SEC = 240; // 60 inputs/s + pings, with generous headroom

function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, MAX_NAME_LEN);
  return n || 'player';
}

function toU8(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return raw;
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const game = new Game({ botFill: opts.botFill });
  const root = path.resolve(opts.staticDir);
  const cache = new Map<string, CachedFile>();

  function loadFile(abs: string): CachedFile | null {
    if (opts.cache) {
      const hit = cache.get(abs);
      if (hit) return hit;
    }
    try {
      const body = fs.readFileSync(abs);
      const ext = path.extname(abs);
      const compressible = ext === '.html' || ext === '.js' || ext === '.map';
      const file: CachedFile = {
        body,
        gz: compressible && opts.cache ? zlib.gzipSync(body, { level: 9 }) : null,
        type: MIME[ext] ?? 'application/octet-stream',
      };
      if (opts.cache) cache.set(abs, file);
      return file;
    } catch {
      return null;
    }
  }

  const assetCache = new Map<string, CachedFile>();
  function loadAsset(rel: string): CachedFile | null {
    const hit = assetCache.get(rel);
    if (hit) return hit;
    const body = opts.assets!.get(rel);
    if (!body) return null;
    const ext = path.extname(rel);
    const file: CachedFile = {
      body,
      gz: ext === '.html' || ext === '.js' ? zlib.gzipSync(body, { level: 9 }) : null,
      type: MIME[ext] ?? 'application/octet-stream',
    };
    assetCache.set(rel, file);
    return file;
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, players: game.humanCount(), tick: game.tick }));
      return;
    }
    let rel: string;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request'); // malformed %-escape
      return;
    }
    let file: CachedFile | null;
    if (opts.assets) {
      file = loadAsset(rel);
    } else {
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      file = loadFile(abs);
    }
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': file.type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (file.gz && acceptsGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = file.gz.length;
      res.writeHead(200, headers).end(file.gz);
    } else {
      headers['Content-Length'] = file.body.length;
      res.writeHead(200, headers).end(file.body);
    }
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: 512,
    perMessageDeflate: false, // tiny binary frames: compression only adds latency
  });

  // `ws` re-emits the HTTP server's errors (e.g. EADDRINUSE). They are reported
  // through the listen() promise below; without a listener Node would crash.
  wss.on('error', () => {});

  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws, req) => {
    req.socket.setNoDelay(true); // no Nagle: send small packets immediately
    alive.set(ws, true);
    let player: Player | null = null;
    let msgs = 0;

    const joinTimer = setTimeout(() => {
      if (!player) ws.close(1008, 'join timeout');
    }, 5000);
    const rateTimer = setInterval(() => (msgs = 0), 1000);

    ws.on('pong', () => alive.set(ws, true));

    ws.on('message', (raw, isBinary) => {
      if (!isBinary || ++msgs > MAX_MSGS_PER_SEC) {
        ws.close(1008, 'protocol violation');
        return;
      }
      const msg = decodeClientMessage(toU8(raw));
      if (!msg) return;
      switch (msg.type) {
        case 'join':
          if (player) return;
          if (msg.version !== PROTOCOL_VERSION) {
            ws.close(4000, 'version mismatch, reload the page');
            return;
          }
          player = game.addPlayer(sanitizeName(msg.name), ws);
          if (!player) ws.close(1013, 'server full');
          break;
        case 'input':
          if (player) game.handleInput(player, msg.cmd);
          break;
        case 'ping':
          ws.send(encodePong(msg.stamp, game.tick), { binary: true });
          break;
      }
    });

    ws.on('close', () => {
      clearTimeout(joinTimer);
      clearInterval(rateTimer);
      if (player) game.removePlayer(player);
    });
    ws.on('error', () => ws.terminate());
  });

  // Detect half-open connections.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 15000);

  // Fixed-timestep loop: accumulate real time, run as many 1/60 s steps as
  // are due (bounded, so a stall can't cause a death spiral).
  let next = performance.now();
  const loop = setInterval(() => {
    const now = performance.now();
    let n = 0;
    while (now >= next && n < 5) {
      game.step();
      next += TICK_MS;
      n++;
    }
    if (now >= next) next = now; // drop the backlog
  }, 4);

  return new Promise((resolve, reject) => {
    httpServer.once('error', (err) => {
      clearInterval(loop);
      clearInterval(heartbeat);
      wss.close();
      reject(err);
    });
    httpServer.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        port,
        game,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(loop);
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => httpServer.close(() => done()));
            httpServer.closeAllConnections?.();
          }),
      });
    });
  });
}
