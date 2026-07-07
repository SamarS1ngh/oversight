"use client";
import { useEffect, useState } from "react";
import type { Camera, Rule, Zone } from "@/lib/types";
import { api } from "@/lib/api";

const CLASSES = ["person", "bicycle", "car", "motorcycle", "bus", "truck", "cat", "dog", "backpack", "handbag", "suitcase"];
const empty = { name: "", classes: ["person"] as string[], zoneId: "", scheduleStart: "", scheduleEnd: "", minConfidence: 0.4, severity: "low", enabled: true };

export function RulesPanel({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { api.listRules(camera.id).then(setRules).catch(() => {}); };
  useEffect(() => { load(); api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  async function save() {
    setErr(null);
    try {
      await api.createRule(camera.id, {
        name: form.name, classes: form.classes,
        zoneId: form.zoneId || undefined,
        scheduleStart: form.scheduleStart || null, scheduleEnd: form.scheduleEnd || null,
        minConfidence: Number(form.minConfidence), severity: form.severity, enabled: form.enabled,
      });
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(r: Rule) { await api.updateRule(camera.id, r.id, { enabled: !r.enabled }); load(); }
  async function del(r: Rule) { await api.deleteRule(camera.id, r.id); load(); }
  function toggleClass(cl: string) { setForm((f: any) => ({ ...f, classes: f.classes.includes(cl) ? f.classes.filter((x: string) => x !== cl) : [...f.classes, cl] })); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="clip-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Rules — {camera.name}</h3>
        <div className="rules-list">
          {rules.length === 0 && <p className="muted small">No rules — this camera alerts on any person (default).</p>}
          {rules.map((r) => (
            <div key={r.id} className="rule-row">
              <span className={`badge ${r.severity}`}>{r.severity}</span>
              <strong>{r.name}</strong>
              <span className="muted small">{(r.classes as string[]).join(", ")}{r.zoneId ? " · zoned" : ""}{r.scheduleStart ? ` · ${r.scheduleStart}–${r.scheduleEnd}` : ""}</span>
              <button onClick={() => toggle(r)}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="danger" onClick={() => del(r)}>Delete</button>
            </div>
          ))}
        </div>
        <hr />
        <div className="rule-form">
          <input placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="class-chips">
            {CLASSES.map((cl) => (
              <button key={cl} className={form.classes.includes(cl) ? "chip on" : "chip"} onClick={() => toggleClass(cl)}>{cl}</button>
            ))}
          </div>
          <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
            <option value="">Whole frame</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <label>From <input type="time" value={form.scheduleStart} onChange={(e) => setForm({ ...form, scheduleStart: e.target.value })} /></label>
          <label>To <input type="time" value={form.scheduleEnd} onChange={(e) => setForm({ ...form, scheduleEnd: e.target.value })} /></label>
          <label>Min conf <input type="number" min="0" max="1" step="0.05" value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })} /></label>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          {err && <p className="error">{err}</p>}
          <button className="primary" onClick={save} disabled={!form.name || form.classes.length === 0}>Add rule</button>
        </div>
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
