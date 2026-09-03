// Admin dashboard: edit the sign-in allow-list without redeploying.
//
// Access is gated twice — you must complete a Hack Club Auth sign-in *and* your email
// must appear in the env-only ADMIN_EMAILS list. That list is deliberately not editable
// here, so nobody can lock everyone (including themselves) out from the UI.

import { openState, randomString, sealState } from "./oidc.js";
import { adminLoginPage, adminPage } from "./pages.js";
import { hasStore, loadSettings, parseList, saveSettings, staticConfig } from "./settings.js";

export const ADMIN_COOKIE = "hca_admin";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function adminCookie(value, maxAge = SESSION_TTL_SECONDS) {
  return `${ADMIN_COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearAdminCookie() {
  return adminCookie("", 0);
}

export function readCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Constant-time string compare, so a CSRF token cannot be guessed byte by byte. */
function timingSafeEqual(a, b) {
  const x = String(a || "");
  const y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function startAdminSession(env, email) {
  const csrf = randomString(24);
  const token = await sealState(
    { kind: "admin", email, csrf, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
    env.SESSION_SECRET,
  );
  return { token, csrf };
}

/**
 * Returns the live admin session, or null. Re-checks ADMIN_EMAILS on every request so
 * removing someone from the env var revokes their open session immediately.
 */
export async function currentAdmin(request, env) {
  const session = await openState(readCookie(request, ADMIN_COOKIE), env.SESSION_SECRET);
  if (!session || session.kind !== "admin" || !session.email) return null;
  const { adminEmails } = staticConfig(env);
  if (!adminEmails.includes(String(session.email).toLowerCase())) return null;
  return session;
}

export function isAdminEmail(env, email) {
  const { adminEmails } = staticConfig(env);
  return adminEmails.includes(String(email || "").toLowerCase());
}

async function render(env, session, flash = null) {
  const cfg = staticConfig(env);
  const settings = await loadSettings(env);
  return adminPage({
    brand: cfg.brand,
    email: session.email,
    settings,
    csrf: session.csrf,
    flash,
    readOnly: !hasStore(env),
    adminEmails: cfg.adminEmails,
  });
}

export async function handleAdminGet(request, env, { html, redirect }) {
  const session = await currentAdmin(request, env);
  if (!session) {
    const cfg = staticConfig(env);
    if (!cfg.adminEmails.length) {
      return html(
        adminLoginPage({ brand: cfg.brand }),
        503,
        { "set-cookie": clearAdminCookie() },
      );
    }
    return html(adminLoginPage({ brand: cfg.brand }), 401, { "set-cookie": clearAdminCookie() });
  }
  const url = new URL(request.url);
  const saved = url.searchParams.get("saved");
  return html(
    await render(env, session, saved ? { kind: "ok", message: "Saved. New sign-ins use these rules." } : null),
    200,
  );
}

export async function handleAdminPost(request, env, { html }) {
  const session = await currentAdmin(request, env);
  if (!session) {
    const cfg = staticConfig(env);
    return html(adminLoginPage({ brand: cfg.brand }), 401, { "set-cookie": clearAdminCookie() });
  }

  // Defence in depth on top of SameSite=Lax: the form token must match the session's.
  const form = await request.formData();
  if (!timingSafeEqual(form.get("csrf"), session.csrf)) {
    return html(await render(env, session, { kind: "error", message: "Session expired — try again." }), 403);
  }

  if (!hasStore(env)) {
    return html(
      await render(env, session, { kind: "error", message: "No CONFIG KV namespace is bound; nothing was saved." }),
      500,
    );
  }

  const domains = parseList(form.get("domains"));
  const emails = parseList(form.get("emails"));
  const bad = emails.find((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (bad) {
    return html(await render(env, session, { kind: "error", message: `Not an email address: ${bad}` }), 400);
  }
  const badDomain = domains.find((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  if (badDomain) {
    return html(await render(env, session, { kind: "error", message: `Not a domain: ${badDomain}` }), 400);
  }

  await saveSettings(
    env,
    {
      allowedDomains: domains,
      allowedEmails: emails,
      autoProvision: form.get("autoProvision") === "on",
      requireVerifiedEmail: form.get("requireVerifiedEmail") === "on",
      role: form.get("role") === "administrator" ? "administrator" : "agent",
    },
    session.email,
  );

  console.log(`admin: settings updated by ${session.email}`);
  return new Response(null, {
    status: 303,
    headers: { location: "/admin?saved=1", "cache-control": "no-store" },
  });
}
