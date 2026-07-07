import asyncio
import logging
import queue
import threading
import time

import numpy as np
from aiortc import VideoStreamTrack
from av import VideoFrame

from .config import (
    DETECT_EVERY_N,
    WORKER_ID,
    PRE_ROLL_S,
    POST_ROLL_S,
    MAX_CLIP_LEN_S,
    RECORDINGS_DIR,
    STORAGE_BACKEND,
    CONF_THRESHOLD,
    TZ,
)
from .events import detection_event, stats_event, state_event
from .recorder import Recorder
from .rules import evaluate as evaluate_rules

log = logging.getLogger("camera")


def _now_ms() -> float:
    return time.monotonic() * 1000.0


class DetectionVideoTrack(VideoStreamTrack):
    """WebRTC track that serves the worker's latest annotated frame. Decoupled
    from decode rate — it paces itself via next_timestamp()."""

    def __init__(self, worker: "CameraWorker"):
        super().__init__()
        self._worker = worker

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()
        frame = self._worker.latest_frame
        if frame is None:
            frame = VideoFrame.from_ndarray(
                np.zeros((480, 640, 3), dtype=np.uint8), format="bgr24"
            )
        frame.pts = pts
        frame.time_base = time_base
        return frame


class CameraWorker:
    """Owns one camera end-to-end and is fully independent of every other
    camera. The blocking RTSP decode + YOLO inference runs in a worker thread;
    detections/stats flow back to the asyncio loop through a thread-safe queue.
    An exception in here is caught and surfaced as an 'error' state — it never
    takes down sibling cameras."""

    def __init__(self, camera_id, rtsp_url, detector, publish, limiter, rules=None):
        self.camera_id = camera_id
        self.rtsp_url = rtsp_url
        self.detector = detector
        self._publish = publish  # async callable(channel: str, payload: dict)
        self.limiter = limiter
        self.rules = rules or []

        self.latest_frame: VideoFrame | None = None
        self.state = "connecting"

        self._stop = threading.Event()
        self._evq: "queue.Queue" = queue.Queue()
        self._pcs: set = set()
        self._tasks: list[asyncio.Task] = []

        self._fps = 0.0
        self._det_times: list[float] = []

        self.recorder = Recorder(
            camera_id=str(camera_id),
            recordings_dir=RECORDINGS_DIR,
            pre_roll_ms=PRE_ROLL_S * 1000,
            post_roll_ms=POST_ROLL_S * 1000,
            max_clip_len_ms=MAX_CLIP_LEN_S * 1000,
            emit=lambda ch, p: self._evq.put((ch, p)),
            worker_id=WORKER_ID,
            backend=STORAGE_BACKEND,
        )

    # ---------- lifecycle ----------
    def start(self) -> None:
        self._drain_task = asyncio.create_task(self._drain())
        self._stats_task = asyncio.create_task(self._stats_loop())
        self._decode_task = asyncio.create_task(asyncio.to_thread(self._decode_loop))
        self._tasks = [self._drain_task, self._stats_task, self._decode_task]

    async def stop(self) -> None:
        self._stop.set()
        # Let the decode thread exit first: its `finally` calls recorder.close(),
        # which finalizes any in-progress clip and enqueues the final clip_ready.
        # We must drain that event BEFORE tearing the drain down, or the last
        # clip is lost from the DB and its file is orphaned on disk (retention
        # only tracks DB rows). Bounded so a stalled RTSP read can't hang stop.
        decode_task = getattr(self, "_decode_task", None)
        if decode_task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(decode_task), timeout=3.0)
            except Exception:
                pass
        # Signal the drain to finish, then wait for it to publish what's queued
        # (including the final clip_ready enqueued above) before we cancel tasks.
        self._evq.put(None)
        drain_task = getattr(self, "_drain_task", None)
        if drain_task is not None:
            try:
                await asyncio.wait_for(asyncio.shield(drain_task), timeout=3.0)
            except Exception:
                pass
        for pc in list(self._pcs):
            try:
                await pc.close()
            except Exception:
                pass
        self._pcs.clear()
        for t in self._tasks:
            t.cancel()
        self.state = "stopped"
        await self._emit("stats", state_event(self.camera_id, "stopped"))

    # ---------- webrtc ----------
    def new_track(self) -> DetectionVideoTrack:
        return DetectionVideoTrack(self)

    def register_pc(self, pc) -> None:
        self._pcs.add(pc)

    def set_rules(self, rules) -> None:
        self.rules = rules or []

    def _now_hhmm(self) -> str:
        from datetime import datetime
        from zoneinfo import ZoneInfo
        try:
            tz = ZoneInfo(TZ)
        except Exception:
            tz = ZoneInfo("UTC")
        return datetime.now(tz).strftime("%H:%M")

    # ---------- async side ----------
    async def _emit(self, channel: str, payload: dict) -> None:
        try:
            await self._publish(channel, payload)
        except Exception:
            log.exception("publish failed")

    async def _drain(self) -> None:
        # events produced by the decode thread -> redis
        while True:
            item = await asyncio.to_thread(self._evq.get)
            if item is None:
                break
            channel, payload = item
            await self._emit(channel, payload)

    async def _stats_loop(self) -> None:
        try:
            while not self._stop.is_set():
                await asyncio.sleep(1.0)
                now = _now_ms()
                self._det_times = [t for t in self._det_times if t >= now - 60_000]
                await self._emit(
                    "stats",
                    stats_event(
                        self.camera_id, self._fps, len(self._det_times), self.state
                    ),
                )
        except asyncio.CancelledError:
            pass

    # ---------- blocking decode/detect thread ----------
    def _decode_loop(self) -> None:
        import av

        self._push_state("connecting")
        try:
            container = av.open(
                self.rtsp_url,
                options={"rtsp_transport": "tcp", "stimeout": "5000000"},
            )
            stream = container.streams.video[0]
        except Exception as e:
            log.exception("rtsp open failed: %s", self.camera_id)
            self._push_state("error", f"rtsp connect failed: {str(e)[:160]}")
            return

        self._push_state("live")
        self.recorder.set_stream(stream)
        frame_count = 0
        frames_since = 0
        last_fps_t = _now_ms()
        try:
            for packet in container.demux(stream):
                if self._stop.is_set():
                    break
                for frame in packet.decode():
                    if self._stop.is_set():
                        break
                    img = frame.to_ndarray(format="bgr24")
                    frame_count += 1
                    frames_since += 1

                    now = _now_ms()
                    if now - last_fps_t >= 1000:
                        self._fps = frames_since * 1000.0 / (now - last_fps_t)
                        frames_since = 0
                        last_fps_t = now

                    boxes = []
                    if frame_count % DETECT_EVERY_N == 0:
                        boxes = self.detector.detect_objects(img)

                    annotated = self._annotate(img, boxes)
                    if boxes:
                        self._emit_matches(img, boxes, now, annotated)

                    self.latest_frame = VideoFrame.from_ndarray(annotated, format="bgr24")

                # buffer/record the compressed packet AFTER decoding it, so any
                # timestamp rebasing during muxing can't disturb the decoder.
                self.recorder.on_packet(packet)
        except Exception as e:
            log.exception("decode loop failed: %s", self.camera_id)
            self._push_state("error", str(e)[:200])
        finally:
            try:
                self.recorder.close()
            except Exception:
                pass
            try:
                container.close()
            except Exception:
                pass

    def _emit_matches(self, img, boxes, now_ms: float, annotated) -> None:
        matches = evaluate_rules(boxes, self.rules, self._now_hhmm(), CONF_THRESHOLD)
        if not matches:
            return
        self._det_times.append(now_ms)
        h, w = img.shape[:2]
        first_emitted_id = None
        for m in matches:
            key = f"{self.camera_id}:{m.rule_id or ''}"
            if not self.limiter.should_emit(key, m.count, now_ms):
                continue
            payload = detection_event(
                self.camera_id,
                m.confidence,
                m.count,
                [
                    {"x": round(b.x, 4), "y": round(b.y, 4), "w": round(b.w, 4),
                     "h": round(b.h, 4), "conf": b.conf, "label": b.label}
                    for b in m.boxes
                ],
                w, h, WORKER_ID,
                label=m.label, rule_id=m.rule_id, severity=m.severity,
            )
            self._evq.put(("detections", payload))
            if first_emitted_id is None:
                first_emitted_id = payload["id"]
        # one clip per frame-worth-of-matches, linked to the first emitted alert
        if first_emitted_id is not None:
            self.recorder.trigger(annotated, first_emitted_id)

    def _push_state(self, state: str, detail: str | None = None) -> None:
        self.state = state
        self._evq.put(("stats", state_event(self.camera_id, state, detail)))

    def _annotate(self, img, boxes):
        import cv2

        h, w = img.shape[:2]
        for b in boxes:
            x1, y1 = int(b.x * w), int(b.y * h)
            x2, y2 = int((b.x + b.w) * w), int((b.y + b.h) * h)
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(
                img,
                f"{b.label} {b.conf:.2f}",
                (x1, max(0, y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 0),
                1,
            )
        return img
