import path from 'node:path';
import { parseJsonStringArray } from './env.js';

export const DEFAULT_TRAE_ACP_ARGS = ['acp', 'serve'];

const TRAE_ACP_COMMANDS = new Set(['traex', 'traex.exe', 'traecli', 'traecli.exe']);

export function isTraeAcpCommand(command: string | undefined): boolean {
  const trimmed = command?.trim();
  if (!trimmed) {
    return false;
  }
  return TRAE_ACP_COMMANDS.has(path.basename(trimmed).toLowerCase());
}

export function resolveAcpAgentArgs(rawArgs: string | undefined, agentCommand: string | undefined): string[] {
  const parsed = parseJsonStringArray(rawArgs, []);
  if (parsed.length > 0) {
    return parsed;
  }
  if (isTraeAcpCommand(agentCommand)) {
    return [...DEFAULT_TRAE_ACP_ARGS];
  }
  return [];
}
