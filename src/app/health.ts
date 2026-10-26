import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";

export type HealthOptions = {
  host: string;
  port: number;
  dbPing: () => Promise<boolean>;
  isWsConnected: () => boolean;
  requiresWs: boolean;
  logger: Logger;
};

export function startHealthServer(options: HealthOptions): Server {
  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";

    if (url === "/healthz" || url === "/readyz") {
      const db = await options.dbPing().catch(() => false);
      const ws = options.isWsConnected();
      const ready = db && (!options.requiresWs || ws);
      const status = url === "/readyz" && !ready ? 503 : 200;

      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(
        JSON.stringify({
          ok: status === 200,
          db,
          ws,
          requiresWs: options.requiresWs,
          uptime: Math.round(process.uptime()),
        }),
      );
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
  });

  server.listen(options.port, options.host, () => {
    options.logger.info(`health server on http://${options.host}:${options.port}/healthz`);
  });

  return server;
}
