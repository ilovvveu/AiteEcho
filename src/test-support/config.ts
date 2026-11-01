import { loadConfig, type AppConfig } from '../config/index.js';

/** Messaging fixtures explicitly opt in; production defaults remain closed. */
export function loadMessageTestConfig(env: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({ ONEBOT_ALLOW_GROUP: 'true', ONEBOT_ALLOW_PRIVATE: 'true', ONEBOT_OWNER_USERS: '1', ...env });
}
