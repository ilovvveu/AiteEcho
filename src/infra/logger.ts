import pino from 'pino';
import { loadDotEnv } from './env-file.js';

loadDotEnv();

const transport = process.stdout.isTTY
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
  : undefined;

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  transport,
});
