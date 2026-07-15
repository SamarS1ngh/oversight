"use client";
import { useState } from "react";
import type { Camera } from "@/lib/types";
import { api } from "@/lib/api";

type Props = {
  camera?: Camera | null;
  prefill?: { name?: string; rtspUrl?: string };
  onClose: () => void;
  onSaved: () => void;
};

export function CameraForm({ camera, prefill, onClose, onSaved }: Props) {
  const [name, setName] = useState(camera?.name ?? prefill?.name ?? "");
  const [rtsp, setRtsp] = useState(camera?.rtspUrl ?? prefill?.rtspUrl ?? "");
  const [location, setLocation] = useState(camera?.location ?? "");
  const [enabled, setEnabled] = useState(camera?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body = {
        name,
        rtsp_url: rtsp,
        location: location || null,
        enabled,
      };
      if (camera) await api.updateCamera(camera.id, body);
      else await api.createCamera(body);
      onSaved();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="card modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={save}
      >
        <h2>{camera ? "Edit camera" : "Add camera"}</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          RTSP URL
          <input
            value={rtsp}
            onChange={(e) => setRtsp(e.target.value)}
            placeholder="rtsp://mediamtx:8554/cam"
            required
          />
        </label>
        <label>
          Location
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
        {err && <p className="error">{err}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
