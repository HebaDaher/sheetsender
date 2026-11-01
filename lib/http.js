// Provider HTTP helper with error classification used for safe retries.
export class ProviderError extends Error {
  constructor(message, { kind = 'permanent', status = 0, code = null, provider = '' } = {}) {
    super(message);
    this.kind = kind;       // auth | transient | permanent | rate_limit
    this.status = status;
    this.code = code;
    this.provider = provider;
  }
}

export async function request(provider, url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 60000) });
  } catch (e) {
    throw new ProviderError(`${provider}: network error (${e.cause?.code || e.name || e.message})`, { kind: 'transient', provider });
  }
  if (opts.raw) {
    if (!res.ok) await throwFor(provider, res);
    return res;
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { text }; }
  if (!res.ok) await throwFor(provider, res, body);
  return body;
}

async function throwFor(provider, res, body) {
  if (body === undefined) { try { body = JSON.parse(await res.text()); } catch { body = null; } }
  const err = body?.error;
  const msg = (typeof err === 'object' ? (err.message || err.error_user_msg) : err) || body?.error_description || body?.text || res.statusText;
  const code = typeof err === 'object' ? err.code : null;
  let kind = 'permanent';
  if (res.status === 401) kind = 'auth';
  else if (res.status === 429) kind = 'rate_limit';
  else if (res.status >= 500 || res.status === 408 || res.status === 409 || res.status === 423 || res.status === 412) kind = 'transient';
  if (body?.error === 'invalid_grant') kind = 'auth';
  throw new ProviderError(`${provider}: ${String(msg).slice(0, 300)} (HTTP ${res.status}${code ? `, code ${code}` : ''})`, { kind, status: res.status, code, provider });
}
