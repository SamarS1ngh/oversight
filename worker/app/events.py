import uuid
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def detection_event(
    camera_id: str,
    confidence: float,
    count: int,
    bboxes: list[dict],
    frame_w: int,
    frame_h: int,
    worker_id: str,
    ts: str | None = None,
) -> dict:
    """Detection event — matches §2 of docs/EVENT_FORMAT.md."""
    return {
        "id": str(uuid.uuid4()),
        "type": "person_detected",
        "camera_id": camera_id,
        "ts": ts or now_iso(),
        "confidence": round(float(confidence), 4),
        "count": int(count),
        "bboxes": bboxes,
        "frame_w": frame_w,
        "frame_h": frame_h,
        "worker_id": worker_id,
    }


def stats_event(
    camera_id: str,
    fps: float,
    detections_per_min: int,
    state: str,
    ts: str | None = None,
) -> dict:
    """Camera stats — matches §3 of docs/EVENT_FORMAT.md."""
    return {
        "type": "camera_stats",
        "camera_id": camera_id,
        "ts": ts or now_iso(),
        "fps": round(float(fps), 2),
        "detections_per_min": int(detections_per_min),
        "state": state,
    }


def state_event(
    camera_id: str,
    state: str,
    detail: str | None = None,
    ts: str | None = None,
) -> dict:
    """Camera state change — matches §4 of docs/EVENT_FORMAT.md."""
    e = {
        "type": "camera_state",
        "camera_id": camera_id,
        "ts": ts or now_iso(),
        "state": state,
    }
    if detail:
        e["detail"] = detail
    return e
