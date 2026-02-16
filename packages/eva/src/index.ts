import { createEvaServer } from './server.js';

const port = Number(process.env.EVA_PORT ?? 8787);
const quickVisionWsUrl = process.env.QUICKVISION_WS_URL ?? 'ws://localhost:8000/infer';

const server = createEvaServer({
  port,
  quickVisionWsUrl
});

server.start();
