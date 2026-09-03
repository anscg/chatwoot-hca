// Minimal OpenID Connect relying-party helpers for Hack Club Auth (auth.hackclub.com).
// No SAML, no dependencies — authorization code flow + PKCE, verified with WebCrypto.

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomString(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(input) {
  return crypto.subtle.digest("SHA-256", typeof input === "string" ? enc.encode(input) : input);
}

export async function pkceChallenge(verifier) {
  return b64url(await sha256(verifier));
}

// --- discovery ------------------------------------------------------------

let discoveryCache = null;

export async function discover(issuer) {
  const now = Date.now();
  if (discoveryCache && discoveryCache.issuer === issuer && discoveryCache.expires > now) {
    return discoveryCache.doc;
  }
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = await res.json();
  discoveryCache = { issuer, doc, expires: now + 60 * 60 * 1000 };
  return doc;
}

// --- id_token verification ------------------------------------------------

let jwksCache = null;

async function getKey(jwksUri, kid) {
  const now = Date.now();
  if (!jwksCache || jwksCache.uri !== jwksUri || jwksCache.expires < now || !jwksCache.keys[kid]) {
    const res = await fetch(jwksUri);
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    const { keys } = await res.json();
    const imported = {};
    for (const jwk of keys) {
      if (jwk.kty !== "RSA") continue;
      imported[jwk.kid] = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }
    jwksCache = { uri: jwksUri, keys: imported, expires: now + 60 * 60 * 1000 };
  }
  const key = jwksCache.keys[kid];
  if (!key) throw new Error(`Unknown signing key: ${kid}`);
  return key;
}

export async function verifyIdToken(idToken, { issuer, audience, nonce, jwksUri }) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(rawHeader)));
  if (header.alg !== "RS256") throw new Error(`Unsupported id_token alg: ${header.alg}`);

  const key = await getKey(jwksUri, header.kid);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlDecode(rawSig),
    enc.encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw new Error("id_token signature is invalid");

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(rawPayload)));
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];

  if (claims.iss !== issuer) throw new Error("id_token issuer mismatch");
  if (!aud.includes(audience)) throw new Error("id_token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp + 60 < now) throw new Error("id_token is expired");
  if (typeof claims.iat === "number" && claims.iat - 60 > now) throw new Error("id_token issued in the future");
  if (nonce && claims.nonce !== nonce) throw new Error("id_token nonce mismatch");

  return claims;
}

// --- token exchange -------------------------------------------------------

export async function exchangeCode({ tokenEndpoint, code, redirectUri, clientId, clientSecret, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function fetchUserinfo(userinfoEndpoint, accessToken) {
  const res = await fetch(userinfoEndpoint, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Userinfo failed (${res.status})`);
  return res.json();
}

// --- signed state cookie --------------------------------------------------

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function sealState(payload, secret) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

export async function openState(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    b64urlDecode(sig),
    enc.encode(body),
  );
  if (!ok) return null;
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
