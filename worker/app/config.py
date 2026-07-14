import os


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:8080")
WORKER_ID = os.environ.get("WORKER_ID", "worker-1")

# dedup / rate-limit (see docs/EVENT_FORMAT.md)
DEDUP_WINDOW_MS = _int("DEDUP_WINDOW_MS", 3000)
MAX_EVENTS_PER_MIN = _int("MAX_EVENTS_PER_MIN", 30)

# detection
MODEL_PATH = os.environ.get("MODEL_PATH", "yolov8n.pt")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.4"))
DETECT_EVERY_N = _int("DETECT_EVERY_N", 3)  # run YOLO on every Nth decoded frame

# webrtc
STUN_URL = os.environ.get("STUN_URL", "stun:stun.l.google.com:19302")

# recording (M1)
PRE_ROLL_S = _int("PRE_ROLL_S", 10)
POST_ROLL_S = _int("POST_ROLL_S", 10)
MAX_CLIP_LEN_S = _int("MAX_CLIP_LEN_S", 120)
RECORDINGS_DIR = os.environ.get("RECORDINGS_DIR", "/recordings")
STORAGE_BACKEND = os.environ.get("STORAGE_BACKEND", "local")

# rules engine (M2a)
import os as _os
MODEL_CLASSES = [
    s.strip() for s in _os.environ.get(
        "MODEL_CLASSES",
        "person,bicycle,car,motorcycle,bus,truck,cat,dog,backpack,handbag,suitcase",
    ).split(",") if s.strip()
]
TZ = _os.environ.get("TZ", "UTC")

# reconnect / stall watchdog (M4a)
OFFLINE_GRACE_S = float(os.environ.get("OFFLINE_GRACE_S", "60"))
STALL_TIMEOUT_S = float(os.environ.get("STALL_TIMEOUT_S", "10"))
RECONNECT_BACKOFF_START_S = float(os.environ.get("RECONNECT_BACKOFF_START_S", "1"))
RECONNECT_BACKOFF_MAX_S = float(os.environ.get("RECONNECT_BACKOFF_MAX_S", "30"))
