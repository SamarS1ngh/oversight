export type CameraStatus = "stopped" | "connecting" | "live" | "error";

export type Camera = {
  id: string;
  name: string;
  rtspUrl: string;
  location: string | null;
  enabled: boolean;
  status: CameraStatus;
  createdAt: string;
  updatedAt: string;
};

export type Alert = {
  id: string;
  cameraId: string;
  type: string;
  ts: string;
  confidence: number;
  count: number;
  bboxes: unknown;
  frameW: number | null;
  frameH: number | null;
  workerId: string | null;
  clipId?: string | null;
};

export type CamStats = {
  fps: number;
  detections_per_min: number;
  state?: string;
};

export type Clip = {
  id: string;
  cameraId: string;
  alertId: string | null;
  backend: string;
  path: string;
  thumbPath: string | null;
  startTs: string;
  endTs: string;
  durationMs: number;
  sizeBytes: number;
  createdAt: string;
};
