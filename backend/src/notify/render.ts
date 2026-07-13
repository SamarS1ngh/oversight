type Alert = {
  id: string; severity?: string; label?: string | null; rule_id?: string | null;
  camera_id: string; ts: string; count: number; confidence: number;
};
const NTFY_PRIORITY: Record<string, number> = { low: 2, medium: 3, high: 5 };

export function renderAlert(
  type: string,
  alert: Alert,
  cameraName: string,
  ruleName: string | null,
  link: string,
): Record<string, unknown> {
  const sev = alert.severity ?? "low";
  const label = alert.label ?? "detection";
  const rule = ruleName ?? "detection";
  if (type === "webhook") {
    return {
      event: "alert",
      alert: {
        id: alert.id, severity: sev, label: alert.label ?? null,
        ruleId: alert.rule_id ?? null, cameraId: alert.camera_id,
        ts: alert.ts, count: alert.count, confidence: alert.confidence,
      },
      camera: { id: alert.camera_id, name: cameraName },
      rule: alert.rule_id ? { id: alert.rule_id, name: ruleName } : null,
      url: link,
    };
  }
  if (type === "ntfy") {
    return {
      title: `${cameraName}: ${sev} ${label}`,
      body: `${rule} · ${alert.count}`,
      priority: NTFY_PRIORITY[sev] ?? 3,
      tags: [sev],
      click: link,
    };
  }
  // telegram
  const time = new Date(alert.ts).toLocaleString();
  return {
    text: `*${sev}* ${label} on *${cameraName}*\n${rule} · ${alert.count} · ${time}\n${link}`,
    parse_mode: "Markdown",
  };
}
