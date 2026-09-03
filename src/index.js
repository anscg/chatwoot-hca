// chatwoot-hca — Hack Club Auth (auth.hackclub.com) sign-in for self-hosted Chatwoot.
//
// Not SAML. This is an OIDC relying party that, after a successful Hack Club Auth
// login, mints a single-use Chatwoot SSO link via the Platform API and redirects
// the browser straight into Chatwoot.
//
//   /                 login screen
//   /auth/login       start the OIDC authorization code flow (PKCE)
//   /auth/callback    finish it, resolve the Chatwoot user, redirect into Chatwoot
//   /admin            allow-list dashboard (Hack Club Auth + ADMIN_EMAILS)
//   /healthz          liveness + config sanity

import {
  discover,
  exchangeCode,
  fetchUserinfo,
  openState,
  pkceChallenge,
  randomString,
  sealState,
  verifyIdToken,
} from "./oidc.js";
import { ChatwootError, resolveUser, ssoLoginUrlFor } from "./chatwoot.js";
import { errorPage, loginPage } from "./pages.js";
import { isAllowed, loadSettings, staticConfig } from "./settings.js";
import {
  adminCookie,
  clearAdminCookie,
  handleAdminGet,
  handleAdminPost,
  isAdminEmail,
  readCookie,
  startAdminSession,
} from "./admin.js";

const FLOW_COOKIE = "hca_flow";
const FLOW_TTL_SECONDS = 600;

const REQUIRED_VARS = [
  "HCA_CLIENT_ID",
  "HCA_CLIENT_SECRET",
  "SESSION_SECRET",
  "CHATWOOT_BASE_URL",
  "CHATWOOT_ACCOUNT_ID",
  "CHATWOOT_PLATFORM_TOKEN",
  "CHATWOOT_ADMIN_TOKEN",
];

// Applied to every response. The pages carry no inline event handlers and load only
// Google Fonts CSS + the Hack Club logo, so the CSP can stay tight.
const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src https://assets.hackclub.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

