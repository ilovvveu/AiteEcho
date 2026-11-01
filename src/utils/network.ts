import { isIP } from 'node:net';

export function isLoopbackHost(host: string): boolean {
  return host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

export function strongAccessToken(token: string | undefined): boolean {
  return Boolean(token && token.length >= 24 && token.length <= 512 && !/\s/u.test(token)
    && !/^(?:change[-_]?me|replace[-_]?me|example|test|your[-_]?token)$/iu.test(token));
}
