import asyncio
import json
import logging

import redis.asyncio as aioredis

from .camera_worker import CameraWorker
from .config import (
    CONF_THRESHOLD,
    DEDUP_WINDOW_MS,
    MAX_EVENTS_PER_MIN,
    MODEL_PATH,
    MODEL_CLASSES,
    REDIS_URL,
)
from .dedup import DedupRateLimiter
from .detector import YoloDetector
from .signaling import handle_offer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("worker")


class WorkerApp:
    def __init__(self):
        self.sub = aioredis.from_url(REDIS_URL)
        self.pub = aioredis.from_url(REDIS_URL)
        log.info("loading detector %s ...", MODEL_PATH)
        self.detector = YoloDetector(MODEL_PATH, CONF_THRESHOLD, MODEL_CLASSES)
        self.limiter = DedupRateLimiter(DEDUP_WINDOW_MS, MAX_EVENTS_PER_MIN)
        self.workers: dict[str, CameraWorker] = {}

    async def publish(self, channel: str, payload: dict) -> None:
        from .streams import is_durable, stream_key
        from .config import STREAM_MAXLEN
        data = json.dumps(payload)
        if is_durable(channel):
            # durable: append to a Redis Stream (survives a backend restart),
            # trimmed approximately so it can't grow unbounded.
            await self.pub.xadd(stream_key(channel), {"data": data},
                                maxlen=STREAM_MAXLEN, approximate=True)
        else:
            await self.pub.publish(channel, data)

    async def publish_answer(self, req_id: str, sdp: str) -> None:
        await self.pub.publish(
            "webrtc:answers", json.dumps({"reqId": req_id, "sdp": sdp})
        )

    async def handle_command(self, cmd: dict) -> None:
        kind = cmd.get("type")
        if kind == "discover":
            asyncio.create_task(self.handle_discover(cmd))
            return
        cid = cmd.get("camera_id")
        if not cid:
            return
        if kind == "start":
            if cid in self.workers:
                return  # already running
            worker = CameraWorker(
                cid, cmd["rtsp_url"], self.detector, self.publish, self.limiter,
                cmd.get("rules", []),
            )
            self.workers[cid] = worker
            worker.start()
            log.info("started camera %s (%d rules)", cid, len(cmd.get("rules", [])))
        elif kind == "rules_update":
            worker = self.workers.get(cid)
            if worker:
                worker.set_rules(cmd.get("rules", []))
                log.info("updated rules for camera %s (%d)", cid, len(cmd.get("rules", [])))
        elif kind == "stop":
            worker = self.workers.pop(cid, None)
            if worker:
                await worker.stop()
                self.limiter.reset(cid)
                log.info("stopped camera %s", cid)

    async def handle_discover(self, cmd: dict) -> None:
        from .discovery import discover_onvif
        from .config import DISCOVERY_TIMEOUT_S
        scan_id = cmd.get("scan_id")
        user_id = cmd.get("user_id")
        try:
            cams = await asyncio.to_thread(
                discover_onvif, cmd.get("username", ""), cmd.get("password", ""), DISCOVERY_TIMEOUT_S
            )
            await self.publish("discovery:results", {"scan_id": scan_id, "user_id": user_id, "cameras": cams})
        except Exception as e:
            log.exception("discovery failed")
            await self.publish("discovery:results",
                               {"scan_id": scan_id, "user_id": user_id, "cameras": [], "error": str(e)[:200]})

    async def handle_webrtc(self, req: dict) -> None:
        cid = req.get("camera_id")
        worker = self.workers.get(cid)
        if not worker:
            await self.pub.publish(
                "webrtc:answers",
                json.dumps({"reqId": req.get("reqId"), "error": "camera not running"}),
            )
            return
        try:
            await handle_offer(worker, req["sdp"], self.publish_answer, req["reqId"])
        except Exception as e:
            log.exception("webrtc negotiation failed")
            await self.pub.publish(
                "webrtc:answers",
                json.dumps({"reqId": req.get("reqId"), "error": str(e)[:200]}),
            )

    async def run(self) -> None:
        ps = self.sub.pubsub()
        await ps.subscribe("camera:commands", "webrtc:requests")
        log.info("worker up; subscribed to camera:commands, webrtc:requests")
        async for msg in ps.listen():
            if msg.get("type") != "message":
                continue
            channel = msg["channel"]
            if isinstance(channel, bytes):
                channel = channel.decode()
            try:
                data = json.loads(msg["data"])
            except Exception:
                continue
            if channel == "camera:commands":
                await self.handle_command(data)
            elif channel == "webrtc:requests":
                # negotiate concurrently so one slow handshake doesn't block others
                asyncio.create_task(self.handle_webrtc(data))


def main() -> None:
    asyncio.run(WorkerApp().run())


if __name__ == "__main__":
    main()
