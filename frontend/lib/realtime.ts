"use client";
import { useEffect, useRef, useState } from "react";
import { WS_URL } from "./config";
import type { CamStats } from "./types";

type AlertBump = { cameraId: string; alert: any };

// One WebSocket for the whole dashboard. Auto-reconnects. Surfaces per-camera
// stats + state and the latest alert (the dashboard appends it to a buffer).
export function useRealtime(token: string | null) {
  const [statsByCam, setStats] = useState<Record<string, CamStats>>({});
  const [stateByCam, setStateByCam] = useState<Record<string, string>>({});
  const [alertBump, setAlertBump] = useState<AlertBump | null>(null);
  const [clipBump, setClipBump] = useState<{
    alertId: string | null;
    cameraId: string;
    clip: any;
  } | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    function connect() {
      const ws = new WebSocket(`${WS_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (e) => {
        let msg: any;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.channel === "stats") {
          const d = msg.data;
          setStats((s) => ({
            ...s,
            [d.camera_id]: {
              fps: d.fps,
              detections_per_min: d.detections_per_min,
              state: d.state,
            },
          }));
          if (d.state)
            setStateByCam((s) => ({ ...s, [d.camera_id]: d.state }));
        } else if (msg.channel === "state") {
          const d = msg.data;
          if (d.camera_id && d.state)
            setStateByCam((s) => ({ ...s, [d.camera_id]: d.state }));
        } else if (msg.channel === "alert") {
          setAlertBump({ cameraId: msg.data.camera_id, alert: msg.data });
        } else if (msg.channel === "clip") {
          setClipBump({
            alertId: msg.data.alert_id ?? null,
            cameraId: msg.data.camera_id,
            clip: msg.data,
          });
        }
      };
    }

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [token]);

  return { statsByCam, stateByCam, alertBump, clipBump, connected };
}
