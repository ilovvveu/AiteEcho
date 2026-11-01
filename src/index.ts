import { loadConfig } from './config/index.js';
import { logger } from './infra/logger.js';
import { BotApplication } from './core/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new BotApplication(config, logger);
  await app.start();
}

main().catch((error) => {
  logger.error(
    { error: error instanceof Error ? error.stack || error.message : String(error) },
    'fatal error during startup',
  );
  process.exit(1);
});
