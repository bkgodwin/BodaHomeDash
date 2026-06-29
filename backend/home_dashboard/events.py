from __future__ import annotations

import asyncio
from typing import Any

from fastapi import WebSocket


class EventHub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.add(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        self.clients.discard(websocket)

    async def broadcast(self, event: str, payload: Any = None) -> None:
        message = {"event": event, "payload": payload}
        stale: list[WebSocket] = []
        for client in list(self.clients):
            try:
                await client.send_json(message)
            except Exception:
                stale.append(client)
        for client in stale:
            self.clients.discard(client)

    def broadcast_threadsafe(self, event: str, payload: Any = None) -> None:
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(event, payload), self.loop)


hub = EventHub()
