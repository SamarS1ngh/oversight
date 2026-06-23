"use client";
import { useEffect, useRef, useState } from "react";
import type { Alert, Camera, CamStats } from "@/lib/types";
import { api } from "@/lib/api";
import { connectCameraStream } from "@/lib/webrtc";

type Props = {
  camera: Camera;
  liveState?: string;
  stats?: CamStats;
  alerts: Alert[];
  onEdit: () => void;
  onDeleted: () => void;
};

const STATE_LABEL: Record<string, string> = {
  stopped: "Stopped",
  connecting: "Connecting…",
  live: "Live",
  error: "Error",
};

export function CameraTile({
  camera,
  liveState,
  stats,
  alerts,
  onEdit,
  onDeleted,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);

  const state = liveState ?? camera.status;
  const running = state === "live" || state === "connecting" || streaming;

  async function connectStream() {
    try {
      const pc = await connectCameraStream(camera.id, (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setStreaming(true);
      });
      pcRef.current = pc;
    } catch (e: any) {
      setErr("stream: " + e.message);
    }
  }

  async function start() {
    setErr(null);
    setBusy(true);
    try {
      await api.startCamera(camera.id);
      // give the worker a beat to open the RTSP stream before negotiating
      await new Promise((r) => setTimeout(r, 1200));
      await connectStream();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    setErr(null);
    try {
      await api.stopCamera(camera.id);
      pcRef.current?.close();
      pcRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setStreaming(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    if (!confirm(`Delete "${camera.name}"?`)) return;
    pcRef.current?.close();
    try {
      await api.deleteCamera(camera.id);
      onDeleted();
    } catch (e: any) {
      setErr(e.message);
    }
  }

  useEffect(() => () => pcRef.current?.close(), []);

  return (
    <div className="tile card">
      <div className="tile-head">
        <div className="tile-title">
          <strong>{camera.name}</strong>
          {camera.location && <span className="loc">{camera.location}</span>}
        </div>
        <span className={`badge ${state}`}>
          {STATE_LABEL[state] ?? state}
        </span>
      </div>

      <div className="video-wrap">
        <video ref={videoRef} muted playsInline />
        {!streaming && (
          <div className="video-placeholder">
            {state === "connecting" ? "connecting…" : "stream stopped"}
          </div>
        )}
      </div>

      <div className="stats">
        <span>FPS {stats?.fps != null ? stats.fps.toFixed(1) : "—"}</span>
        <span>det/min {stats?.detections_per_min ?? "—"}</span>
      </div>

      {err && <p className="error">{err}</p>}

      <div className="tile-actions">
        {running ? (
          <button onClick={stop} disabled={busy}>
            Stop
          </button>
        ) : (
          <button onClick={start} disabled={busy} className="primary">
            Start
          </button>
        )}
        <button onClick={onEdit}>Edit</button>
        <button onClick={del} className="danger">
          Delete
        </button>
      </div>

      <div className="alerts">
        <div className="alerts-head">Recent alerts</div>
        {alerts.length === 0 ? (
          <p className="muted small">none yet</p>
        ) : (
          alerts.slice(0, 5).map((a) => (
            <div key={a.id} className="alert-row">
              <span className="dot" />
              <span>
                {a.count} person{a.count > 1 ? "s" : ""}
              </span>
              <span className="conf">
                {Math.round((a.confidence ?? 0) * 100)}%
              </span>
              <span className="time">
                {new Date(a.ts).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
