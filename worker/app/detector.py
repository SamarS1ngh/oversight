from abc import ABC, abstractmethod
from dataclasses import dataclass

# COCO id -> name, curated to the surveillance-relevant subset.
COCO_NAMES = {
    0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus",
    7: "truck", 15: "cat", 16: "dog", 24: "backpack", 26: "handbag", 28: "suitcase",
}
_NAME_TO_ID = {v: k for k, v in COCO_NAMES.items()}
DEFAULT_CLASSES = list(COCO_NAMES.values())


def class_ids_for(names) -> list[int]:
    """COCO ids for the given class names, skipping unknown names."""
    return [_NAME_TO_ID[n] for n in names if n in _NAME_TO_ID]


@dataclass
class Box:
    """A detected object box, normalized to [0, 1] with origin top-left."""

    x: float
    y: float
    w: float
    h: float
    conf: float
    label: str


class Detector(ABC):
    @abstractmethod
    def detect_objects(self, frame_bgr) -> list[Box]:
        ...


class YoloDetector(Detector):
    def __init__(self, model_path: str, conf: float, classes=None):
        from ultralytics import YOLO

        self.model = YOLO(model_path)
        self.conf = conf
        self.class_ids = class_ids_for(classes or DEFAULT_CLASSES)

    def detect_objects(self, frame_bgr) -> list[Box]:
        h, w = frame_bgr.shape[:2]
        results = self.model.predict(
            frame_bgr, conf=self.conf, classes=self.class_ids, verbose=False
        )
        boxes: list[Box] = []
        for r in results:
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                cls_id = int(b.cls[0])
                boxes.append(
                    Box(
                        x=x1 / w,
                        y=y1 / h,
                        w=(x2 - x1) / w,
                        h=(y2 - y1) / h,
                        conf=round(float(b.conf[0]), 4),
                        label=COCO_NAMES.get(cls_id, str(cls_id)),
                    )
                )
        return boxes
