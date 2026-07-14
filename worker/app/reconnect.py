def backoff_next(current_s: float, start_s: float, max_s: float) -> float:
    """Exponential backoff: floor on the first retry, then double, capped."""
    if current_s <= 0:
        return start_s
    return min(current_s * 2, max_s)


class ReconnectState:
    """Pure per-camera connection state machine. The worker calls the event
    methods around real PyAV open/decode; the transitions here are host-tested.
    Each event method returns True iff `state` changed (so the caller emits a
    camera_state event only on change)."""

    def __init__(self, grace_s: float, stall_s: float, backoff_start_s: float, backoff_max_s: float):
        self.grace_s = grace_s
        self.stall_s = stall_s
        self._backoff_start = backoff_start_s
        self._backoff_max = backoff_max_s
        self.state = "connecting"
        self.current_backoff = 0.0
        self.reconnect_count = 0
        self.last_frame_at = None
        self._reconnecting_since = None

    def on_connect_ok(self, now: float) -> bool:
        changed = self.state != "live"
        self.state = "live"
        self.current_backoff = 0.0
        self._reconnecting_since = None
        self.last_frame_at = now
        return changed

    def on_frame(self, now: float) -> None:
        self.last_frame_at = now

    def on_drop(self, now: float) -> bool:
        # A fresh episode: coming from live/connecting (not already down).
        fresh = self.state not in ("reconnecting", "offline")
        if fresh:
            self.reconnect_count += 1
            self._reconnecting_since = now
        elif self._reconnecting_since is None:
            self._reconnecting_since = now
        changed = self.state == "live" or self.state == "connecting"
        if self.state != "offline":
            self.state = "reconnecting"
        self.current_backoff = backoff_next(self.current_backoff, self._backoff_start, self._backoff_max)
        return changed

    def tick(self, now: float) -> bool:
        """Escalate a sustained reconnecting state to offline after the grace."""
        if self.state == "reconnecting" and self._reconnecting_since is not None \
                and now - self._reconnecting_since > self.grace_s:
            self.state = "offline"
            return True
        return False

    def is_stalled(self, now: float) -> bool:
        return self.state == "live" and self.last_frame_at is not None \
            and now - self.last_frame_at > self.stall_s
