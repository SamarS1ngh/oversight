"use client";
import { useEffect, useRef, useState } from "react";
import type { Alert, Camera, CamStats } from "@/lib/types";
import { api, clipThumbUrl } from "@/lib/api";
import { connectCameraStream } from "@/lib/webrtc";
import { ZoneEditor } from "./ZoneEditor";
import { RulesPanel } from "./RulesPanel";

// One tile on the dashboard = one camera.
// It shows the live video, some stats, recent alerts, and
// Start / Stop / Edit / Delete buttons.

type Props = {
  camera: Camera;
  // Latest status pushed over the websocket ("live", "error", ...).
  // Falls back to the status saved in the database if we haven't
  // heard anything over the websocket yet.
  liveState?: string;
  stats?: CamStats;
  alerts: Alert[];
  onEdit: () => void;
  onDeleted: () => void;
  onPlayClip: (clipId: string) => void;
};

// Pretty text for each status value.
const STATE_LABEL: Record<string, string> = {
  stopped: "Stopped",
  connecting: "Connecting…",
  live: "Live",
  error: "Error",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

export function CameraTile({
  camera,
  liveState,
  stats,
  alerts,
  onEdit,
  onDeleted,
  onPlayClip,
}: Props) {
  // The <video> element we pour the WebRTC stream into.
  const videoRef = useRef<HTMLVideoElement>(null);

  // The open WebRTC connection (null when there isn't one).
  // Kept in a ref, not state, because changing it should not re-render.
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  // True while a Start/Stop request is in flight — disables the buttons.
  const [isBusy, setIsBusy] = useState(false);

  // Error text to show under the video, or null when all is fine.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // True once video frames are actually arriving.
  const [isReceivingVideo, setIsReceivingVideo] = useState(false);

  // True while the zone editor modal is open.
  const [showZones, setShowZones] = useState(false);

  // True while the rules panel modal is open.
  const [showRules, setShowRules] = useState(false);

  // Optimistic ack/resolve status overrides, keyed by alert id, so the
  // row updates immediately instead of waiting on the next poll/WS push.
  const [localStatus, setLocalStatus] = useState<Record<string, string>>({});

  async function ackAlert(id: string) {
    await api.ackAlert(id);
    setLocalStatus((s) => ({ ...s, [id]: "acked" }));
  }

  async function resolveAlert(id: string) {
    await api.resolveAlert(id);
    setLocalStatus((s) => ({ ...s, [id]: "resolved" }));
  }

  // What state is the camera in right now?
  // Websocket value wins; database value is the fallback.
  const cameraState = liveState ?? camera.status;
  const isRunning =
    ["live", "connecting", "reconnecting", "offline"].includes(cameraState) ||
    isReceivingVideo;

  // Open a WebRTC connection to the backend and attach the incoming
  // video stream to our <video> element.
  async function connectVideoStream() {
    try {
      const peerConnection = await connectCameraStream(camera.id, (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setIsReceivingVideo(true);
      });
      peerConnectionRef.current = peerConnection;
    } catch (e: any) {
      setErrorMessage("stream: " + e.message);
    }
  }

  // Start button: tell the backend to start the camera worker,
  // wait a moment so it can open the RTSP feed, then connect video.
  async function handleStart() {
    setErrorMessage(null);
    setIsBusy(true);
    try {
      await api.startCamera(camera.id);
      // The worker needs a moment to open the RTSP stream before
      // WebRTC negotiation can succeed.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await connectVideoStream();
    } catch (e: any) {
      setErrorMessage(e.message);
    } finally {
      setIsBusy(false);
    }
  }

  // Stop button: tell the backend to stop, then tear down our
  // WebRTC connection and blank the video.
  async function handleStop() {
    setIsBusy(true);
    setErrorMessage(null);
    try {
      await api.stopCamera(camera.id);
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setIsReceivingVideo(false);
    } catch (e: any) {
      setErrorMessage(e.message);
    } finally {
      setIsBusy(false);
    }
  }

  // Delete button: confirm, close any open connection, delete on the
  // backend, then tell the parent so it can remove this tile.
  async function handleDelete() {
    if (!confirm(`Delete "${camera.name}"?`)) return;
    peerConnectionRef.current?.close();
    try {
      await api.deleteCamera(camera.id);
      onDeleted();
    } catch (e: any) {
      setErrorMessage(e.message);
    }
  }

  // When the tile unmounts, close the WebRTC connection so we don't
  // leak it.
  useEffect(() => () => peerConnectionRef.current?.close(), []);

  // Auto-connect video when the camera is already running — e.g. after
  // a page reload, or when another browser session started it. Without
  // this the tile would say "stream stopped" until the user clicks
  // Start, even though detection is live. The peerConnectionRef check
  // makes sure we never open a second connection.
  useEffect(() => {
    if (isRunning && !peerConnectionRef.current) connectVideoStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  return (
    <div className="tile card">
      {/* Header: camera name, location, status badge */}
      <div className="tile-head">
        <div className="tile-title">
          <strong>{camera.name}</strong>
          {camera.location && <span className="loc">{camera.location}</span>}
        </div>
        <span className={`badge ${cameraState}`}>
          {STATE_LABEL[cameraState] ?? cameraState}
        </span>
      </div>

      {/* Live video, with a text placeholder until frames arrive */}
      <div className="video-wrap">
        <video ref={videoRef} muted playsInline />
        {!isReceivingVideo && (
          <div className="video-placeholder">
            {cameraState === "connecting" ? "connecting…" : "stream stopped"}
          </div>
        )}
      </div>

      {/* Stats row: "—" means no data yet */}
      <div className="stats">
        <span>FPS {stats?.fps != null ? stats.fps.toFixed(1) : "—"}</span>
        <span>det/min {stats?.detections_per_min ?? "—"}</span>
        <span>reconnects {stats?.reconnect_count ?? "—"}</span>
        <span>
          seen {camera.lastSeenAt ? new Date(camera.lastSeenAt).toLocaleTimeString() : "—"}
        </span>
      </div>

      {errorMessage && <p className="error">{errorMessage}</p>}

      {/* Action buttons: Start and Stop swap depending on state */}
      <div className="tile-actions">
        {isRunning ? (
          <button onClick={handleStop} disabled={isBusy}>
            Stop
          </button>
        ) : (
          <button onClick={handleStart} disabled={isBusy} className="primary">
            Start
          </button>
        )}
        <button onClick={onEdit}>Edit</button>
        <button onClick={() => setShowZones(true)}>Zones</button>
        <button onClick={() => setShowRules(true)}>Rules</button>
        <button onClick={handleDelete} className="danger">
          Delete
        </button>
        <label className="small">
          <input
            type="checkbox"
            defaultChecked={camera.notifyOnOffline}
            onChange={(e) =>
              api
                .updateCamera(camera.id, { notify_on_offline: e.target.checked })
                .catch(() => {})
            }
          />
          Notify if offline
        </label>
      </div>

      {/* Last 5 alerts for this camera */}
      <div className="alerts">
        <div className="alerts-head">Recent alerts</div>
        {alerts.length === 0 ? (
          <p className="muted small">none yet</p>
        ) : (
          alerts.slice(0, 5).map((alert) => {
            const status = localStatus[alert.id] ?? alert.status;
            return (
              <div
                key={alert.id}
                className={`alert-row sev-${alert.severity ?? "low"} ${
                  status === "resolved" ? "resolved" : ""
                }`}
              >
                {alert.clipId ? (
                  <button
                    className="thumb-btn"
                    title="Play clip"
                    onClick={() => onPlayClip(alert.clipId!)}
                  >
                    <img src={clipThumbUrl(alert.clipId)} alt="" className="thumb" />
                    <span className="play-badge">▶</span>
                  </button>
                ) : (
                  <span className={`dot sev-${alert.severity ?? "low"}`} />
                )}
                <span>
                  {alert.count}× {alert.label ?? "person"}
                </span>
                <span className="conf">{Math.round((alert.confidence ?? 0) * 100)}%</span>
                <span className="time">{new Date(alert.ts).toLocaleTimeString()}</span>
                {status !== "resolved" && (
                  <span className="ack-actions">
                    {status !== "acked" && (
                      <button onClick={() => ackAlert(alert.id)}>Ack</button>
                    )}
                    <button onClick={() => resolveAlert(alert.id)}>Resolve</button>
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {showZones && (
        <ZoneEditor
          camera={camera}
          videoEl={videoRef.current}
          onClose={() => setShowZones(false)}
        />
      )}

      {showRules && (
        <RulesPanel camera={camera} onClose={() => setShowRules(false)} />
      )}
    </div>
  );
}
