import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

const dev = process.env.NODE_ENV !== "production";
const host = "0.0.0.0";
const port = Number.parseInt(process.env.PORT || "3000", 10);
const app = next({ dev, hostname: host, port });
const handle = app.getRequestHandler();

/** @type {Map<string, { key: string, clients: Map<string, import('ws').WebSocket> }>} */
const rooms = new Map();

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, excludeId) {
  for (const [id, client] of room.clients.entries()) {
    if (excludeId && id === excludeId) {
      continue;
    }

    send(client, payload);
  }
}

app.prepare().then(() => {
  const handleUpgrade = app.getUpgradeHandler();
  const server = createServer((req, res) => handle(req, res));
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    // Keep Next.js dev/prod websocket upgrades (including HMR) intact.
    if (!req.url?.startsWith("/ws")) {
      await handleUpgrade(req, socket, head);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws);
    });
  });

  wss.on("connection", (ws) => {
    /** @type {{ roomId?: string, peerId?: string, name?: string }} */
    const ctx = {};

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid JSON payload." });
        return;
      }

      if (message.type === "join") {
        const roomId = String(message.roomId || "").trim();
        const key = String(message.key || "").trim();
        const name = String(message.name || "").trim();

        if (!roomId || !key) {
          send(ws, { type: "error", message: "Room and key are required." });
          return;
        }

        let room = rooms.get(roomId);
        if (!room) {
          room = { key, clients: new Map() };
          rooms.set(roomId, room);
        }

        if (room.key !== key) {
          send(ws, { type: "error", message: "Invalid security key for this room." });
          return;
        }

        const peerId = randomUUID();
        ctx.roomId = roomId;
        ctx.peerId = peerId;
        ctx.name = name || `Participant ${peerId.slice(0, 8)}`;

        const existingPeers = [...room.clients.keys()];
        room.clients.set(peerId, ws);

        send(ws, { type: "joined", selfId: peerId, peers: existingPeers });
        broadcast(room, { type: "peer-joined", peerId }, peerId);
        return;
      }

      const roomId = ctx.roomId;
      const fromId = ctx.peerId;

      if (!roomId || !fromId) {
        send(ws, { type: "error", message: "You must join a room first." });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { type: "error", message: "Room does not exist." });
        return;
      }

      if (message.type === "leave") {
        ws.close();
        return;
      }

      if (message.type === "chat") {
        const text = String(message.text || "").trim();
        if (!text) {
          return;
        }

        const chatPayload = {
          type: "chat",
          from: fromId,
          author: ctx.name || `Participant ${fromId.slice(0, 8)}`,
          text,
          messageId: randomUUID(),
          sentAt: Date.now(),
        };

        broadcast(room, chatPayload);
        return;
      }

      if (message.type === "raise-hand") {
        broadcast(room, {
          type: "raise-hand",
          from: fromId,
          raised: Boolean(message.raised),
        });
        return;
      }

      if (["offer", "answer", "ice-candidate"].includes(message.type)) {
        const to = String(message.to || "");
        const target = room.clients.get(to);
        if (!target) {
          return;
        }

        send(target, {
          type: message.type,
          from: fromId,
          to,
          sdp: message.sdp,
          candidate: message.candidate,
        });
      }
    });

    ws.on("close", () => {
      const roomId = ctx.roomId;
      const peerId = ctx.peerId;
      if (!roomId || !peerId) {
        return;
      }

      const room = rooms.get(roomId);
      if (!room) {
        return;
      }

      room.clients.delete(peerId);
      broadcast(room, { type: "peer-left", peerId }, peerId);

      if (room.clients.size === 0) {
        rooms.delete(roomId);
      }
    });
  });

  server.listen(port, host, () => {
    console.log(`> Ready on http://${host}:${port}`);
  });
});
