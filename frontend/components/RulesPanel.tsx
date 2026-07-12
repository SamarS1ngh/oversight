"use client";
import { useEffect, useState } from "react";
import type { Camera, Rule, Zone } from "@/lib/types";
import { api } from "@/lib/api";

const CLASSES = ["person", "bicycle", "car", "motorcycle", "bus", "truck", "cat", "dog", "backpack", "handbag", "suitcase"];
const empty = { name: "", type: "presence", classes: ["person"] as string[], zoneId: "", direction: "both", dwellSeconds: 10, scheduleStart: "", scheduleEnd: "", minConfidence: 0.4, severity: "low", enabled: true };

export function RulesPanel({ camera, onClose }: { camera: Camera; onClose: () => void }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);

  const load = () => { api.listRules(camera.id).then(setRules).catch(() => {}); };
  useEffect(() => { load(); api.listZones(camera.id).then(setZones).catch(() => {}); }, [camera.id]);

  const lineZones = zones.filter((z) => z.kind === "line");
  const polyZones = zones.filter((z) => z.kind === "polygon");

  async function save() {
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name, type: form.type, classes: form.classes,
        scheduleStart: form.scheduleStart || null, scheduleEnd: form.scheduleEnd || null,
        minConfidence: Number(form.minConfidence), severity: form.severity, enabled: form.enabled,
      };
      if (form.type === "tripwire") { body.zoneId = form.zoneId || undefined; body.direction = form.direction; }
      else if (form.type === "dwell") { body.zoneId = form.zoneId || undefined; body.dwellSeconds = Number(form.dwellSeconds); }
      else { body.zoneId = form.zoneId || undefined; }
      await api.createRule(camera.id, body);
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(r: Rule) { await api.updateRule(camera.id, r.id, { enabled: !r.enabled }); load(); }
  async function del(r: Rule) { await api.deleteRule(camera.id, r.id); load(); }
  function toggleClass(cl: string) { setForm((f: any) => ({ ...f, classes: f.classes.includes(cl) ? f.classes.filter((x: string) => x !== cl) : [...f.classes, cl] })); }
  // when the type changes, reset the zone selection (kinds differ)
  function setType(t: string) { setForm((f: any) => ({ ...f, type: t, zoneId: "" })); }

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
              <span className="muted small">{r.type} · {(r.classes as string[]).join(", ")}{r.type === "tripwire" ? ` · ${r.direction}` : ""}{r.type === "dwell" ? ` · ${r.dwellSeconds}s` : ""}</span>
              <button onClick={() => toggle(r)}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="danger" onClick={() => del(r)}>Delete</button>
            </div>
          ))}
        </div>
        <hr />
        <div className="rule-form">
          <input placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.type} onChange={(e) => setType(e.target.value)}>
            <option value="presence">presence (in area now)</option>
            <option value="tripwire">tripwire (cross a line)</option>
            <option value="dwell">dwell (loiter in area)</option>
          </select>
          <div className="class-chips">
            {CLASSES.map((cl) => (
              <button key={cl} className={form.classes.includes(cl) ? "chip on" : "chip"} onClick={() => toggleClass(cl)}>{cl}</button>
            ))}
          </div>
          {form.type === "presence" && (
            <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
              <option value="">Whole frame</option>
              {polyZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          )}
          {form.type === "tripwire" && (
            <>
              <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
                <option value="">Pick a line…</option>
                {lineZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                <option value="both">both ways</option><option value="in">in (→)</option><option value="out">out (←)</option>
              </select>
            </>
          )}
          {form.type === "dwell" && (
            <>
              <select value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })}>
                <option value="">Pick an area…</option>
                {polyZones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <label>Dwell secs <input type="number" min="1" step="1" value={form.dwellSeconds} onChange={(e) => setForm({ ...form, dwellSeconds: e.target.value })} /></label>
            </>
          )}
          <label>From <input type="time" value={form.scheduleStart} onChange={(e) => setForm({ ...form, scheduleStart: e.target.value })} /></label>
          <label>To <input type="time" value={form.scheduleEnd} onChange={(e) => setForm({ ...form, scheduleEnd: e.target.value })} /></label>
          <label>Min conf <input type="number" min="0" max="1" step="0.05" value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })} /></label>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          {err && <p className="error">{err}</p>}
          <button className="primary" onClick={save} disabled={!form.name || form.classes.length === 0 || (form.type !== "presence" && !form.zoneId)}>Add rule</button>
        </div>
        <div className="modal-actions"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
