// Entry point for the single-file Windows build (Node SEA).
// Console text is ASCII-only on purpose: cmd.exe often mangles Cyrillic.
import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from './server';

declare const require: NodeRequire;
const sea = require('node:sea') as typeof import('node:sea');

const ASSETS = ['index.html', 'main.js'];

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function waitForEnter(): Promise<void> {
  console.log('\nPress Enter to close this window...');
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function main(): Promise<void> {
  const assets = new Map<string, Buffer>();
  const staticDir = path.resolve(process.cwd(), 'dist/public');
  if (sea.isSea()) {
    for (const name of ASSETS) assets.set(name, Buffer.from(sea.getAsset(name) as ArrayBuffer));
  }

  const want = Number(process.env.PORT ?? 3000);
  let server: RunningServer | null = null;
  for (let port = want; port < want + 10 && !server; port++) {
    try {
      server = await startServer({
        port,
        host: '0.0.0.0',
        staticDir,
        botFill: Number(process.env.BOT_FILL ?? 4),
        cache: true,
        assets: sea.isSea() ? assets : undefined,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    }
  }
  if (!server) throw new Error(`ports ${want}-${want + 9} are all busy`);

  const port = server.port;
  console.log('=====================================');
  console.log('  BATTLE CITY server is running');
  console.log('=====================================');
  console.log(`  You (this PC):          http://localhost:${port}`);
  for (const ip of lanAddresses()) console.log(`  Same Wi-Fi / LAN:       http://${ip}:${port}`);
  console.log('');
  console.log('  Friend over the internet? A tunnel gives you a public https link:');
  console.log(`    cloudflared tunnel --url http://localhost:${port}`);
  console.log('  If Windows Firewall asks: click "Allow access".');
  console.log('  Keep this window open while you play. Close it to stop the server.');

  if (process.platform === 'win32' && !process.env.NO_BROWSER) {
    exec(`start "" "http://localhost:${port}"`);
  }
  process.on('SIGINT', () => server!.close().then(() => process.exit(0)));
}

main().catch(async (e) => {
  console.error('\nFailed to start:', e instanceof Error ? e.message : e);
  await waitForEnter();
  process.exit(1);
});
