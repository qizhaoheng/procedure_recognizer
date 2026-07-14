const base = '/api/agent';
export async function agentRequest<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init); const text = await response.text();
  if (!text.trim()) { if (response.ok) return undefined as T; throw new Error(`自主识别 API 返回空响应（HTTP ${response.status}）。`); }
  let payload: any; try { payload = JSON.parse(text); } catch { throw new Error(`自主识别 API 返回非 JSON 响应（HTTP ${response.status}）：${text.slice(0, 160)}`); }
  if (!response.ok) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）。`); return payload as T;
}
export function uploadForm(files: File[], fields: Record<string, string> = {}) { const form = new FormData(); files.forEach((file) => form.append('files', file)); Object.entries(fields).forEach(([key, value]) => form.append(key, value)); return form; }
