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
        clients = list(self.clients)
        if not clients:
            return

        async def send(client: WebSocket) -> WebSocket | None:
            try:
                await asyncio.wait_for(client.send_json(message), timeout=2)
                return None
            except Exception:
                return client

        stale = await asyncio.gather(*(send(client) for client in clients))
        for client in stale:
            if client is not None:
                self.clients.discard(client)
            self.clients.discard(client)

    def broadcast_threadsafe(self, event: str, payload: Any = None) -> None:
        if self.loop and self.loop.is_running():
            asyncio.run_coroutine_threadsafe(self.broadcast(event, payload), self.loop)


hub = EventHub()
