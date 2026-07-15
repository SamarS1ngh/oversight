import { redisPub } from "./redis";

// Redis channel names — must match the worker. See docs/EVENT_FORMAT.md.
export const CHANNELS = {
  commands: "camera:commands", // API -> worker
  detections: "detections", // worker -> API
  stats: "stats", // worker -> API (stats + state changes)
  webrtcRequests: "webrtc:requests", // API -> worker (SDP offer)
  webrtcAnswers: "webrtc:answers", // worker -> API (SDP answer)
  clips: "clips", // worker -> API (clip_ready)
  discoveryResults: "discovery:results", // worker -> API
} as const;

export type CameraCommand =
  | {
      type: "start";
      camera_id: string;
      rtsp_url: string;
      rules: unknown[];
      requested_by: string;
      ts: string;
    }
  | { type: "stop"; camera_id: string; requested_by: string; ts: string }
  | { type: "rules_update"; camera_id: string; rules: unknown[]; requested_by: string; ts: string }
  | { type: "discover"; scan_id: string; user_id: string; username: string; password: string; ts: string };

export async function publishCommand(cmd: CameraCommand): Promise<void> {
  await redisPub.publish(CHANNELS.commands, JSON.stringify(cmd));
}
