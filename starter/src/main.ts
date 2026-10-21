import { createStarter } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const starter = createStarter(config);

starter.server.listen(config.port, async () => {
  console.log(`Starter shop running on http://localhost:${config.port} (webhook endpoint: /webhooks/printarex)`);
  await starter.start();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void starter.stop().then(() => process.exit(0)));
}
