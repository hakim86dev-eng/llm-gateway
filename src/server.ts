import { loadConfig } from './config.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  app.close().then(
    () => process.exit(0),
    (error: unknown) => {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    },
  );
};
process.once('SIGINT', () => {
  shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  shutdown('SIGTERM');
});

await app.listen({ port: config.port, host: config.host });
