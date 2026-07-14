import unittest
from app.reconnect import backoff_next, ReconnectState


class TestBackoff(unittest.TestCase):
    def test_grows_and_caps_and_resets(self):
        self.assertEqual(backoff_next(0, 1, 30), 1)     # from zero -> floor
        self.assertEqual(backoff_next(1, 1, 30), 2)
        self.assertEqual(backoff_next(2, 1, 30), 4)
        self.assertEqual(backoff_next(16, 1, 30), 30)   # 32 capped to 30
        self.assertEqual(backoff_next(30, 1, 30), 30)   # stays capped


def rs():
    return ReconnectState(grace_s=60, stall_s=10, backoff_start_s=1, backoff_max_s=30)


class TestReconnectState(unittest.TestCase):
    def test_connect_ok_goes_live_and_resets_backoff(self):
        s = rs()
        self.assertTrue(s.on_connect_ok(0.0))
        self.assertEqual(s.state, "live")
        self.assertEqual(s.current_backoff, 0)

    def test_drop_enters_reconnecting_counts_once_grows_backoff(self):
        s = rs(); s.on_connect_ok(0.0)
        self.assertTrue(s.on_drop(1.0))            # live -> reconnecting (changed)
        self.assertEqual(s.state, "reconnecting")
        self.assertEqual(s.reconnect_count, 1)
        self.assertEqual(s.current_backoff, 1)
        self.assertFalse(s.on_drop(2.0))           # still reconnecting (no state change)
        self.assertEqual(s.current_backoff, 2)     # backoff still grows per retry
        self.assertEqual(s.reconnect_count, 1)     # not re-counted within one episode

    def test_tick_escalates_to_offline_after_grace(self):
        s = rs(); s.on_connect_ok(0.0); s.on_drop(1.0)
        self.assertFalse(s.tick(30.0))             # within grace
        self.assertEqual(s.state, "reconnecting")
        self.assertTrue(s.tick(62.0))              # > 60s since reconnecting_since(=1.0)
        self.assertEqual(s.state, "offline")

    def test_reconnect_from_offline_goes_live_and_resets(self):
        s = rs(); s.on_connect_ok(0.0); s.on_drop(1.0); s.tick(62.0)
        self.assertEqual(s.state, "offline")
        self.assertTrue(s.on_connect_ok(70.0))
        self.assertEqual(s.state, "live")
        self.assertEqual(s.current_backoff, 0)
        # a fresh drop after recovery counts a new episode
        s.on_drop(71.0)
        self.assertEqual(s.reconnect_count, 2)

    def test_is_stalled_when_live_and_no_recent_frame(self):
        s = rs(); s.on_connect_ok(0.0); s.on_frame(0.0)
        self.assertFalse(s.is_stalled(5.0))
        self.assertTrue(s.is_stalled(11.0))        # > stall_s(10)
        s.on_drop(11.0)
        self.assertFalse(s.is_stalled(30.0))       # not live -> never "stalled"


if __name__ == "__main__":
    unittest.main()
