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
  const [mode, setMode] = useState<"polygon" | "line">("polygon");
  const [snapshot, setSnapshot] = useState<ImageData | null>(null);
  const live = !!videoEl && videoEl.videoWidth > 0;
  const need = mode === "line" ? 2 : 3;

  useEffect(() => { api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  useEffect(() => {
    if (!videoEl || !live) return;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(videoEl, 0, 0, W, H);
    setSnapshot(ctx.getImageData(0, 0, W, H));
  }, [videoEl, live]);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d")!;
    if (snapshot) ctx.putImageData(snapshot, 0, 0);
    else { ctx.fillStyle = "#222"; ctx.fillRect(0, 0, W, H); }
    for (const z of zones) {
      const px = toPixels(z.polygon as Pt[], W, H);
      if (z.kind === "line") drawLine(ctx, px, "rgba(255,180,0,0.8)");
      else drawPoly(ctx, px, "rgba(0,180,255,0.6)");
    }
    if (points.length) {
      if (mode === "line") drawLine(ctx, points, "rgba(0,255,0,0.9)");
      else drawPoly(ctx, points, "rgba(0,255,0,0.9)", true);
    }
  }, [snapshot, zones, points, mode]);

  function drawPoly(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, open = false) {
    if (!pts.length) return;
    ctx.strokeStyle = color; ctx.fillStyle = color.replace(/[\d.]+\)$/, "0.15)"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach((p) => ctx.lineTo(p.x, p.y));
    if (!open) ctx.closePath();
    ctx.stroke(); if (!open) ctx.fill();
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }
  // draw a segment A->B with an arrowhead at B (the direction reference)
  function drawLine(ctx: CanvasRenderingContext2D, pts: Pt[], color: string) {
    if (pts.length < 2) { if (pts[0]) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 3, 0, 7); ctx.fill(); } return; }
    const [a, b] = pts;
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath(); ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 10 * Math.cos(ang - 0.4), b.y - 10 * Math.sin(ang - 0.4));
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - 10 * Math.cos(ang + 0.4), b.y - 10 * Math.sin(ang + 0.4));
    ctx.stroke();
  }

  function addPoint(e: React.MouseEvent) {
    const r = canvasRef.current!.getBoundingClientRect();
    const p = { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
    setPoints((prev) => (mode === "line" ? [...prev, p].slice(-2) : [...prev, p]));
  }

  async function save() {
    if (points.length < need) return;
    await api.createZone(camera.id, { name: name.trim() || "Zone", kind: mode, polygon: toNormalized(points, W, H) });
    setPoints([]); setZones(await api.listZones(camera.id));
  }
  async function del(id: string) { await api.deleteZone(camera.id, id); setZones(await api.listZones(camera.id)); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Zones — {camera.name}</h3>
        <div className="mode-toggle">
          <button className={mode === "polygon" ? "chip on" : "chip"} onClick={() => { setMode("polygon"); setPoints([]); }}>Polygon (area)</button>
          <button className={mode === "line" ? "chip on" : "chip"} onClick={() => { setMode("line"); setPoints([]); }}>Line (tripwire)</button>
        </div>
        {!live && <p className="muted small">Start the camera to draw zones on the live view.</p>}
        {mode === "line" && <p className="muted small">Click 2 points. The arrow shows the line's A→B direction (used by tripwire in/out).</p>}
        <canvas ref={canvasRef} width={W} height={H} onClick={addPoint} style={{ width: "100%", cursor: "crosshair", background: "#111" }} />
        <div className="modal-actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Zone name" />
          <button onClick={() => setPoints([])}>Clear</button>
          <button className="primary" onClick={save} disabled={points.length < need}>Save {mode} ({points.length})</button>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="zone-list">
          {zones.map((z) => (
            <div key={z.id} className="zone-row"><span>{z.name} <span className="muted small">({z.kind})</span></span><button className="danger" onClick={() => del(z.id)}>Delete</button></div>
          ))}
        </div>
      </div>
    </div>
  );
}
