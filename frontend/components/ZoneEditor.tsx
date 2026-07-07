"use client";
import { useEffect, useRef, useState } from "react";
import type { Camera, Zone } from "@/lib/types";
import { api } from "@/lib/api";
import { toNormalized, toPixels, type Pt } from "@/lib/geometry";

const W = 640, H = 360;

export function ZoneEditor({ camera, videoEl, onClose }: { camera: Camera; videoEl: HTMLVideoElement | null; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zones, setZones] = useState<Zone[]>([]);
  const [points, setPoints] = useState<Pt[]>([]);
  const [name, setName] = useState("Zone");
  const [snapshot, setSnapshot] = useState<ImageData | null>(null);
  const live = !!videoEl && videoEl.videoWidth > 0;

  useEffect(() => { api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  // grab one still frame from the live video
  useEffect(() => {
    if (!videoEl || !live) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(videoEl, 0, 0, W, H);
    setSnapshot(ctx.getImageData(0, 0, W, H));
  }, [videoEl, live]);

  // redraw snapshot + existing zones + in-progress polygon
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    if (snapshot) ctx.putImageData(snapshot, 0, 0);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
    for (const z of zones) drawPoly(ctx, toPixels(z.polygon as Pt[], W, H), "rgba(0,180,255,0.6)");
    if (points.length) drawPoly(ctx, points, "rgba(0,255,0,0.9)", true);
  }, [snapshot, zones, points]);

  function drawPoly(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, open = false) {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.15)"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    if (!open) ctx.closePath();
    ctx.stroke(); if (!open) ctx.fill();
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }

  function addPoint(e: React.MouseEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    setPoints((p) => [...p, { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }]);
  }

  async function save() {
    if (points.length < 3) return;
    await api.createZone(camera.id, { name: name.trim() || "Zone", polygon: toNormalized(points, W, H) });
    setPoints([]); setZones(await api.listZones(camera.id));
  }
  async function del(id: string) { await api.deleteZone(camera.id, id); setZones(await api.listZones(camera.id)); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Zones — {camera.name}</h3>
        {!live && <p className="muted small">Start the camera to draw zones on the live view.</p>}
        <canvas ref={canvasRef} width={W} height={H} onClick={addPoint} style={{ width: "100%", cursor: "crosshair", background: "#111" }} />
        <div className="modal-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zone name" />
          <button onClick={() => setPoints([])}>Clear</button>
          <button className="primary" onClick={save} disabled={points.length < 3}>Save zone ({points.length})</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="zone-list">
          {zones.map((z) => (
            <div key={z.id} className="zone-row"><span>{z.name}</span><button className="danger" onClick={() => del(z.id)}>Delete</button></div>
          ))}
        </div>
      </div>
    </div>
  );
}
