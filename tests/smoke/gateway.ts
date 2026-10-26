import { WebSocketServer } from "ws";
import type { QqApi } from "../../src/adapters/qq/api.js";
import type { QqAuth } from "../../src/adapters/qq/auth.js";
import { QqGateway } from "../../src/adapters/qq/gateway.js";

const server = new WebSocketServer({ port: 0 });
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const address = server.address();
if (!address || typeof address === "string") throw new Error("no ws server port");
const port = address.port;

let heartbeats = 0;
let identified = false;
let resolveEvent: (() => void) | undefined;
const eventPromise = new Promise<void>((resolve) => {
  resolveEvent = resolve;
});

server.on("connection", (socket) => {
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } }));

  socket.on("message", (raw) => {
    const payload = JSON.parse(raw.toString()) as { op: number };
    if (payload.op === 2) {
      identified = true;
      socket.send(
        JSON.stringify({
          op: 0,
          s: 1,
          t: "READY",
          d: { session_id: "ses_smoke" },
        }),
      );
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            s: 2,
            t: "GROUP_AT_MESSAGE_CREATE",
            d: {
              id: "m1",
              group_openid: "g1",
              content: "hello",
              author: { member_openid: "u1", username: "测试用户" },
            },
          }),
        );
      }, 30);
    }
    if (payload.op === 1) {
      heartbeats += 1;
      socket.send(JSON.stringify({ op: 11 }));
    }
  });
});

const gateway = new QqGateway({
  auth: { getToken: async () => "test-token" } as unknown as QqAuth,
  api: {
    getGatewayUrl: async () => `ws://127.0.0.1:${port}`,
  } as unknown as QqApi,
  intents: 33554432,
  onEvent: (type, data) => {
    console.log("EVENT", type, JSON.stringify(data));
    if (type === "GROUP_AT_MESSAGE_CREATE") resolveEvent?.();
  },
});

try {
  await gateway.start();
  await gateway.waitUntilReady(5_000);
  await Promise.race([
    eventPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("event timeout")), 5_000)),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (!identified) throw new Error("gateway 没有发送 identify");
  if (heartbeats < 1) throw new Error("gateway 没有发送心跳");
  console.log("GATEWAY OK", { identified, heartbeats });
} finally {
  await gateway.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
