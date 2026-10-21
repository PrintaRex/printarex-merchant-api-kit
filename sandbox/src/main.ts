import { createSandbox } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { server, close } = createSandbox(config);

server.listen(config.port, () => {
  const lines = [
    '',
    'PrintaRex Merchant API sandbox is running.',
    `  API base URL:        ${config.publicBaseUrl}/merchant/v1`,
    `  Full-access key:     ${config.fullAccessKey}`,
    `  Read-only key:       ${config.readOnlyKey}`,
    `  Webhook secret:      ${config.webhookSecret}`,
    `  Webhook URL:         ${config.webhookUrl ?? '(not set: POST /_sandbox/webhooks/endpoint {"url": "..."})'}`,
    `  Sandbox state:       ${config.publicBaseUrl}/_sandbox/state`,
    '',
    'These are sandbox-only values. They never work against UAT or production.',
    'Never put a real UAT or production key in SANDBOX_API_KEY: sandbox keys share the prx_uat_ format, so a real key would be printed here and kept in memory.',
    '',
  ];
  console.log(lines.join('\n'));
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void close().then(() => process.exit(0));
  });
}
