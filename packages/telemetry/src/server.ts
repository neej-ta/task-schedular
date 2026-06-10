import http from 'node:http';
import { metricsText, metricsContentType } from './metrics.js';

// Minimal /metrics HTTP server for services that don't already run one (workers).
export function startMetricsServer(port: number, log: (m: string) => void = console.log): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      metricsText()
        .then((body) => {
          res.writeHead(200, { 'Content-Type': metricsContentType() });
          res.end(body);
        })
        .catch((err) => {
          res.writeHead(500);
          res.end(String(err));
        });
      return;
    }
    if (req.url === '/healthz') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, () => log(`metrics server on :${port}`));
  return server;
}
