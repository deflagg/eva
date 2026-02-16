import { loadEvaConfig } from './config.js';
import { startServer } from './server.js';

const config = loadEvaConfig();

startServer({
  port: config.server.port,
  eyePath: config.server.eyePath,
  quickvisionWsUrl: config.quickvision.wsUrl,
});
