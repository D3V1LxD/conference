import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


@dataclass
class Room:
    key: str
    clients: dict[str, WebSocket] = field(default_factory=dict)
    names: dict[str, str] = field(default_factory=dict)


app = FastAPI(title="Conferly Signaling Server")

# Keep this permissive for easier first deploy. Restrict origins in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

rooms: dict[str, Room] = {}


async def send_json_safe(ws: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        # Ignore send failures; disconnect cleanup handles stale sockets.
        pass


async def broadcast(room: Room, payload: dict[str, Any], exclude_id: str | None = None) -> None:
    for peer_id, client in list(room.clients.items()):
        if exclude_id and peer_id == exclude_id:
            continue
        await send_json_safe(client, payload)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_signaling(ws: WebSocket) -> None:
    await ws.accept()

    room_id: str | None = None
    peer_id: str | None = None
    display_name: str | None = None

    try:
        while True:
            raw = await ws.receive_text()

            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await send_json_safe(ws, {"type": "error", "message": "Invalid JSON payload."})
                continue

            msg_type = str(message.get("type", "")).strip()

            if msg_type == "join":
                requested_room = str(message.get("roomId", "")).strip()
                requested_key = str(message.get("key", "")).strip()
                requested_name = str(message.get("name", "")).strip()

                if not requested_room or not requested_key:
                    await send_json_safe(ws, {"type": "error", "message": "Room and key are required."})
                    continue

                room = rooms.get(requested_room)
                if room is None:
                    room = Room(key=requested_key)
                    rooms[requested_room] = room

                if room.key != requested_key:
                    await send_json_safe(
                        ws,
                        {"type": "error", "message": "Invalid security key for this room."},
                    )
                    continue

                room_id = requested_room
                peer_id = str(uuid.uuid4())
                display_name = requested_name or f"Participant {peer_id[:8]}"

                existing_peers = list(room.clients.keys())
                room.clients[peer_id] = ws
                room.names[peer_id] = display_name

                await send_json_safe(ws, {"type": "joined", "selfId": peer_id, "peers": existing_peers})
                await broadcast(room, {"type": "peer-joined", "peerId": peer_id}, exclude_id=peer_id)
                continue

            if not room_id or not peer_id:
                await send_json_safe(ws, {"type": "error", "message": "You must join a room first."})
                continue

            room = rooms.get(room_id)
            if room is None:
                await send_json_safe(ws, {"type": "error", "message": "Room does not exist."})
                continue

            if msg_type == "leave":
                break

            if msg_type == "chat":
                text = str(message.get("text", "")).strip()
                if text:
                    await broadcast(
                        room,
                        {
                            "type": "chat",
                            "from": peer_id,
                            "author": display_name or f"Participant {peer_id[:8]}",
                            "text": text,
                            "messageId": str(uuid.uuid4()),
                            "sentAt": int(time.time() * 1000),
                        },
                    )
                continue

            if msg_type == "raise-hand":
                await broadcast(
                    room,
                    {
                        "type": "raise-hand",
                        "from": peer_id,
                        "raised": bool(message.get("raised", False)),
                    },
                )
                continue

            if msg_type in {"offer", "answer", "ice-candidate"}:
                target_id = str(message.get("to", "")).strip()
                target_ws = room.clients.get(target_id)
                if target_ws is None:
                    continue

                await send_json_safe(
                    target_ws,
                    {
                        "type": msg_type,
                        "from": peer_id,
                        "to": target_id,
                        "sdp": message.get("sdp"),
                        "candidate": message.get("candidate"),
                    },
                )

    except WebSocketDisconnect:
        pass
    finally:
        if room_id and peer_id:
            room = rooms.get(room_id)
            if room:
                room.clients.pop(peer_id, None)
                room.names.pop(peer_id, None)

                await broadcast(room, {"type": "peer-left", "peerId": peer_id}, exclude_id=peer_id)

                if not room.clients:
                    rooms.pop(room_id, None)
