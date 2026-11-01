import { describe, expect, it } from 'vitest';
import { isTraeAcpCommand, resolveAcpAgentArgs } from './acp-agent.js';

describe('acp agent defaults', () => {
  it('detects traex-style commands by basename', () => {
    expect(isTraeAcpCommand('traex')).toBe(true);
    expect(isTraeAcpCommand('/usr/local/bin/traex')).toBe(true);
    expect(isTraeAcpCommand('traecli.exe')).toBe(true);
    expect(isTraeAcpCommand('node')).toBe(false);
  });

  it('falls back to acp serve when traex args are omitted', () => {
    expect(resolveAcpAgentArgs(undefined, 'traex')).toEqual(['acp', 'serve']);
    expect(resolveAcpAgentArgs('', 'traecli')).toEqual(['acp', 'serve']);
  });

  it('preserves explicit args for non-traex commands', () => {
    expect(resolveAcpAgentArgs('["--import","tsx","src/examples/mock-acp-agent.ts"]', 'node')).toEqual([
      '--import',
      'tsx',
      'src/examples/mock-acp-agent.ts',
    ]);
    expect(resolveAcpAgentArgs(undefined, 'node')).toEqual([]);
  });
});
