from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass
class Box:
    """A person bounding box, normalized to [0, 1] with origin top-left."""

    x: float
    y: float
    w: float
    h: float
    conf: float


class Detector(ABC):
    """Detection is isolated behind this interface so the model can be swapped
    (YOLOv5n, RT-DETR, an ONNX export) without touching the camera pipeline."""

    @abstractmethod
    def detect_persons(self, frame_bgr) -> list[Box]:
        ...


class YoloDetector(Detector):
    PERSON_CLASS = 0  # COCO class id for "person"

    def __init__(self, model_path: str, conf: float):
        # heavy import kept local so unit tests of the pipeline logic don't pull
        # in torch / ultralytics
        from ultralytics import YOLO

        self.model = YOLO(model_path)
        self.conf = conf

    def detect_persons(self, frame_bgr) -> list[Box]:
        h, w = frame_bgr.shape[:2]
        results = self.model.predict(
            frame_bgr,
            conf=self.conf,
            classes=[self.PERSON_CLASS],
            verbose=False,
        )
        boxes: list[Box] = []
        for r in results:
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                conf = float(b.conf[0])
                boxes.append(
                    Box(
                        x=x1 / w,
                        y=y1 / h,
                        w=(x2 - x1) / w,
                        h=(y2 - y1) / h,
                        conf=round(conf, 4),
                    )
                )
        return boxes
