from dataclasses import dataclass


@dataclass
class _CamState:
    last_emit_ms: float = 0.0
    last_count: int = 0
    window_start_ms: float = 0.0
    window_emits: int = 0


class DedupRateLimiter:
    """Per-camera detection dedup + rate limit.

    Pure logic — the clock is injected via ``now_ms`` so it is fully unit
    testable. See docs/EVENT_FORMAT.md for the rules:

      * dedup: suppress a detection if the previous *emitted* one for the same
        camera was < ``dedup_window_ms`` ago AND the person count did not
        increase (stops a standing person from firing every frame).
      * rate-limit: at most ``max_per_min`` emitted detections per camera per
        rolling 60s window.
    """

    def __init__(self, dedup_window_ms: int, max_per_min: int):
        self.dedup_window_ms = dedup_window_ms
        self.max_per_min = max_per_min
        self._cams: dict[str, _CamState] = {}

    def should_emit(self, key: str, count: int, now_ms: float) -> bool:
        if count <= 0:
            return False

        st = self._cams.get(key)
        if st is None:
            st = _CamState()
            self._cams[key] = st

        # roll the rate-limit window
        if now_ms - st.window_start_ms >= 60_000:
            st.window_start_ms = now_ms
            st.window_emits = 0

        # dedup
        within_window = (now_ms - st.last_emit_ms) < self.dedup_window_ms
        if within_window and count <= st.last_count:
            return False

        # rate limit
        if st.window_emits >= self.max_per_min:
            return False

        st.last_emit_ms = now_ms
        st.last_count = count
        st.window_emits += 1
        return True

    def reset(self, camera_id: str) -> None:
        for k in [k for k in self._cams if k == camera_id or k.startswith(camera_id + ":")]:
            self._cams.pop(k, None)
