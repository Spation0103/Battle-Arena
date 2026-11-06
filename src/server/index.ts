import path from 'node:path';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 3000);
const server = await startServer({
  port,
  host: process.env.HOST ?? '0.0.0.0',
  staticDir: process.env.STATIC_DIR ?? path.resolve(process.cwd(), 'dist/public'),
  botFill: Number(process.env.BOT_FILL ?? 4),
  cache: process.env.NODE_ENV === 'production',
});
console.log(`[Battle City] listening on :${server.port}`);

const shutdown = async () => {
  console.log('[Battle City] shutting down');
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
