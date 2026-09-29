/* GHL Marketplace OAuth: exchange the install code for a location token. */
export const GHL_TOKEN_URL = "https://services.leadconnectorhq.com/oauth/token";

export async function exchangeCode({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch, tokenUrl = GHL_TOKEN_URL }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    user_type: "Location",
  });
  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
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
