"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import type { Camera, DiscoveredCamera } from "@/lib/types";

type Props = {
  discovered: DiscoveredCamera[];
  cameras: Camera[];
  onClose: () => void;
  onAdd: (p: { name: string; rtspUrl: string }) => void;
};

export function ScanModal({ discovered, cameras, onClose, onAdd }: Props) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const existing = new Set(cameras.map((c) => c.rtspUrl));

  async function scan() {
    setErr(null); setBusy(true);
    try { await api.scanNetwork(user, pass); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Scan network for cameras</h2>
        <label>Username <input value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label>Password <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={scan} disabled={busy}>{busy ? "Scanning…" : "Scan"}</button>
        <div className="rules-list">
          {discovered.length === 0 && <p className="muted small">No cameras found yet. Scan looks for ONVIF cameras on your network.</p>}
          {discovered.map((d) => {
            const added = d.rtsp_url ? existing.has(d.rtsp_url) : false;
            return (
              <div key={d.ip} className="rule-row">
                <strong>{d.name}</strong>
                <span className="muted small">{d.ip}{d.hardware ? ` · ${d.hardware}` : ""}</span>
                {d.rtsp_url ? (
                  added ? <span className="muted small">already added</span>
                    : <button onClick={() => onAdd({ name: d.name, rtspUrl: d.rtsp_url! })}>Add</button>
                ) : <span className="muted small">{d.error ?? "needs credentials / not ONVIF"}</span>}
              </div>
            );
          })}
        </div>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
