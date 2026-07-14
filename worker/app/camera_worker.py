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
    OFFLINE_GRACE_S,
    STALL_TIMEOUT_S,
    RECONNECT_BACKOFF_START_S,
    RECONNECT_BACKOFF_MAX_S,
)
from .events import detection_event, now_iso, snapshot_rel, stats_event, state_event
from .reconnect import ReconnectState
from .recorder import Recorder
from .rules import evaluate as evaluate_rules
from .tracking_rules import evaluate_tracking, bottom_center
from .tracker import ByteTrackTracker

log = logging.getLogger("camera")


def _now_ms() -> float:
    return time.monotonic() * 1000.0


def _default_snapshot_writer(full_path, bgr):
    import cv2, os
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    h, w = bgr.shape[:2]
    if w > 640:
        bgr = cv2.resize(bgr, (640, int(h * 640 / w)))  # keep the push payload small
    cv2.imwrite(full_path, bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])


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
        self._reconnect_count = 0
        self._last_frame_iso: str | None = None

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
        self.tracker = ByteTrackTracker()
        self._dwell_state: dict = {}
        self._last_center: dict = {}
        self._snapshot_writer = _default_snapshot_writer

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
        self._dwell_state = {}
        self._last_center = {}

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
                        self.camera_id, self._fps, len(self._det_times), self.state,
                        reconnect_count=getattr(self, "_reconnect_count", 0),
                        last_frame_at=getattr(self, "_last_frame_iso", None),
                    ),
                )
        except asyncio.CancelledError:
            pass

    # ---------- blocking decode/detect thread ----------
    def _decode_loop(self) -> None:
        import av

        rc = ReconnectState(OFFLINE_GRACE_S, STALL_TIMEOUT_S,
                            RECONNECT_BACKOFF_START_S, RECONNECT_BACKOFF_MAX_S)
        self._push_state("connecting")
        while not self._stop.is_set():
            container = None
            try:
                container = av.open(
                    self.rtsp_url,
                    options={"rtsp_transport": "tcp", "stimeout": "5000000"},
                )
                stream = container.streams.video[0]
            except Exception as e:
                log.warning("rtsp open failed: %s (%s)", self.camera_id, str(e)[:120])
                if rc.on_drop(time.monotonic()):
                    self._push_state(rc.state)
                self._backoff_wait(rc)
                continue
            if rc.on_connect_ok(time.monotonic()):
                self._push_state("live")
            self._reconnect_count = rc.reconnect_count
            self.recorder.set_stream(stream)
            try:
                self._demux(container, stream, rc)  # runs until stop, drop, or stall
            except Exception as e:
                log.warning("decode loop dropped: %s (%s)", self.camera_id, str(e)[:120])
            finally:
                try:
                    self.recorder.close()
                except Exception:
                    pass
                try:
                    container.close()
                except Exception:
                    pass
            if not self._stop.is_set():
                if rc.on_drop(time.monotonic()):
                    self._push_state(rc.state)
                self._backoff_wait(rc)

    def _backoff_wait(self, rc: ReconnectState) -> None:
        # Sleep the current backoff in small slices so stop() stays responsive,
        # escalating reconnecting -> offline once the grace period passes.
        deadline = time.monotonic() + rc.current_backoff
        while not self._stop.is_set() and time.monotonic() < deadline:
            if rc.tick(time.monotonic()):
                self._push_state(rc.state)  # -> offline
            self._reconnect_count = rc.reconnect_count
            time.sleep(0.2)
        if rc.tick(time.monotonic()):
            self._push_state(rc.state)

    def _demux(self, container, stream, rc: ReconnectState) -> None:
        frame_count = 0
        frames_since = 0
        last_fps_t = _now_ms()
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
                tracks = []
                if frame_count % DETECT_EVERY_N == 0:
                    boxes = self.detector.detect_objects(img)
                    if boxes:
                        tracks = self.tracker.update(boxes, img.shape[1], img.shape[0])

                annotated = self._annotate(img, boxes)
                if boxes:
                    self._emit_matches(img, boxes, tracks, now, annotated)

                self.latest_frame = VideoFrame.from_ndarray(annotated, format="bgr24")

                rc.on_frame(time.monotonic())
                self._last_frame_iso = now_iso()
                if rc.is_stalled(time.monotonic()):
                    raise RuntimeError("stall")

            # buffer/record the compressed packet AFTER decoding it, so any
            # timestamp rebasing during muxing can't disturb the decoder.
            self.recorder.on_packet(packet)

    def _emit_one(self, m, w, h, frame) -> str:
        payload = detection_event(
            self.camera_id, m.confidence, m.count,
            [
                {"x": round(b.x, 4), "y": round(b.y, 4), "w": round(b.w, 4),
                 "h": round(b.h, 4), "conf": b.conf, "label": b.label}
                for b in m.boxes
            ],
            w, h, WORKER_ID,
            label=m.label, rule_id=m.rule_id, severity=m.severity,
        )
        import os
        rel = snapshot_rel(self.camera_id, payload["id"])
        try:
            self._snapshot_writer(os.path.join(RECORDINGS_DIR, rel), frame)
            payload["snapshot_path"] = rel
        except Exception:
            log.exception("snapshot write failed: %s", self.camera_id)
        self._evq.put(("detections", payload))
        return payload["id"]

    def _emit_matches(self, img, boxes, tracks, now_ms: float, annotated) -> None:
        now_hhmm = self._now_hhmm()
        presence_rules = [r for r in self.rules if r.get("type", "presence") == "presence"]
        tracking_rules = [r for r in self.rules if r.get("type", "presence") in ("tripwire", "dwell")]

        # implicit "any person, low" default only when the camera has NO rules at all
        if not self.rules:
            presence_matches = evaluate_rules(boxes, [], now_hhmm, CONF_THRESHOLD)
        elif presence_rules:
            presence_matches = evaluate_rules(boxes, presence_rules, now_hhmm, CONF_THRESHOLD)
        else:
            presence_matches = []

        tracking_matches = (
            evaluate_tracking(tracks, tracking_rules, self._dwell_state, self._last_center,
                              now_ms / 1000.0, now_hhmm, CONF_THRESHOLD)
            if tracking_rules else []
        )
        # remember this frame's centers for the next frame's crossing test
        if tracks:
            self._last_center = {t.id: bottom_center(t) for t in tracks}

        if not presence_matches and not tracking_matches:
            return
        self._det_times.append(now_ms)
        h, w = img.shape[:2]
        first_emitted_id = None

        # presence: keep the M2a per-(camera,rule) count dedup
        for m in presence_matches:
            key = f"{self.camera_id}:{m.rule_id or ''}"
            if not self.limiter.should_emit(key, m.count, now_ms):
                continue
            eid = self._emit_one(m, w, h, annotated)
            first_emitted_id = first_emitted_id or eid

        # tracking: bypass the count dedup (episodic, self-limiting)
        for m in tracking_matches:
            eid = self._emit_one(m, w, h, annotated)
            first_emitted_id = first_emitted_id or eid

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
