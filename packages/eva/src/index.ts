import { startServer } from './server.js';

const port = Number(process.env.EVA_PORT ?? 8787);
const quickvisionWsUrl = process.env.QUICKVISION_WS_URL ?? 'ws://localhost:8000/infer';

startServer({
  port,
  quickvisionWsUrl,
});
