/* GHL Marketplace OAuth: exchange the install code for a location token. */
export const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

const EXCHANGE_TIMEOUT_MS = 10000;

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch, tokenUrl = GHL_TOKEN_URL }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Location",
  });
  let res;
  try {
    res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (cause) {
    // Network failure or timeout: GHL was not reached (distinct from GHL refusing the code).
    const err = new Error("OAUTH_UNREACHABLE");
    err.cause = cause;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok || !data?.access_token || !data?.locationId) {
    const err = new Error("OAUTH_EXCHANGE_FAILED");
    err.status = res.status;
    throw err;
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: Number(data.expires_in) || 0,
    scopes: data.scope ?? "",
    locationId: data.locationId,
    companyId: data.companyId ?? null,
  };
}
