"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";
import type { Camera, NotifChannel } from "@/lib/types";

const TYPES = ["webhook", "ntfy", "telegram", "pushover"] as const;
const empty = { type: "ntfy", name: "", config: {} as Record<string, string>, minSeverity: "low", cameraIds: null as string[] | null, cooldownSecs: 60, enabled: true };

const CONFIG_FIELDS: Record<string, string[]> = {
  webhook: ["url"],
  ntfy: ["topic", "server", "token"],
  telegram: ["botToken", "chatId"],
  pushover: ["token", "user"],
};

function urlB64ToUint8(s: string) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...b].map((c) => c.charCodeAt(0)));
}

export default function NotificationsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<NotifChannel[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [form, setForm] = useState<any>(empty);
  const [err, setErr] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const load = () => api.listChannels().then(setChannels).catch(() => {});
  useEffect(() => {
    if (!getToken()) { router.replace("/login"); return; }
    load(); api.listCameras().then(setCameras).catch(() => {});
  }, [router]);

  async function save() {
    setErr(null);
    try {
      await api.createChannel({
        type: form.type, name: form.name, config: form.config,
        minSeverity: form.minSeverity, cameraIds: form.cameraIds,
        cooldownSecs: Number(form.cooldownSecs), enabled: form.enabled,
      });
      setForm(empty); load();
    } catch (e: any) { setErr(e.message); }
  }
  async function toggle(ch: NotifChannel) { await api.updateChannel(ch.id, { enabled: !ch.enabled }); load(); }
  async function del(ch: NotifChannel) { await api.deleteChannel(ch.id); load(); }
  async function test(ch: NotifChannel) {
    setTestMsg((m) => ({ ...m, [ch.id]: "…" }));
    try { const r = await api.testChannel(ch.id); setTestMsg((m) => ({ ...m, [ch.id]: r.ok ? "delivered" : `failed (${r.status ?? r.error})` })); }
    catch (e: any) { setTestMsg((m) => ({ ...m, [ch.id]: "failed" })); }
  }
  const setCfg = (k: string, v: string) => setForm((f: any) => ({ ...f, config: { ...f.config, [k]: v } }));

  async function enablePush() {
    setErr(null);
    try {
      if (!("serviceWorker" in navigator)) throw new Error("no service worker support");
      const reg = await navigator.serviceWorker.register("/sw.js");
      const { key } = await api.vapidPublicKey();
      if (!key) throw new Error("web push not configured on the server (set VAPID env)");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
      const j = sub.toJSON();
      if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error("subscription missing endpoint/keys");
      await api.createChannel({
        type: "webpush", name: "This browser",
        config: { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
        minSeverity: "low", cameraIds: null, cooldownSecs: 60, enabled: true,
      });
      load();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <main className="dash">
      <header className="topbar">
        <h1>Notifications</h1>
        <div className="top-actions"><a href="/dashboard" className="btn">← Dashboard</a></div>
      </header>

      <div className="rules-list">
        {channels.length === 0 && <p className="muted small">No channels yet. Add one below to get alerts on your phone / Slack / automation.</p>}
        {channels.map((ch) => (
          <div key={ch.id} className="rule-row">
            <span className="badge">{ch.type}</span>
            <strong>{ch.name}</strong>
            <span className="muted small">≥{ch.minSeverity}{ch.cameraIds ? " · some cameras" : " · all cameras"} · {ch.cooldownSecs}s</span>
            <button onClick={() => test(ch)}>Test</button>
            {testMsg[ch.id] && <span className="muted small">{testMsg[ch.id]}</span>}
            <button onClick={() => toggle(ch)}>{ch.enabled ? "Disable" : "Enable"}</button>
            <button className="danger" onClick={() => del(ch)}>Delete</button>
          </div>
        ))}
      </div>
      <hr />
      <button className="btn" onClick={enablePush}>Enable push on this browser</button>
      <div className="rule-form">
        <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, config: {} })}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {CONFIG_FIELDS[form.type].map((k) => (
          <input key={k} placeholder={k} value={form.config[k] ?? ""} onChange={(e) => setCfg(k, e.target.value)} />
        ))}
        <label>Min severity
          <select value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}>
            <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
        </label>
        <label>Cooldown s <input type="number" min="0" value={form.cooldownSecs} onChange={(e) => setForm({ ...form, cooldownSecs: e.target.value })} /></label>
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={save} disabled={!form.name}>Add channel</button>
      </div>
    </main>
  );
}
