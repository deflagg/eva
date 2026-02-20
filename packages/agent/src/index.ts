import { loadAgentConfig } from './config.js';
import { startAgentServer } from './server.js';

function main(): void {
  const config = loadAgentConfig();
  startAgentServer({ config });
}

main();
