import os
import uuid
from collections import deque
from datetime import datetime, timezone


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _monotonic_ms() -> float:
    import time

    return time.monotonic() * 1000.0


def _default_muxer_factory(full_path, stream):
    # heavy import kept local so unit tests can import Recorder without PyAV
    from .recorder_io import Mp4Muxer

    return Mp4Muxer(full_path, stream)


def _default_thumb_writer(full_path, bgr):
    import cv2  # local import — not needed by the pure logic tests

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    cv2.imwrite(full_path, bgr)


class _ActiveClip:
    def __init__(self, clip_id, rel_path, thumb_rel, muxer, start_t, stop_at, alert_id, start_iso):
        self.clip_id = clip_id
        self.rel_path = rel_path
        self.thumb_rel = thumb_rel
        self.muxer = muxer
        self.start_t = start_t
        self.stop_at = stop_at
        self.alert_id = alert_id
        self.start_iso = start_iso
        self.last_t = start_t

    def mux(self, packet, t):
        self.muxer.mux(packet)
        self.last_t = t

    def duration_ms(self, t):
        return t - self.start_t


class Recorder:
    """Event-clip recording for ONE camera. Pure of PyAV/cv2 — the muxer,
    thumbnail writer, id source, clock and now_iso are injected so the
    trigger/extend/finalize/keyframe logic is fully unit-testable with fakes.

    A packet is any object with ``.dts`` (int|None), ``.pts`` and
    ``.is_keyframe`` (bool). A clip must start on a keyframe.
    """

    def __init__(
        self,
        camera_id,
        recordings_dir,
        pre_roll_ms,
        post_roll_ms,
        max_clip_len_ms,
        emit,
        worker_id,
        backend="local",
        margin_ms=2000,
        muxer_factory=None,
        thumb_writer=None,
        id_factory=lambda: str(uuid.uuid4()),
        now_iso=_now_iso,
        clock=_monotonic_ms,
    ):
        self.camera_id = camera_id
        self.recordings_dir = recordings_dir
        self.pre_roll_ms = pre_roll_ms
        self.post_roll_ms = post_roll_ms
        self.max_clip_len_ms = max_clip_len_ms
        self.margin_ms = margin_ms
        self.backend = backend
        self.worker_id = worker_id
        self._emit = emit
        self._muxer_factory = muxer_factory or _default_muxer_factory
        self._thumb_writer = thumb_writer or _default_thumb_writer
        self._id = id_factory
        self._now_iso = now_iso
        self._clock = clock
        self._stream = None
        self._buf = deque()  # (packet, t_ms)
        self._active = None

    def set_stream(self, stream):
        self._stream = stream

    def on_packet(self, packet, t_ms=None):
        if packet.dts is None:
            return
        t = self._clock() if t_ms is None else t_ms
        self._buf.append((packet, t))
        self._trim(t)
        if self._active is not None:
            self._active.mux(packet, t)
            if t >= self._active.stop_at or self._active.duration_ms(t) >= self.max_clip_len_ms:
                self._finalize(t)

    def trigger(self, thumb_bgr, alert_id, t_ms=None):
        t = self._clock() if t_ms is None else t_ms
        if self._active is not None:
            # extend the post-roll, capped by the max clip length
            self._active.stop_at = min(
                t + self.post_roll_ms, self._active.start_t + self.max_clip_len_ms
            )
            return
        clip_id = self._id()
        rel = os.path.join(self.camera_id, f"{clip_id}.mp4")
        thumb_rel = os.path.join(self.camera_id, f"{clip_id}.jpg")
        muxer = self._muxer_factory(os.path.join(self.recordings_dir, rel), self._stream)
        active = _ActiveClip(
            clip_id, rel, thumb_rel, muxer, t, t + self.post_roll_ms, alert_id, self._now_iso()
        )
        for pkt, pt in self._preroll_packets(t):
            active.mux(pkt, pt)
        self._active = active
        self._thumb_writer(os.path.join(self.recordings_dir, thumb_rel), thumb_bgr)

    def close(self):
        """Camera stopping: finalize any in-progress clip."""
        if self._active is not None:
            self._finalize(self._active.last_t)

    # ---- internals ----
    def _trim(self, t):
        cutoff = t - self.pre_roll_ms - self.margin_ms
        while len(self._buf) > 1 and self._buf[0][1] < cutoff:
            self._buf.popleft()

    def _preroll_packets(self, t):
        target = t - self.pre_roll_ms
        items = list(self._buf)
        kf = None
        for i, (p, pt) in enumerate(items):
            if p.is_keyframe and pt <= target:
                kf = i  # newest keyframe at/before the pre-roll start
        if kf is None:
            for i, (p, pt) in enumerate(items):
                if p.is_keyframe:
                    kf = i  # fall back to the earliest keyframe we have
                    break
        if kf is None:
            return []
        return items[kf:]

    def _finalize(self, t):
        a = self._active
        self._active = None
        a.muxer.close()
        payload = {
            "type": "clip_ready",
            "id": str(a.clip_id),
            "alert_id": a.alert_id,
            "camera_id": self.camera_id,
            "start_ts": a.start_iso,
            "end_ts": self._now_iso(),
            "duration_ms": int(a.duration_ms(t)),
            "size_bytes": int(a.muxer.size()),
            "path": a.rel_path,
            "thumb_path": a.thumb_rel,
            "backend": self.backend,
            "worker_id": self.worker_id,
        }
        self._emit("clips", payload)
