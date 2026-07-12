import unittest

from app.tracking_rules import segment_crosses, evaluate_tracking, DwellState


class T:
    def __init__(self, id, x, y, w, h, conf=0.9, label="person"):
        self.id, self.x, self.y, self.w, self.h, self.conf, self.label = id, x, y, w, h, conf, label


# vertical line down the middle, A=top B=bottom
VLINE = [{"x": 0.5, "y": 0.2}, {"x": 0.5, "y": 0.8}]


class TestCrossing(unittest.TestCase):
    def test_crosses_both(self):
        self.assertTrue(segment_crosses((0.4, 0.5), (0.6, 0.5), VLINE, "both"))

    def test_no_cross_same_side(self):
        self.assertFalse(segment_crosses((0.3, 0.5), (0.45, 0.5), VLINE, "both"))

    def test_no_cross_when_missing_the_segment_extent(self):
        # crosses the infinite line's x but well below the segment (y=0.95 > 0.8)
        self.assertFalse(segment_crosses((0.4, 0.95), (0.6, 0.95), VLINE, "both"))

    def test_direction_in_vs_out(self):
        left_to_right = ((0.4, 0.5), (0.6, 0.5))
        right_to_left = ((0.6, 0.5), (0.4, 0.5))
        # exactly one of in/out fires for a given crossing direction, and they swap
        self.assertNotEqual(
            segment_crosses(*left_to_right, VLINE, "in"),
            segment_crosses(*left_to_right, VLINE, "out"),
        )
        self.assertEqual(
            segment_crosses(*left_to_right, VLINE, "in"),
            segment_crosses(*right_to_left, VLINE, "out"),
        )


def rule(**kw):
    base = {"id": "r", "type": "tripwire", "classes": ["person"], "zone": VLINE,
            "direction": "both", "dwell_seconds": None, "schedule": [None, None],
            "min_confidence": 0.4, "severity": "high", "enabled": True}
    base.update(kw)
    return base


class TestEvaluateTracking(unittest.TestCase):
    def test_tripwire_fires_on_crossing(self):
        state, last = {}, {1: (0.4, 0.6)}  # prev center left of line
        tracks = [T(1, 0.55, 0.5, 0.1, 0.1)]  # bottom-center (0.6, 0.6) right of line
        m = evaluate_tracking(tracks, [rule()], state, last, 0.0, "12:00", 0.4)
        self.assertEqual(len(m), 1)
        self.assertEqual(m[0].rule_id, "r")

    def test_tripwire_needs_two_positions(self):
        state, last = {}, {}  # no prev center -> can't test a crossing
        tracks = [T(1, 0.55, 0.5, 0.1, 0.1)]
        self.assertEqual(evaluate_tracking(tracks, [rule()], state, last, 0.0, "12:00", 0.4), [])

    def test_dwell_fires_once_at_threshold_then_not_again(self):
        POLY = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]
        dr = rule(type="dwell", zone=POLY, direction=None, dwell_seconds=5)
        state, last = {}, {}
        tr = [T(1, 0.4, 0.4, 0.1, 0.1)]  # inside
        # t=0 enters, not yet 5s -> no fire
        self.assertEqual(evaluate_tracking(tr, [dr], state, last, 0.0, "12:00", 0.4), [])
        # t=5 -> fires once
        self.assertEqual(len(evaluate_tracking(tr, [dr], state, last, 5.0, "12:00", 0.4)), 1)
        # t=6 -> already fired, no repeat
        self.assertEqual(evaluate_tracking(tr, [dr], state, last, 6.0, "12:00", 0.4), [])

    def test_dwell_resets_on_leave_and_reentry(self):
        POLY = [{"x": 0.0, "y": 0.0}, {"x": 0.5, "y": 0.0}, {"x": 0.5, "y": 0.5}, {"x": 0.0, "y": 0.5}]
        dr = rule(type="dwell", zone=POLY, direction=None, dwell_seconds=5)
        state, last = {}, {}
        inside = [T(1, 0.1, 0.1, 0.05, 0.05)]      # bottom-center (0.125, 0.15) inside
        outside = [T(1, 0.8, 0.8, 0.05, 0.05)]     # outside
        evaluate_tracking(inside, [dr], state, last, 0.0, "12:00", 0.4)
        evaluate_tracking(inside, [dr], state, last, 5.0, "12:00", 0.4)  # fires
        evaluate_tracking(outside, [dr], state, last, 6.0, "12:00", 0.4)  # leaves -> reset
        # re-enters, must dwell a fresh 5s from t=6, so t=7 no fire, t=11 fires again
        self.assertEqual(evaluate_tracking(inside, [dr], state, last, 7.0, "12:00", 0.4), [])
        self.assertEqual(len(evaluate_tracking(inside, [dr], state, last, 11.0, "12:00", 0.4)), 1)

    def test_class_and_conf_and_schedule_filter(self):
        state, last = {}, {1: (0.4, 0.6)}
        car = [T(1, 0.55, 0.5, 0.1, 0.1, label="car")]
        # rule only watches person -> no match
        self.assertEqual(evaluate_tracking(car, [rule()], state, last, 0.0, "12:00", 0.4), [])
        # schedule inactive -> no match even for a person crossing
        person = [T(1, 0.55, 0.5, 0.1, 0.1)]
        self.assertEqual(evaluate_tracking(person, [rule(schedule=["22:00", "06:00"])], state, last, 0.0, "12:00", 0.4), [])


if __name__ == "__main__":
    unittest.main()
