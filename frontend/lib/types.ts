export type CameraStatus =
  | "stopped"
  | "connecting"
  | "live"
  | "error"
  | "reconnecting"
  | "offline";

export type Camera = {
  id: string;
  name: string;
  rtspUrl: string;
  location: string | null;
  enabled: boolean;
  status: CameraStatus;
  notifyOnOffline: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Severity = "low" | "medium" | "high";
export type AlertStatus = "new" | "acked" | "resolved";

export type ZoneKind = "polygon" | "line";
export type RuleType = "presence" | "tripwire" | "dwell";
export type Direction = "in" | "out" | "both";

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
  label?: string | null;
  ruleId?: string | null;
  severity?: Severity;
  status?: AlertStatus;
};

export type Zone = {
  id: string;
  cameraId: string;
  name: string;
  polygon: { x: number; y: number }[];
  kind: ZoneKind;
  createdAt: string;
};

export type Rule = {
  id: string;
  cameraId: string;
  name: string;
  zoneId: string | null;
  classes: string[];
  scheduleStart: string | null;
  scheduleEnd: string | null;
  minConfidence: number;
  severity: Severity;
  enabled: boolean;
  type: RuleType;
  direction: Direction | null;
  dwellSeconds: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CamStats = {
  fps: number;
  detections_per_min: number;
  state?: string;
  reconnect_count?: number;
  last_frame_at?: string | null;
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

export type NotifChannelType = "webhook" | "ntfy" | "telegram" | "pushover" | "webpush";

export type NotifChannel = {
  id: string;
  type: NotifChannelType;
  name: string;
  config: Record<string, string>;
  minSeverity: Severity;
  cameraIds: string[] | null;
  cooldownSecs: number;
  enabled: boolean;
  createdAt: string;
};

export type DiscoveredCamera = {
  name: string;
  ip: string;
  hardware?: string | null;
  rtsp_url: string | null;
  error: string | null;
};
