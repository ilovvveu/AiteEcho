import { loadConfig } from '../config/index.js';
import { logger } from '../infra/logger.js';
import { ACPAgentBridge } from '../agents/acp/bridge.js';

interface SmokeOptions {
  expectedText: string;
  promptText: string;
  smokeLabel: string;
}

export async function runAcpAgentSmoke(options: SmokeOptions): Promise<void> {
  const config = loadConfig(process.env);
  const bridge = new ACPAgentBridge(config, logger.child({ smoke: options.smokeLabel }));

  try {
    const response = await bridge.sendPrompt({
      text: options.promptText,
      onProgress: (state) => {
        console.log(
          'PROGRESS',
          JSON.stringify({
            text: state.accumulatedText.slice(-120),
            tools: state.accumulatedToolCalls.slice(-5).map((item) => ({
              title: item.title,
              status: item.status,
            })),
            plan: (state.currentPlan as { entries?: unknown[] } | undefined)?.entries?.length ?? null,
          }),
        );
      },
    });

    console.log('FINAL', JSON.stringify(response));

    if (!response.text.includes(options.expectedText)) {
      throw new Error(
        `smoke check failed: expected reply to include ${JSON.stringify(options.expectedText)}, got ${JSON.stringify(response.text)}`,
      );
    }

    console.log(options.expectedText);
  } finally {
    await bridge.stop();
  }
}
