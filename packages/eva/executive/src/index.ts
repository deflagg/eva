import { getModel } from '@mariozechner/pi-ai';

import { loadAgentConfig, loadAgentSecrets } from './config.js';
import { startAgentServer } from './server.js';

function main(): void {
  const config = loadAgentConfig();
  const secrets = loadAgentSecrets(config.secretsFilePath);

  try {
    getModel(config.model.provider as never, config.model.id as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[agent] invalid model configuration (${config.model.provider}/${config.model.id}): ${message}`);
  }

  startAgentServer({ config, secrets });
}

main();
