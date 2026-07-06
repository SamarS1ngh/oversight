"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken, clipThumbUrl } from "@/lib/api";
import { ClipPlayer } from "@/components/ClipPlayer";
import type { Camera, Clip } from "@/lib/types";

export default function EventsPage() {
  const router = useRouter();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [clips, setClips] = useState<Clip[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api.listCameras().then(setCameras).catch(() => {});
  }, [router]);

  useEffect(() => {
    setLoading(true);
    api
      .listClips(filter || undefined, 100)
      .then((r) => setClips(r.clips))
      .catch(() => setClips([]))
      .finally(() => setLoading(false));
  }, [filter]);

  const nameOf = (id: string) => cameras.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <main className="dash">
      <header className="topbar">
        <h1>Recordings</h1>
        <div className="top-actions">
          <a href="/dashboard" className="btn">
            ← Dashboard
          </a>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All cameras</option>
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {loading ? (
        <p className="muted center-text">Loading…</p>
      ) : clips.length === 0 ? (
        <p className="muted center-text">No recordings yet.</p>
      ) : (
        <div className="grid">
          {clips.map((clip) => (
            <button key={clip.id} className="clip-card" onClick={() => setPlaying(clip.id)}>
              {clip.thumbPath ? (
                <img src={clipThumbUrl(clip.id)} alt="" className="clip-thumb" />
              ) : (
                <div className="clip-thumb placeholder" />
              )}
              <div className="clip-meta">
                <strong>{nameOf(clip.cameraId)}</strong>
                <span className="time">{new Date(clip.startTs).toLocaleString()}</span>
                <span className="muted small">{Math.round(clip.durationMs / 1000)}s</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {playing && <ClipPlayer clipId={playing} onClose={() => setPlaying(null)} />}
    </main>
  );
}
