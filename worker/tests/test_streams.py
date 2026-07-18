import unittest
from app.streams import is_durable, stream_key


class TestStreams(unittest.TestCase):
    def test_durable_channels(self):
        self.assertTrue(is_durable("detections"))
        self.assertTrue(is_durable("clips"))

    def test_non_durable_channels(self):
        for ch in ("stats", "discovery:results", "webrtc:answers", "webrtc:requests"):
            self.assertFalse(is_durable(ch))

    def test_stream_key(self):
        self.assertEqual(stream_key("detections"), "stream:detections")
        self.assertEqual(stream_key("clips"), "stream:clips")


if __name__ == "__main__":
    unittest.main()
