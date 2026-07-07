import unittest

from app.detector import COCO_NAMES, class_ids_for, Box


class TestDetectorClasses(unittest.TestCase):
    def test_box_has_label(self):
        b = Box(0.1, 0.2, 0.3, 0.4, 0.9, "car")
        self.assertEqual(b.label, "car")

    def test_class_ids_for_maps_names_to_coco_ids(self):
        self.assertEqual(sorted(class_ids_for(["person", "car"])), [0, 2])

    def test_class_ids_for_skips_unknown(self):
        self.assertEqual(class_ids_for(["person", "dragon"]), [0])

    def test_coco_names_covers_curated_set(self):
        for name in ["person", "car", "truck", "dog", "backpack", "suitcase"]:
            self.assertIn(name, COCO_NAMES.values())


if __name__ == "__main__":
    unittest.main()
