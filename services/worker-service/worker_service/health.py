"""Liveness and readiness endpoints.

Served by aiohttp on the worker's own event loop, so a blocked loop fails the
probe; a stale heartbeat catches a stuck consumer. (The Prometheus server runs
in a separate thread and cannot detect either.)
"""

from __future__ import annotations

from aiohttp import web

from worker_service.consumer import Worker


def build_health_app(worker: Worker) -> web.Application:
    async def healthz(_: web.Request) -> web.Response:
        if worker.is_live():
            return web.json_response({"status": "ok"})
        return web.json_response({"status": "stale"}, status=503)

    async def readyz(_: web.Request) -> web.Response:
        if worker.is_ready():
            return web.json_response({"status": "ready"})
        return web.json_response({"status": "not_ready"}, status=503)

    app = web.Application()
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/readyz", readyz)
    return app
