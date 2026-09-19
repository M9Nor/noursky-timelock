// Mirrors PROJECT.md §10 SSO handshake. Field/message names must be verified
// against a real GHL sub-account (PROJECT.md §17) before production.
export function getGhlSso(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      reject(new Error("SSO_TIMEOUT"));
    }, timeoutMs);
    function handler({ data }) {
      if (data?.message === "REQUEST_USER_DATA_RESPONSE") {
        clearTimeout(timer);
        window.removeEventListener("message", handler);
        resolve(data.payload);
      }
    }
    window.addEventListener("message", handler);
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
  });
}

export async function ssoLogin(api) {
  const encryptedData = await getGhlSso();
  return api.post("/auth/sso", { encryptedData }); // { token, user }
}

export async function devLogin(api, role) {
  return api.post("/auth/dev-login", { role }); // { token, user }
}
