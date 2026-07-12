from abc import ABC, abstractmethod
from dataclasses import dataclass

from .detector import Box, COCO_NAMES, _NAME_TO_ID


@dataclass
class Track:
    id: int
    x: float
    y: float
    w: float
    h: float
    conf: float
    label: str


class Tracker(ABC):
    @abstractmethod
    def update(self, boxes: list[Box], frame_w: int, frame_h: int) -> list[Track]:
        ...


class ByteTrackTracker(Tracker):
    """Standalone ByteTrack (supervision), one instance per camera. Feeds it plain
    detections (pixel xyxy + conf + class id), reads back tracker_id. Heavy import
    kept local so the pure tracking-rules tests don't need supervision/numpy."""

    def __init__(self, bytetrack=None):
        if bytetrack is None:
            import supervision as sv

            bytetrack = sv.ByteTrack()
        self._bt = bytetrack

    def update(self, boxes: list[Box], frame_w: int, frame_h: int) -> list[Track]:
        import numpy as np
        import supervision as sv

        if not boxes:
            # advance the tracker with an empty frame so it ages tracks correctly
            self._bt.update_with_detections(sv.Detections.empty())
            return []

        xyxy = np.array(
            [[b.x * frame_w, b.y * frame_h, (b.x + b.w) * frame_w, (b.y + b.h) * frame_h] for b in boxes],
            dtype=float,
        )
        conf = np.array([b.conf for b in boxes], dtype=float)
        cls = np.array([_NAME_TO_ID.get(b.label, -1) for b in boxes], dtype=int)
        det = sv.Detections(xyxy=xyxy, confidence=conf, class_id=cls)
        det = self._bt.update_with_detections(det)

        tracks: list[Track] = []
        for i in range(len(det)):
            tid = det.tracker_id[i]
            if tid is None:
                continue
            x1, y1, x2, y2 = det.xyxy[i]
            cid = int(det.class_id[i]) if det.class_id is not None else -1
            tracks.append(
                Track(
                    id=int(tid),
                    x=x1 / frame_w,
                    y=y1 / frame_h,
                    w=(x2 - x1) / frame_w,
                    h=(y2 - y1) / frame_h,
                    conf=round(float(det.confidence[i]), 4) if det.confidence is not None else 0.0,
                    label=COCO_NAMES.get(cid, str(cid)),
                )
            )
        return tracks
