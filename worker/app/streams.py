# Channels whose loss on a backend restart matters (persisted events).
DURABLE_CHANNELS = frozenset({"detections", "clips"})


def is_durable(channel: str) -> bool:
    return channel in DURABLE_CHANNELS


def stream_key(channel: str) -> str:
    return "stream:" + channel
