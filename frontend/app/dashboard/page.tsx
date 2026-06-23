"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken, clearToken } from "@/lib/api";
import { useRealtime } from "@/lib/realtime";
import { CameraTile } from "@/components/CameraTile";
import { CameraForm } from "@/components/CameraForm";
import type { Alert, Camera } from "@/lib/types";

export default function Dashboard() {
  const router = useRouter();
  const [token, setTokenState] = useState<string | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [alertsByCam, setAlertsByCam] = useState<Record<string, Alert[]>>({});
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Camera | null>(null);
  const [loading, setLoading] = useState(true);

  const { statsByCam, stateByCam, alertBump, connected } = useRealtime(token);

  useEffect(() => {
    const t = getToken();
    if (!t) {
      router.replace("/login");
      return;
    }
    setTokenState(t);
  }, [router]);

  async function load() {
    try {
      const cams: Camera[] = await api.listCameras();
      setCameras(cams);
      const map: Record<string, Alert[]> = {};
      await Promise.all(
        cams.map(async (c) => {
          const r = await api.listAlerts(c.id, 5);
          map[c.id] = r.alerts;
        }),
      );
      setAlertsByCam(map);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) load();
  }, [token]);

  // append a live alert to the owning camera's buffer
  useEffect(() => {
    if (!alertBump) return;
    setAlertsByCam((prev) => {
      const list = prev[alertBump.cameraId] ?? [];
      return {
        ...prev,
        [alertBump.cameraId]: [alertBump.alert, ...list].slice(0, 20),
      };
    });
  }, [alertBump]);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  if (loading)
    return (
      <main className="center">
        <p className="muted">Loading…</p>
      </main>
    );

  return (
    <main className="dash">
      <header className="topbar">
        <h1>Surveillance Dashboard</h1>
        <div className="top-actions">
          <span className={`ws ${connected ? "on" : "off"}`}>
            {connected ? "● live" : "○ offline"}
          </span>
          <button
            className="primary"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            + Add camera
          </button>
          <button onClick={logout}>Logout</button>
        </div>
      </header>

      {cameras.length === 0 ? (
        <p className="muted center-text">
          No cameras yet. Add one to get started.
        </p>
      ) : (
        <div className="grid">
          {cameras.map((c) => (
            <CameraTile
              key={c.id}
              camera={c}
              liveState={stateByCam[c.id]}
              stats={statsByCam[c.id]}
              alerts={alertsByCam[c.id] ?? []}
              onEdit={() => {
                setEditing(c);
                setShowForm(true);
              }}
              onDeleted={load}
            />
          ))}
        </div>
      )}

      {showForm && (
        <CameraForm
          camera={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}
    </main>
  );
}
