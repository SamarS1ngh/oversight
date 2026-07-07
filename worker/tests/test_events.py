import unittest

from app.events import detection_event, stats_event, state_event


class TestEvents(unittest.TestCase):
    def test_detection_event_shape(self):
        e = detection_event(
            "cam1",
            0.912345,
            2,
            [{"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "conf": 0.9}],
            1280,
            720,
            "worker-1",
            ts="2026-01-01T00:00:00Z",
        )
        self.assertEqual(e["type"], "detection")
        self.assertEqual(e["camera_id"], "cam1")
        self.assertEqual(e["count"], 2)
        self.assertEqual(e["confidence"], 0.9123)  # rounded to 4dp
        self.assertEqual(e["frame_w"], 1280)
        self.assertEqual(e["frame_h"], 720)
        self.assertEqual(e["worker_id"], "worker-1")
        self.assertEqual(e["ts"], "2026-01-01T00:00:00Z")
        self.assertIn("id", e)
        self.assertEqual(len(e["bboxes"]), 1)

    def test_detection_event_id_is_unique(self):
        a = detection_event("c", 0.5, 1, [], 1, 1, "w")
        b = detection_event("c", 0.5, 1, [], 1, 1, "w")
        self.assertNotEqual(a["id"], b["id"])

    def test_stats_event_shape(self):
        e = stats_event("cam1", 24.567, 12, "live")
        self.assertEqual(e["type"], "camera_stats")
        self.assertEqual(e["fps"], 24.57)
        self.assertEqual(e["detections_per_min"], 12)
        self.assertEqual(e["state"], "live")

    def test_state_event_with_detail(self):
        e = state_event("cam1", "error", detail="rtsp connect failed")
        self.assertEqual(e["type"], "camera_state")
        self.assertEqual(e["state"], "error")
        self.assertEqual(e["detail"], "rtsp connect failed")

    def test_state_event_without_detail_omits_key(self):
        e = state_event("cam1", "live")
        self.assertNotIn("detail", e)

    def test_detection_event_carries_label_rule_severity(self):
        e = detection_event("cam", 0.9, 1, [{"x": 0, "y": 0, "w": 0.1, "h": 0.1, "conf": 0.9, "label": "car"}], 1280, 720, "w1", label="car", rule_id="r1", severity="high")
        self.assertEqual(e["type"], "detection")
        self.assertEqual(e["label"], "car")
        self.assertEqual(e["rule_id"], "r1")
        self.assertEqual(e["severity"], "high")


if __name__ == "__main__":
    unittest.main()
