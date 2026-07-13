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