/** `cookies` is a list, since Set-Cookie must never be comma-folded into one header. */
function redirect(location, { cookies = [], ...headers } = {}) {
  const h = new Headers({ location, "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

function fail(env, { status = 400, heading, message, detail }) {
  const cfg = staticConfig(env);
  return html(errorPage({ brand: cfg.brand, heading, message, detail }), status, {
    "set-cookie": clearFlowCookie(),
  });
}

function flowCookie(value) {
  return `${FLOW_COOKIE}=${value}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_TTL_SECONDS}`;
}

function clearFlowCookie() {
  return `${FLOW_COOKIE}=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The redirect URI must be stable and must not be attacker-controlled. Set REDIRECT_URI
 * in production: without it we fall back to the request origin, which is derived from the
 * Host header and can be spoofed by anything sitting in front of the Worker.
 */
function redirectUri(request, env) {
  if (env.REDIRECT_URI) return env.REDIRECT_URI;
  return `${new URL(request.url).origin}/auth/callback`;
}

/** Reject requests arriving on a host we do not serve, so Host-header games go nowhere. */
function hostAllowed(request, env) {
  if (!env.REDIRECT_URI) return true;
  try {
    return new URL(request.url).host === new URL(env.REDIRECT_URI).host;
  } catch {
    return true;
  }
}

function missingVars(env) {
  return REQUIRED_VARS.filter((k) => !env[k]);
}

async function startFlow(request, env, mode) {
  const cfg = staticConfig(env);
  const doc = await discover(cfg.issuer);

  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);

  const sealed = await sealState(
    { state, nonce, verifier, mode, exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS },
    env.SESSION_SECRET,
  );

  const authorize = new URL(doc.authorization_endpoint);
  authorize.searchParams.set("client_id", env.HCA_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri(request, env));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", cfg.scope);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");

  return redirect(authorize.toString(), { cookies: [flowCookie(sealed)] });
}

/** Exchange the code and return a verified identity, or throw. */
async function identify(request, env, flow, code) {
  const cfg = staticConfig(env);
  const doc = await discover(cfg.issuer);

  const tokens = await exchangeCode({
    tokenEndpoint: doc.token_endpoint,
    code,
    redirectUri: redirectUri(request, env),
    clientId: env.HCA_CLIENT_ID,
    clientSecret: env.HCA_CLIENT_SECRET,
    codeVerifier: flow.verifier,
  });

  // An id_token is the only part of the response that is cryptographically bound to
  // this client and this request's nonce, so treat its absence as a hard failure.
  if (!tokens.id_token) throw new Error("Hack Club Auth returned no id_token");

  const claims = await verifyIdToken(tokens.id_token, {
    issuer: doc.issuer,
    audience: env.HCA_CLIENT_ID,
    nonce: flow.nonce,
    jwksUri: doc.jwks_uri,
  });

  let profile = claims;
  if (tokens.access_token) {
    const info = await fetchUserinfo(doc.userinfo_endpoint, tokens.access_token);
    // OIDC core 5.3.2: the userinfo subject must match the id_token subject.
    if (info.sub && claims.sub && String(info.sub) !== String(claims.sub)) {
      throw new Error("userinfo subject does not match id_token subject");
    }
    profile = { ...claims, ...info };
  }
  return profile;
}

async function handleCallback(request, env) {
  const cfg = staticConfig(env);
  const url = new URL(request.url);

  if (url.searchParams.get("error")) {
    return fail(env, {
      status: 400,
      heading: "Sign-in cancelled",
      message: "Hack Club Auth did not complete the sign-in.",
      detail: (url.searchParams.get("error_description") || url.searchParams.get("error") || "").slice(0, 200),
    });
  }

  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) {
    return fail(env, {
      status: 400,
      heading: "Bad callback",
      message: "That link is missing its authorization code. Start the sign-in again.",
    });
  }

  const flow = await openState(readCookie(request, FLOW_COOKIE), env.SESSION_SECRET);
  if (!flow || flow.state !== returnedState) {
    return fail(env, {
      status: 400,
      heading: "Sign-in expired",
      message: "This sign-in attempt expired or was started in another browser. Try again.",
    });
  }

  const profile = await identify(request, env, flow, code);

  const email = String(profile.email || "").trim().toLowerCase();
  if (!email) {
    return fail(env, {
      status: 403,
      heading: "No email on file",
      message: "Hack Club Auth did not return an email address for this account.",
    });
  }

  const settings = await loadSettings(env);

  // An unverified address would defeat the domain allow-list outright, so when the
  // check is on the claim must be present and true — missing is not good enough.
  if (settings.requireVerifiedEmail && profile.email_verified !== true) {
    const absent = profile.email_verified === undefined;
    console.warn(`auth: rejected ${email} (email_verified ${absent ? "absent" : "false"})`);
    return fail(env, {
      status: 403,
      heading: "Email not verified",
      message: absent
        ? "Hack Club Auth did not send an email_verified claim for this account. If it never does, turn off \u201cRequire a verified email\u201d at /admin."
        : "Verify your email address with Hack Club Auth, then sign in again.",
      detail: email,
    });
  }

  // --- admin dashboard sign-in ---
  if (flow.mode === "admin") {
    if (!isAdminEmail(env, email)) {
      console.warn(`admin: rejected dashboard sign-in for ${email}`);
      return fail(env, {
        status: 403,
        heading: "Not an admin",
        message: "This account is not listed in ADMIN_EMAILS.",
        detail: email,
      });
    }
    const { token } = await startAdminSession(env, email);
    console.log(`admin: dashboard sign-in by ${email}`);
    return redirect("/admin", { cookies: [clearFlowCookie(), adminCookie(token)] });
  }

  // --- Chatwoot sign-in ---
  if (!isAllowed(settings, email)) {
    console.warn(`auth: rejected sign-in for ${email} (not in allow-list)`);
    return fail(env, {
      status: 403,
      heading: "Not on the list",
      message: `${cfg.brand} is limited to approved Hack Club accounts. Ask an admin to add you.`,
      detail: email,
    });
  }

  const name =
    profile.name ||
    [profile.given_name, profile.family_name].filter(Boolean).join(" ") ||
    profile.nickname ||
    email.split("@")[0];

  let userId;
  let created;
  try {
    ({ userId, created } = await resolveUser(env, {
      email,
      name,
      autoProvision: settings.autoProvision,
      role: settings.role,
    }));
  } catch (e) {
    if (e instanceof ChatwootError && e.code === "no_agent") {
      return fail(env, {
        status: 403,
        heading: "No Chatwoot account",
        message: `There is no ${cfg.brand} agent for this email, and automatic provisioning is off.`,
        detail: email,
      });
    }
    throw e;
  }

  console.log(`auth: ${created ? "provisioned" : "signed in"} ${email} as user ${userId}`);
  const target = await ssoLoginUrlFor(env, { userId, email, name });
  return redirect(target, { cookies: [clearFlowCookie()] });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = staticConfig(env);

    if (url.pathname === "/healthz") {
      const missing = missingVars(env);
      return Response.json(
        {
          ok: missing.length === 0,
          missing,
          issuer: cfg.issuer,
          redirect_uri: redirectUri(request, env),
          redirect_uri_pinned: Boolean(env.REDIRECT_URI),
          config_store: Boolean(env.CONFIG),
          admins: cfg.adminEmails.length,
        },
        { status: missing.length === 0 ? 200 : 500, headers: { "cache-control": "no-store", ...SECURITY_HEADERS } },
      );
    }

    if (!hostAllowed(request, env)) {
      return fail(env, {
        status: 421,
        heading: "Wrong host",
        message: "This deployment does not serve that hostname.",
      });
    }

    const missing = missingVars(env);
    if (missing.length) {
      return fail(env, {
        status: 500,
        heading: "Not configured",
        message: "This deployment is missing required configuration.",
        detail: `Missing: ${missing.join(", ")}`,
      });
    }

    try {
      if (url.pathname === "/" || url.pathname === "/login") {
        return html(loginPage({ brand: cfg.brand, blurb: cfg.blurb, loginPath: "/auth/login" }));
      }
      if (url.pathname === "/auth/login") return await startFlow(request, env, "app");
      if (url.pathname === "/auth/callback") return await handleCallback(request, env);

      if (url.pathname === "/admin") {
        if (request.method === "POST") return await handleAdminPost(request, env, { html });
        if (request.method === "GET") return await handleAdminGet(request, env, { html, redirect });
        return html("Method not allowed", 405, { allow: "GET, POST" });
      }
      if (url.pathname === "/admin/login") {
        if (!cfg.adminEmails.length) {
          return fail(env, {
            status: 503,
            heading: "Admin disabled",
            message: "No ADMIN_EMAILS are configured, so the dashboard is switched off.",
          });
        }
        return await startFlow(request, env, "admin");
      }
      if (url.pathname === "/admin/logout") {
        return redirect("/", { cookies: [clearAdminCookie()] });
      }

      return fail(env, {
        status: 404,
        heading: "Not found",
        message: "There is nothing at this address.",
      });
    } catch (e) {
      // Internal failures can carry Chatwoot API bodies and upstream URLs — those go to
      // the log, never to the browser. The reference is the join between the two.
      const ref = randomString(6);
      const upstream = e instanceof ChatwootError ? ` body=${JSON.stringify(e.body ?? null)}` : "";
      console.error(`chatwoot-hca [${ref}]:`, e && e.stack ? e.stack : e, upstream);

      // A misconfigured platform token is worth naming — it is the one failure an admin
      // can fix in a minute, and the generic message sends them hunting through logs.
      if (e instanceof ChatwootError && e.status === 401 && e.body?.error === "Invalid access_token") {
        return fail(env, {
          status: 500,
          heading: "Chatwoot rejected the token",
          message:
            "CHATWOOT_PLATFORM_TOKEN is not a Platform App token. Create one under /super_admin → Platform Apps and set it again.",
          detail: `Reference ${ref}`,
        });
      }
      return fail(env, {
        status: 500,
        heading: "Sign-in failed",
        message: "Something went wrong finishing the sign-in. Try again, or ping an admin.",
        detail: `Reference ${ref}`,
      });
    }
  },
};
