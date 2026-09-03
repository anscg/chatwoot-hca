// Thin wrapper over the two Chatwoot APIs this bridge needs:
//   * Platform API  (platform app token) — create users, mint SSO login links
//   * Application API (an administrator's access token) — look a user up by email
//
// Both are self-hosted-only surfaces; app.chatwoot.com does not expose the Platform API.

class ChatwootError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "ChatwootError";
    this.status = status;
    this.body = body;
  }
}

export { ChatwootError };

async function call(base, path, { token, method = "GET", body } = {}) {
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      api_access_token: token,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new ChatwootError(`Chatwoot ${method} ${path} failed (${res.status})`, res.status, parsed);
  }
  return parsed;
}

/** List every agent in the account. Requires an administrator access token. */
export async function listAgents(env) {
  return call(env.CHATWOOT_BASE_URL, `/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/agents`, {
    token: env.CHATWOOT_ADMIN_TOKEN,
  });
}

/** Find an existing agent by email (case-insensitive). Returns null when absent. */
export async function findAgentByEmail(env, email) {
  const wanted = email.trim().toLowerCase();
  const agents = await listAgents(env);
  return (agents || []).find((a) => (a.email || "").toLowerCase() === wanted) || null;
}

/** Chatwoot enforces upper/lower/number/special — generate something that always passes. */
function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const core = btoa(s).replace(/[^A-Za-z0-9]/g, "");
  return `Aa1!${core}`;
}

/**
 * Register an existing Chatwoot user with our Platform App.
 *
 * A Platform App may only touch users it created — PlatformController rejects anything
 * else with 401 "Non permissible resource" — so agents that predate this bridge cannot
 * be handed an SSO link until the app owns a permissible for them.
 *
 * POST /platform/api/v1/users is find-or-create by email: for an address that already
 * exists it returns that user and creates the permissible, and it does *not* apply the
 * submitted attributes to the existing record. So this adopts rather than overwrites,
 * and creates nobody who was not already there.
 */
export async function adoptExistingUser(env, { email, name }) {
  return createUser(env, { email, name });
}

/** Create a Chatwoot user via the Platform API. */
export async function createUser(env, { name, email }) {
  return call(env.CHATWOOT_BASE_URL, "/platform/api/v1/users", {
    token: env.CHATWOOT_PLATFORM_TOKEN,
    method: "POST",
    body: {
      name,
      display_name: name,
      email,
      password: randomPassword(),
      custom_attributes: { provisioned_by: "chatwoot-hca" },
    },
  });
}

/** Attach a user to the configured account with a role ("agent" or "administrator"). */
export async function addUserToAccount(env, userId, role) {
  return call(
    env.CHATWOOT_BASE_URL,
    `/platform/api/v1/accounts/${env.CHATWOOT_ACCOUNT_ID}/account_users`,
    {
      token: env.CHATWOOT_PLATFORM_TOKEN,
      method: "POST",
      body: { user_id: userId, role },
    },
  );
}

/**
 * Mint a single-use SSO login URL for a user.
 * GET /platform/api/v1/users/{id}/login -> { url: "https://…/app/login?email=…&sso_auth_token=…" }
 */
export async function ssoLoginUrl(env, userId) {
  const out = await call(env.CHATWOOT_BASE_URL, `/platform/api/v1/users/${userId}/login`, {
    token: env.CHATWOOT_PLATFORM_TOKEN,
  });
  if (!out || !out.url) throw new ChatwootError("Chatwoot returned no SSO url", 502, out);

  // Chatwoot builds this as "#{FRONTEND_URL}/app/login?...", so a FRONTEND_URL with a
  // trailing slash yields "//app/login". The frontend router does not match that path and
  // redirects to "/app/login", dropping the query string — and with it the sso_auth_token,
  // which lands you back on the login form. Resolving against CHATWOOT_BASE_URL also
  // covers a FRONTEND_URL that is unset entirely, which makes the url relative.
  const url = new URL(out.url, env.CHATWOOT_BASE_URL);
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");

  if (url.origin !== new URL(env.CHATWOOT_BASE_URL).origin) {
    console.warn(`chatwoot: sso link origin ${url.origin} differs from CHATWOOT_BASE_URL`);
  }
  // Shape only — never the token itself, which is a live credential for 5 minutes.
  console.log(
    `chatwoot: sso link origin=${url.origin} path=${url.pathname} ` +
      `email=${url.searchParams.get("email") || "MISSING"} ` +
      `token=${url.searchParams.get("sso_auth_token") ? "present" : "MISSING"}`,
  );
  return url.toString();
}

/**
 * Mint an SSO link, adopting the user into the Platform App first if Chatwoot says it
 * does not own them yet. The adoption is a no-op for anyone already registered.
 */
export async function ssoLoginUrlFor(env, { userId, email, name }) {
  try {
    return await ssoLoginUrl(env, userId);
  } catch (e) {
    const notPermissible =
      e instanceof ChatwootError && e.status === 401 && e.body?.error === "Non permissible resource";
    if (!notPermissible) throw e;

    console.log(`chatwoot: adopting existing user ${userId} into the platform app`);
    await adoptExistingUser(env, { email, name });
    return ssoLoginUrl(env, userId);
  }
}

/**
 * Resolve the identity coming out of Hack Club Auth to a Chatwoot user id,
 * provisioning a new agent when allowed.
 * Returns { userId, created }.
 */
export async function resolveUser(env, { email, name, autoProvision, role }) {
  const existing = await findAgentByEmail(env, email);
  if (existing) return { userId: existing.id, created: false };

  if (!autoProvision) {
    const err = new ChatwootError("No Chatwoot agent exists for this email", 403, null);
    err.code = "no_agent";
    throw err;
  }

  let user;
  try {
    user = await createUser(env, { name, email });
  } catch (e) {
    // The email may already belong to a user outside this account, or to one the
    // agents list does not surface — re-check before giving up.
    const again = await findAgentByEmail(env, email);
    if (again) return { userId: again.id, created: false };
    throw e;
  }

  try {
    await addUserToAccount(env, user.id, role);
  } catch (e) {
    // Already a member — that is the desired end state, not a failure.
    if (!(e instanceof ChatwootError && (e.status === 422 || e.status === 409))) throw e;
  }
  return { userId: user.id, created: true };
}
