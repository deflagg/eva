import http from 'node:http';

export interface EvaServerConfig {
  port: number;
  quickVisionWsUrl: string;
}

export interface EvaServer {
  start: () => void;
  stop: () => Promise<void>;
}

export function createEvaServer(config: EvaServerConfig): EvaServer {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'eva',
        status: 'stub',
        quickvision_ws_url: config.quickVisionWsUrl
      })
    );
  });

  return {
    start: () => {
      server.listen(config.port, () => {
        console.log(`[eva] listening on http://localhost:${config.port}`);
      });
    },
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      })
  };
}
