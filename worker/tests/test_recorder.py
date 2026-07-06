import unittest

from app.recorder import Recorder


class FakePacket:
    def __init__(self, dts, is_keyframe):
        self.dts = dts
        self.pts = dts
        self.is_keyframe = is_keyframe


class FakeMuxer:
    def __init__(self, path, stream):
        self.path = path
        self.stream = stream
        self.muxed = []
        self.closed = False

    def mux(self, packet):
        self.muxed.append(packet)

    def close(self):
        self.closed = True

    def size(self):
        return 100 * len(self.muxed)


def make_recorder():
    emitted = []
    muxers = []

    def factory(path, stream):
        m = FakeMuxer(path, stream)
        muxers.append(m)
        return m

    ids = iter([f"clip{i}" for i in range(100)])
    r = Recorder(
        camera_id="cam1",
        recordings_dir="/rec",
        pre_roll_ms=10_000,
        post_roll_ms=10_000,
        max_clip_len_ms=120_000,
        emit=lambda ch, p: emitted.append((ch, p)),
        worker_id="worker-1",
        margin_ms=2000,
        muxer_factory=factory,
        thumb_writer=lambda path, bgr: None,
        id_factory=lambda: next(ids),
        now_iso=lambda: "2026-07-06T00:00:00Z",
    )
    r.set_stream(object())
    return r, emitted, muxers


class TestRecorder(unittest.TestCase):
    def test_trigger_writes_preroll_from_keyframe(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.on_packet(FakePacket(1, False), t_ms=1000)
        r.on_packet(FakePacket(2, False), t_ms=2000)
        r.trigger(thumb_bgr=None, alert_id="a1", t_ms=3000)
        self.assertEqual(len(muxers), 1)
        # all three buffered packets are the pre-roll (start at the only keyframe)
        self.assertEqual(len(muxers[0].muxed), 3)

    def test_second_trigger_extends_not_new_clip(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)  # start, stop_at = 11000
        r.trigger(None, "a2", t_ms=5000)  # extend, stop_at = 15000
        self.assertEqual(len(muxers), 1)
        self.assertIsNotNone(r._active)
        self.assertEqual(r._active.stop_at, 15000)

    def test_finalize_after_post_roll_emits_clip_ready(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)  # stop_at = 11000
        r.on_packet(FakePacket(1, False), t_ms=12000)  # past stop -> finalize
        self.assertEqual(len(emitted), 1)
        ch, p = emitted[0]
        self.assertEqual(ch, "clips")
        self.assertEqual(p["type"], "clip_ready")
        self.assertEqual(p["id"], "clip0")
        self.assertEqual(p["alert_id"], "a1")
        self.assertEqual(p["camera_id"], "cam1")
        self.assertEqual(p["path"], "cam1/clip0.mp4")
        self.assertEqual(p["thumb_path"], "cam1/clip0.jpg")
        self.assertTrue(muxers[0].closed)

    def test_max_clip_len_forces_finalize(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=0)
        # a packet arriving past the max clip length finalizes regardless of stop_at
        r.on_packet(FakePacket(1, False), t_ms=121_000)
        self.assertEqual(len(emitted), 1)

    def test_close_finalizes_in_progress_clip(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(0, True), t_ms=0)
        r.trigger(None, "a1", t_ms=1000)
        r.close()
        self.assertEqual(len(emitted), 1)

    def test_packet_without_dts_is_ignored(self):
        r, emitted, muxers = make_recorder()
        r.on_packet(FakePacket(None, False), t_ms=0)  # flush packet
        self.assertEqual(len(r._buf), 0)
