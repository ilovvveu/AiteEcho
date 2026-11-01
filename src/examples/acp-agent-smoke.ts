import { loadDotEnv } from '../infra/env-file.js';
import { runAcpAgentSmoke } from './acp-smoke-lib.js';

loadDotEnv();

const agentCommand = process.env.ACP_AGENT_COMMAND?.trim();
if (!agentCommand) {
  console.error('ACP_AGENT_COMMAND is not set. Please configure your ACP agent in .env or the current shell first.');
  process.exit(1);
}

const expectedText = process.env.ACP_SMOKE_EXPECTED_TEXT ?? 'ACP_SMOKE_OK';
const promptText = process.env.ACP_SMOKE_PROMPT ?? `请只回复：${expectedText}`;

runAcpAgentSmoke({
  expectedText,
  promptText,
  smokeLabel: 'agent',
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
