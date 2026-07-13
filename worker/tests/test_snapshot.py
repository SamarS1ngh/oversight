import unittest
from app.events import detection_event, snapshot_rel


class TestSnapshot(unittest.TestCase):
    def test_snapshot_rel_layout(self):
        self.assertEqual(snapshot_rel("cam1", "abc"), "snapshots/cam1/abc.jpg")

    def test_detection_event_carries_snapshot_path(self):
        e = detection_event("cam1", 0.9, 1, [], 640, 480, "w1", snapshot_path="snapshots/cam1/x.jpg")
        self.assertEqual(e["snapshot_path"], "snapshots/cam1/x.jpg")

    def test_detection_event_snapshot_path_defaults_none(self):
        e = detection_event("cam1", 0.9, 1, [], 640, 480, "w1")
        self.assertIsNone(e["snapshot_path"])


if __name__ == "__main__":
    unittest.main()
