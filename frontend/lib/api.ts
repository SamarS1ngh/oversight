"use client";
import { API_URL } from "./config";

const TOKEN_KEY = "vms_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function req(path: string, opts: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((opts.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? "request failed");
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  signup: (username: string, password: string) =>
    req("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    req("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  listCameras: () => req("/cameras"),
  createCamera: (body: Record<string, unknown>) =>
    req("/cameras", { method: "POST", body: JSON.stringify(body) }),
  updateCamera: (id: string, body: Record<string, unknown>) =>
    req(`/cameras/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCamera: (id: string) => req(`/cameras/${id}`, { method: "DELETE" }),
  startCamera: (id: string) => req(`/cameras/${id}/start`, { method: "POST" }),
  stopCamera: (id: string) => req(`/cameras/${id}/stop`, { method: "POST" }),

  listAlerts: (cameraId?: string, limit = 20) =>
    req(`/alerts?${cameraId ? `camera_id=${cameraId}&` : ""}limit=${limit}`),

  listClips: (cameraId?: string, limit = 50) =>
    req(`/clips?${cameraId ? `camera_id=${cameraId}&` : ""}limit=${limit}`),
  deleteClip: (id: string) => req(`/clips/${id}`, { method: "DELETE" }),

  webrtcOffer: (id: string, sdp: string) =>
    req(`/cameras/${id}/webrtc`, {
      method: "POST",
      body: JSON.stringify({ sdp, type: "offer" }),
    }),
};

export function clipVideoUrl(id: string) {
  return `${API_URL}/clips/${id}/video?token=${getToken() ?? ""}`;
}
export function clipThumbUrl(id: string) {
  return `${API_URL}/clips/${id}/thumb?token=${getToken() ?? ""}`;
}
