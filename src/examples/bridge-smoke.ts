import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { logger } from '../infra/logger.js';
import { ACPAgentBridge } from '../agents/acp/bridge.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

process.env.ACP_AGENT_COMMAND = process.execPath;
process.env.ACP_AGENT_ARGS_JSON = JSON.stringify(['--import', 'tsx', 'src/examples/mock-acp-agent.ts']);
process.env.ACP_AGENT_WORKDIR = repoRoot;
process.env.ACP_VERBOSE_MODE = 'verbose';

async function main() {
  const config = loadConfig(process.env);
  const bridge = new ACPAgentBridge(config, logger.child({ smoke: 'bridge' }));
  const response = await bridge.sendPrompt({
    text: '你好，帮我总结这个项目',
    onProgress: (state) => {
      console.log('PROGRESS', JSON.stringify({
        text: state.accumulatedText,
        plan: (state.currentPlan as any)?.entries?.length,
        tools: state.accumulatedToolCalls.map((x) => ({ title: x.title, status: x.status })),
      }));
    },
  });
  console.log('FINAL', JSON.stringify(response));
  await bridge.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
