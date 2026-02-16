import { getModel } from '@mariozechner/pi-ai';

import { loadVisionAgentConfig, loadVisionAgentSecrets } from './config.js';
import { startVisionAgentServer } from './server.js';

function main(): void {
  const config = loadVisionAgentConfig();
  const secrets = loadVisionAgentSecrets(config.secretsFilePath);

  try {
    getModel(config.model.provider as never, config.model.id as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[vision-agent] invalid model configuration (${config.model.provider}/${config.model.id}): ${message}`);
  }

  startVisionAgentServer({
    config,
    secrets,
  });
}

main();
