const APP_URL_BY_CLIENT_ID = {
  // BarrioVibe InstaWorld apps
  "8d9753c41f2c0b5d3378ea265f9599ae": "https://instaworld.barriovibe.com",
  "f5529db1addcdd7a0713e2febfb30cdc": "https://instaworld.barriovibe.com",
  // Talwar InstaWorld apps
  "e2179673daf5a9508b3726c825f01519": "https://app.talwarstore.com",
  "b4995f699466e2aeed2761dbb8289e57": "https://app.talwarstore.com",
};

function tokenAudience(token) {
  const payloadSegment = token.split(".")[1];
  if (!payloadSegment) return [];

  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));
    return Array.isArray(payload.aud) ? payload.aud : [payload.aud].filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Routes each installed Shopify app to its own Vercel backend. The server still
 * validates the signed ID token; decoding the audience here is only for routing.
 */
export async function getApiClient() {
  const token = await shopify.auth.idToken();
  if (!token) {
    throw new Error("Unable to obtain an authentication token. Please reload the page.");
  }

  const clientId = tokenAudience(token).find((audience) => APP_URL_BY_CLIENT_ID[audience]);
  const appUrl = clientId ? APP_URL_BY_CLIENT_ID[clientId] : null;
  if (!appUrl) {
    throw new Error("This Shopify app is not linked to a configured InstaWorld backend.");
  }

  return {appUrl, authHeaders: {Authorization: `Bearer ${token}`}};
}
