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

  listAlerts: (
    params: { cameraId?: string; severity?: string; status?: string; limit?: number } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.cameraId) q.set("camera_id", params.cameraId);
    if (params.severity) q.set("severity", params.severity);
    if (params.status) q.set("status", params.status);
    q.set("limit", String(params.limit ?? 20));
    return req(`/alerts?${q.toString()}`);
  },
  ackAlert: (id: string) => req(`/alerts/${id}/ack`, { method: "POST" }),
  resolveAlert: (id: string) => req(`/alerts/${id}/resolve`, { method: "POST" }),

  listZones: (cameraId: string) => req(`/cameras/${cameraId}/zones`),
  createZone: (cameraId: string, body: Record<string, unknown>) =>
    req(`/cameras/${cameraId}/zones`, { method: "POST", body: JSON.stringify(body) }),
  deleteZone: (cameraId: string, zoneId: string) =>
    req(`/cameras/${cameraId}/zones/${zoneId}`, { method: "DELETE" }),

  listRules: (cameraId: string) => req(`/cameras/${cameraId}/rules`),
  createRule: (cameraId: string, body: Record<string, unknown>) =>
    req(`/cameras/${cameraId}/rules`, { method: "POST", body: JSON.stringify(body) }),
  updateRule: (cameraId: string, ruleId: string, body: Record<string, unknown>) =>
    req(`/cameras/${cameraId}/rules/${ruleId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRule: (cameraId: string, ruleId: string) =>
    req(`/cameras/${cameraId}/rules/${ruleId}`, { method: "DELETE" }),

  listClips: (cameraId?: string, limit = 50) =>
    req(`/clips?${cameraId ? `camera_id=${cameraId}&` : ""}limit=${limit}`),
  deleteClip: (id: string) => req(`/clips/${id}`, { method: "DELETE" }),

  webrtcOffer: (id: string, sdp: string) =>
    req(`/cameras/${id}/webrtc`, {
      method: "POST",
      body: JSON.stringify({ sdp, type: "offer" }),
    }),

  listChannels: () => req("/notifications"),
  createChannel: (body: Record<string, unknown>) =>
    req("/notifications", { method: "POST", body: JSON.stringify(body) }),
  updateChannel: (id: string, body: Record<string, unknown>) =>
    req(`/notifications/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteChannel: (id: string) => req(`/notifications/${id}`, { method: "DELETE" }),
  testChannel: (id: string) => req(`/notifications/${id}/test`, { method: "POST" }),
};

export function clipVideoUrl(id: string) {
  return `${API_URL}/clips/${id}/video?token=${getToken() ?? ""}`;
}
export function clipThumbUrl(id: string) {
  return `${API_URL}/clips/${id}/thumb?token=${getToken() ?? ""}`;
}
