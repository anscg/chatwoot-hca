// Effective configuration = defaults from wrangler vars, overridden by whatever an
// admin has saved in KV. Env vars stay the fallback so a fresh deploy works before
// anyone opens the dashboard, and so KV loss cannot silently open the door.

export const SETTINGS_KEY = "settings";

export function parseList(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Static, env-only config — never editable from the dashboard. */
export function staticConfig(env) {
  return {
    issuer: (env.HCA_ISSUER || "https://auth.hackclub.com").replace(/\/$/, ""),
    scope: env.HCA_SCOPE || "openid profile",
    brand: env.BRAND_NAME || "Chatwoot",
    blurb: env.BRAND_BLURB || "Sign in with your Hack Club account.",
    // Dashboard access lives in env on purpose: an admin cannot lock themselves
    // (or everyone else) out by editing the allow-list in the UI.
    adminEmails: parseList(env.ADMIN_EMAILS),
  };
}

function defaults(env) {
  return {
    allowedDomains: parseList(env.ALLOWED_EMAIL_DOMAINS),
    allowedEmails: parseList(env.ALLOWED_EMAILS),
    autoProvision: String(env.AUTO_PROVISION ?? "true") !== "false",
    requireVerifiedEmail: String(env.REQUIRE_VERIFIED_EMAIL ?? "true") !== "false",
    role: env.DEFAULT_ROLE === "administrator" ? "administrator" : "agent",
    updatedAt: null,
    updatedBy: null,
  };
}

/** Coerce anything read from KV into a known-good shape — never trust stored JSON. */
function sanitize(raw, base) {
  if (!raw || typeof raw !== "object") return base;
  return {
    allowedDomains: Array.isArray(raw.allowedDomains) ? parseList(raw.allowedDomains.join(",")) : base.allowedDomains,
    allowedEmails: Array.isArray(raw.allowedEmails) ? parseList(raw.allowedEmails.join(",")) : base.allowedEmails,
    autoProvision: typeof raw.autoProvision === "boolean" ? raw.autoProvision : base.autoProvision,
    requireVerifiedEmail:
      typeof raw.requireVerifiedEmail === "boolean" ? raw.requireVerifiedEmail : base.requireVerifiedEmail,
    role: raw.role === "administrator" ? "administrator" : "agent",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy.slice(0, 200) : null,
  };
}

export function hasStore(env) {
  return Boolean(env.CONFIG && typeof env.CONFIG.get === "function");
}

export async function loadSettings(env) {
  const base = defaults(env);
  if (!hasStore(env)) return { ...base, stored: false };
  let raw = null;
  try {
    raw = await env.CONFIG.get(SETTINGS_KEY, "json");
  } catch (e) {
    console.error("settings: KV read failed, falling back to env defaults", e);
    return { ...base, stored: false };
  }
  if (!raw) return { ...base, stored: false };
  return { ...sanitize(raw, base), stored: true };
}

export async function saveSettings(env, next, actor) {
  if (!hasStore(env)) throw new Error("No CONFIG KV namespace is bound to this Worker");
  const record = {
    ...sanitize(next, defaults(env)),
    updatedAt: new Date().toISOString(),
    updatedBy: actor || null,
  };
  await env.CONFIG.put(SETTINGS_KEY, JSON.stringify(record));
  return record;
}

/**
 * Is this identity allowed to sign in?
 * An empty allow-list means "any Hack Club account", which is deliberately loud in the UI.
 */
export function isAllowed(settings, email) {
  const addr = String(email || "").trim().toLowerCase();
  if (!addr.includes("@")) return false;
  if (settings.allowedEmails.includes(addr)) return true;
  // Take the last @-segment: "a@b@hackclub.com" must not read as domain "b".
  const domain = addr.slice(addr.lastIndexOf("@") + 1);
  if (settings.allowedDomains.includes(domain)) return true;
  return settings.allowedEmails.length === 0 && settings.allowedDomains.length === 0;
}
