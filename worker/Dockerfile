FROM python:3.12-slim
WORKDIR /app

# ffmpeg for RTSP/PyAV; libgl + libglib for OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# bake the YOLOv8n weights into the image so the first camera start is instant
RUN python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

COPY . .

CMD ["python", "-m", "app.main"]
