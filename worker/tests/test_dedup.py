import unittest

from app.dedup import DedupRateLimiter


class TestDedupRateLimiter(unittest.TestCase):
    def test_first_detection_emits(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("c", 1, 1000))

    def test_zero_count_never_emits(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertFalse(lim.should_emit("c", 0, 1000))

    def test_suppress_same_count_within_window(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("c", 1, 1000))
        self.assertFalse(lim.should_emit("c", 1, 1500))

    def test_emit_on_count_increase_within_window(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("c", 1, 1000))
        # more people in frame -> alert even within the dedup window
        self.assertTrue(lim.should_emit("c", 2, 1500))

    def test_emit_again_after_window(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("c", 1, 1000))
        self.assertFalse(lim.should_emit("c", 1, 2000))
        self.assertTrue(lim.should_emit("c", 1, 4001))

    def test_rate_limit_caps_per_minute(self):
        # window 0 -> dedup never suppresses, so we isolate the rate limiter
        lim = DedupRateLimiter(0, 3)
        emits = sum(1 for t in range(10, 110, 10) if lim.should_emit("c", 1, t))
        self.assertEqual(emits, 3)

    def test_rate_limit_window_rolls(self):
        lim = DedupRateLimiter(0, 2)
        self.assertTrue(lim.should_emit("c", 1, 1000))
        self.assertTrue(lim.should_emit("c", 1, 2000))
        self.assertFalse(lim.should_emit("c", 1, 3000))  # capped
        # 60s after the window started, it resets
        self.assertTrue(lim.should_emit("c", 1, 61_001))

    def test_cameras_are_independent(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("a", 1, 1000))
        self.assertTrue(lim.should_emit("b", 1, 1000))
        self.assertFalse(lim.should_emit("a", 1, 1100))
        self.assertFalse(lim.should_emit("b", 1, 1100))

    def test_reset_clears_state(self):
        lim = DedupRateLimiter(3000, 30)
        self.assertTrue(lim.should_emit("c", 1, 1000))
        lim.reset("c")
        self.assertTrue(lim.should_emit("c", 1, 1100))


if __name__ == "__main__":
    unittest.main()
