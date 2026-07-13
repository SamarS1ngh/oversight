export type OutReq = { url: string; method: string; headers: Record<string, string>; body: string };

export function buildRequest(type: string, config: any, payload: any): OutReq {
  if (type === "webhook") {
    return {
      url: config.url,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
  }
  if (type === "ntfy") {
    const server = (config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Title: String(payload.title),
      Priority: String(payload.priority),
      Tags: (payload.tags ?? []).join(","),
      Click: String(payload.click),
    };
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
    return { url: `${server}/${config.topic}`, method: "POST", headers, body: String(payload.body) };
  }
  if (type === "pushover") {
    const body = new URLSearchParams({
      token: config.token, user: config.user,
      title: String(payload.title), message: String(payload.message),
      priority: String(payload.priority), url: String(payload.url),
    });
    return { url: "https://api.pushover.net/1/messages.json", method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() };
  }
  // telegram
  return {
    url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, ...payload }),
  };
}

// Thin real sender — not unit-tested (exercised by the routes capture test + e2e).
// 5s timeout so a hung endpoint can't stall the dispatch loop's sibling
// channels or leak a never-settling fetch under continuous detections.
export async function send(req: OutReq): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status };
}

// Snapshot-aware sender: uploads the JPEG bytes for ntfy/telegram/pushover
// (their APIs accept an attachment alongside the text fields); webhook and
// any snapshot-less send fall back to the existing buildRequest+send text
// path unchanged (M3a behavior). Same 5s timeout everywhere.
export async function sendChannel(
  type: string,
  config: any,
  payload: any,
  snapshot?: { bytes: Uint8Array; url: string } | null,
): Promise<{ ok: boolean; status: number }> {
  if (snapshot && type === "ntfy") {
    const server = (config.server ?? "https://ntfy.sh").replace(/\/$/, "");
    const headers: Record<string, string> = {
      Title: String(payload.title),
      Message: String(payload.body),
      Priority: String(payload.priority),
      Tags: (payload.tags ?? []).join(","),
      Click: String(payload.click),
      Filename: "snapshot.jpg",
    };
    if (config.token) headers["Authorization"] = `Bearer ${config.token}`;
    const res = await fetch(`${server}/${config.topic}`, {
      method: "POST", headers, body: snapshot.bytes, signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  }
  if (snapshot && type === "telegram") {
    const fd = new FormData();
    fd.set("chat_id", config.chatId);
    fd.set("caption", String(payload.text));
    fd.set("parse_mode", "Markdown");
    fd.set("photo", new Blob([snapshot.bytes], { type: "image/jpeg" }), "snapshot.jpg");
    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendPhoto`, {
      method: "POST", body: fd, signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  }
  if (snapshot && type === "pushover") {
    const fd = new FormData();
    for (const [k, v] of new URLSearchParams(buildRequest("pushover", config, payload).body)) fd.set(k, v);
    fd.set("attachment", new Blob([snapshot.bytes], { type: "image/jpeg" }), "snapshot.jpg");
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST", body: fd, signal: AbortSignal.timeout(5000),
    });
    return { ok: res.ok, status: res.status };
  }
  return send(buildRequest(type, config, payload));
}
