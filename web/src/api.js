export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

export function createApi(getToken) {
  async function request(method, path, body) {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new ApiError(res.status, data?.error ?? "INTERNAL_ERROR");
    return data;
  }
  return {
    get: (p) => request("GET", p),
    post: (p, b) => request("POST", p, b),
    put: (p, b) => request("PUT", p, b),
    patch: (p, b) => request("PATCH", p, b),
    rawUrl: (p) => p, // same-origin; used for CSV download links
  };
}
