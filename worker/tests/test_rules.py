import unittest

from app.rules import point_in_polygon, schedule_active, evaluate, Match


class Obj:
    def __init__(self, x, y, w, h, conf, label):
        self.x, self.y, self.w, self.h, self.conf, self.label = x, y, w, h, conf, label


SQUARE = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}, {"x": 0.0, "y": 1.0}]


class TestGeometry(unittest.TestCase):
    def test_point_inside(self):
        self.assertTrue(point_in_polygon(0.5, 0.5, SQUARE))

    def test_point_outside(self):
        self.assertFalse(point_in_polygon(1.5, 0.5, SQUARE))

    def test_triangle(self):
        tri = [{"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 0.0, "y": 1.0}]
        self.assertTrue(point_in_polygon(0.2, 0.2, tri))
        self.assertFalse(point_in_polygon(0.8, 0.8, tri))


class TestSchedule(unittest.TestCase):
    def test_always_when_none(self):
        self.assertTrue(schedule_active(None, None, "03:00"))

    def test_normal_window(self):
        self.assertTrue(schedule_active("08:00", "17:00", "12:00"))
        self.assertFalse(schedule_active("08:00", "17:00", "20:00"))

    def test_wraparound_window(self):
        self.assertTrue(schedule_active("22:00", "06:00", "23:30"))
        self.assertTrue(schedule_active("22:00", "06:00", "02:00"))
        self.assertFalse(schedule_active("22:00", "06:00", "12:00"))


class TestEvaluate(unittest.TestCase):
    def test_implicit_default_alerts_on_person(self):
        objs = [Obj(0.1, 0.1, 0.1, 0.1, 0.9, "person"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car")]
        matches = evaluate(objs, [], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertIsNone(matches[0].rule_id)
        self.assertEqual(matches[0].severity, "low")
        self.assertEqual(matches[0].count, 1)  # person only

    def test_class_and_conf_filter(self):
        rule = {"id": "r1", "classes": ["car"], "zone": None, "schedule": [None, None], "min_confidence": 0.5, "severity": "high", "enabled": True}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car"), Obj(0.5, 0.5, 0.1, 0.1, 0.3, "car"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        matches = evaluate(objs, [rule], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].count, 1)  # only the 0.9 car
        self.assertEqual(matches[0].rule_id, "r1")

    def test_zone_containment_uses_bottom_center(self):
        # bottom-center of the box = (x+w/2, y+h) = (0.5, 0.6) -> inside top-left quadrant
        quad = [{"x": 0.0, "y": 0.0}, {"x": 0.6, "y": 0.0}, {"x": 0.6, "y": 0.7}, {"x": 0.0, "y": 0.7}]
        rule = {"id": "r1", "classes": ["person"], "zone": quad, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": True}
        inside = [Obj(0.4, 0.5, 0.2, 0.1, 0.9, "person")]   # bottom-center (0.5, 0.6) inside
        outside = [Obj(0.7, 0.7, 0.2, 0.1, 0.9, "person")]  # bottom-center (0.8, 0.8) outside
        self.assertEqual(len(evaluate(inside, [rule], "12:00", 0.4)), 1)
        self.assertEqual(len(evaluate(outside, [rule], "12:00", 0.4)), 0)

    def test_schedule_gates_the_rule(self):
        rule = {"id": "r1", "classes": ["person"], "zone": None, "schedule": ["22:00", "06:00"], "min_confidence": 0.4, "severity": "high", "enabled": True}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        self.assertEqual(len(evaluate(objs, [rule], "23:00", 0.4)), 1)
        self.assertEqual(len(evaluate(objs, [rule], "12:00", 0.4)), 0)

    def test_disabled_rule_skipped(self):
        rule = {"id": "r1", "classes": ["person"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": False}
        objs = [Obj(0.5, 0.5, 0.1, 0.1, 0.9, "person")]
        # no enabled rules -> falls back to implicit default (person, low)
        matches = evaluate(objs, [rule], "12:00", 0.4)
        self.assertEqual(len(matches), 1)
        self.assertIsNone(matches[0].rule_id)

    def test_multiple_rules_multiple_matches(self):
        r1 = {"id": "r1", "classes": ["person"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "low", "enabled": True}
        r2 = {"id": "r2", "classes": ["car"], "zone": None, "schedule": [None, None], "min_confidence": 0.4, "severity": "high", "enabled": True}
        objs = [Obj(0.1, 0.1, 0.1, 0.1, 0.9, "person"), Obj(0.5, 0.5, 0.1, 0.1, 0.9, "car")]
        matches = evaluate(objs, [r1, r2], "12:00", 0.4)
        self.assertEqual({m.rule_id for m in matches}, {"r1", "r2"})


if __name__ == "__main__":
    unittest.main()
