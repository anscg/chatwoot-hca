# chatwoot-hca

Hack Club Auth (`auth.hackclub.com`) sign-in for **self-hosted Chatwoot** — no SAML, no
enterprise licence.

Chatwoot's SAML support is an enterprise feature, so this takes the other route: a small
Cloudflare Worker acts as an OpenID Connect relying party for Hack Club Auth, and once you
have signed in there it mints a **single-use Chatwoot SSO link** through the Platform API and
drops you straight into the dashboard.

```
browser ──▶ chatwoot-hca /auth/login
              └─▶ auth.hackclub.com  (OIDC authorization code + PKCE)
        ◀── /auth/callback
              ├─ verify id_token (RS256, JWKS, nonce, aud, exp)
              ├─ check the allow-list
              ├─ find or create the Chatwoot agent for that email
              └─ GET /platform/api/v1/users/{id}/login → 302 into Chatwoot
```

There is also an **admin dashboard at `/admin`** for editing the allow-list without a
redeploy, and a script (`public/hca-login.js`) that puts the Hack Club button on **Chatwoot's
own login page**, so nobody has to be told the Worker's URL.

## What you need on the Chatwoot side

Both of these exist in the free self-hosted build.

1. **A Platform App.** Sign in as a super admin, go to `https://<your-chatwoot>/super_admin`
   → **Platform Apps** → create one. Copy its access token → `CHATWOOT_PLATFORM_TOKEN`.
   This mints the SSO links and creates users. (The Platform API is self-hosted only — it
   does not exist on app.chatwoot.com.)
2. **An administrator access token.** Log in as an admin of the account you want people to
   land in, then **Profile Settings → Access Token** → `CHATWOOT_ADMIN_TOKEN`. This is used
   to look a user up by email (`GET /api/v1/accounts/{id}/agents`); the Platform API has no
   search-by-email endpoint.

Set `CHATWOOT_ACCOUNT_ID` to that account's id (the number in the dashboard URL). It is
required even with `AUTO_PROVISION` off, because that account's agent list is what turns an
email address into a Chatwoot user id.

## What you need on the Hack Club Auth side

Register an OAuth application at <https://auth.hackclub.com/oauth/applications> with:

- **Redirect URI**: `https://<where-you-deploy-this>/auth/callback`
- **Scopes**: `openid email name`

Note that `auth.hackclub.com`'s discovery document under-reports what it accepts — it lists
only `openid profile phone birthdate`, while the [OAuth
guide](https://auth.hackclub.com/docs/oauth-guide) documents `openid profile email name
slack_id verification_status` for community applications. **`profile` does not include the
email address**, so `email` has to be requested explicitly or every sign-in fails with "No
email on file".

Copy the client id and secret into `HCA_CLIENT_ID` / `HCA_CLIENT_SECRET`.

## Deploy

```bash
npm install
npx wrangler login       # interactive, must be run in your own terminal
./scripts/setup.sh
```

`scripts/setup.sh` creates the KV namespace and writes its id into `wrangler.jsonc`,
generates `SESSION_SECRET`, prompts for the four credentials one at a time, and deploys. It
is idempotent — re-running skips whatever is already in place. To do it by hand instead:

```bash
npx wrangler kv namespace create CONFIG   # paste the id into wrangler.jsonc
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
npx wrangler secret put HCA_CLIENT_ID
npx wrangler secret put HCA_CLIENT_SECRET
npx wrangler secret put CHATWOOT_PLATFORM_TOKEN
npx wrangler secret put CHATWOOT_ADMIN_TOKEN
npx wrangler deploy
```

`SESSION_SECRET` is any random string — `openssl rand -base64 32`. It signs the short-lived
cookie carrying the OIDC `state`, `nonce` and PKCE verifier, and the admin session cookie.
Rotating it logs admins out and invalidates in-flight sign-ins; nothing else depends on it.

Locally: copy `.dev.vars.example` to `.dev.vars` and `wrangler.jsonc` to
`wrangler.local.jsonc`, fill both in, then `npm run dev` and `npm test`.

One local-dev quirk: with a `custom_domain` route configured, `wrangler dev` serves requests
with that route's Host, so `REDIRECT_URI` in `.dev.vars` must keep the same hostname or every
request comes back `421 Wrong host`. (Wrangler also rewrites that hostname back to
`localhost` inside redirect headers — a proxy artifact, not what the Worker emitted; check
`/healthz` for the real value.)

## Admin dashboard

`/admin` edits the allow-list, the auto-provisioning toggle and the role given to new agents.
Changes are stored in KV and take effect on the next sign-in.

Getting in requires **both** a completed Hack Club Auth sign-in *and* an email listed in
`ADMIN_EMAILS`. That list lives in `wrangler.jsonc`, not in KV, on purpose:

- someone who gets into the dashboard cannot grant themselves permanent access or lock
  everyone else out — the roster only changes with a deploy;
- removing an address from `ADMIN_EMAILS` kills any open session for it on the next request,
  since membership is re-checked every time rather than trusted from the cookie.

Leave `ADMIN_EMAILS` empty to switch the dashboard off entirely. With no KV namespace bound,
`/admin` still renders but is read-only and says so.

## The Chatwoot login screen

Everything above puts a working front door at `https://<your-worker>/` — but nobody types
that. People go to Chatwoot, and Chatwoot shows them an email and password form with no hint
that a Hack Club account is what they want.

`public/hca-login.js` fixes that from inside Chatwoot's own login page. Copy it into the
image and add one `<script>` tag to the dashboard layout — see `docker/Dockerfile.example`,
which does both:

```bash
docker build -f docker/Dockerfile.example \
  --build-arg CHATWOOT_VERSION=v4.7.0 \
  --build-arg HCA_LOGIN_URL=https://chatwoot-login.example.com/auth/login \
  -t chatwoot-hca-ui .
```

It changes three things at `/app/login`:

1. **A "Continue with Hack Club" button above the form**, in the slot Chatwoot itself uses
   for its Google OAuth button.
2. **The email/password form folded away** behind *Sign in with a password*, so the SSO route
   is the obvious one rather than one option among two. Anyone who opens it keeps it open on
   later visits.
3. **A "Signing you in…" cover during the hand-off.** Chatwoot's login view auto-submits when
   it sees `?sso_auth_token=` (`created() { if (this.ssoAuthToken) this.submitLogin() }`),
   which otherwise flashes the password form at someone who has already signed in.

Copy is set on the script tag, not in the file — `data-login-url` (required), `data-label`,
`data-note` (`data-note=""` drops the line under the button), `data-logo`,
`data-collapse-password` and `data-auto-redirect`.

Two escape hatches, because a login page is a bad place to be clever:

- **`/app/login?password=1`** skips the script entirely and gives you the stock form. Worth
  knowing before you need it — Hack Club Auth being down is exactly when you will.
- **No `data-login-url`, a parse error, a Worker that is unreachable** all leave Chatwoot's
  login page as it ships. The script only ever adds to the page.

`data-auto-redirect="true"` goes further and sends `/app/login` straight to Hack Club Auth
with no button to press. It is off by default: it takes the password form away from everyone,
including whoever has to get in when Hack Club Auth is the broken thing. There is a 30-second
loop guard, since a rejected sign-in lands back on this same page.

The script hooks `[data-testid="email_input"]` and the form around it, styles itself under
`#hca-*` ids, and picks up light or dark from Chatwoot's own `.dark` ancestor — so a Chatwoot
upgrade that renames Tailwind classes cannot restyle it. If upstream moves `</head>` in
`app/views/layouts/vueapp.html.erb`, the Dockerfile's final `grep` fails the build rather
than shipping an image that quietly lost the button.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HCA_ISSUER` | `https://auth.hackclub.com` | OIDC issuer, discovered at `/.well-known/openid-configuration` |
| `HCA_SCOPE` | `openid email name` | Scopes requested (`email` is required and is *not* part of `profile`) |
| `HCA_CLIENT_ID` / `HCA_CLIENT_SECRET` | — | OAuth app credentials |
| `SESSION_SECRET` | — | HMAC key for the flow and admin cookies |
| `REDIRECT_URI` | derived from the request | **Set this.** Pins the callback URL and the hostname the Worker will serve |
| `CHATWOOT_BASE_URL` | — | e.g. `https://chat.example.com` |
| `CHATWOOT_ACCOUNT_ID` | — | Account whose agent list is searched, and that new agents join |
| `CHATWOOT_PLATFORM_TOKEN` | — | Platform App token |
| `CHATWOOT_ADMIN_TOKEN` | — | Administrator access token |
| `ADMIN_EMAILS` | — | Who may open `/admin`. Empty disables it |
| `ALLOWED_EMAIL_DOMAINS` | `hackclub.com` | Starting allow-list; KV wins once saved |
| `ALLOWED_EMAILS` | — | Starting allow-list of individual addresses |
| `AUTO_PROVISION` | `true` | Create an agent on first sign-in; `false` = existing agents only |
| `DEFAULT_ROLE` | `agent` | Role for provisioned users (`agent` or `administrator`) |
| `REQUIRE_VERIFIED_EMAIL` | `true` | Require `email_verified` to be true |
| `BRAND_NAME` / `BRAND_BLURB` | `Chatwoot` / … | Login screen copy |

With **both** allow-lists empty the allow-list stops filtering, so what is left depends on
`AUTO_PROVISION`: on, any Hack Club account signs in and gets a seat (the dashboard warns
about this in orange); off, you still need an existing agent account, which is a reasonable
gate on its own. Listing a domain narrows it further in either case.

Domain matching is exact: listing `hackclub.com` does **not** admit `sub.hackclub.com`.

## Routes

| Route | Does |
| --- | --- |
| `/` | Login screen |
| `/auth/login` | Redirects to Hack Club Auth |
| `/auth/callback` | Verifies, provisions, redirects into Chatwoot |
| `/admin` | Allow-list dashboard (GET to view, POST to save) |
| `/admin/login`, `/admin/logout` | Dashboard session |
| `/healthz` | Reports missing config, the redirect URI in use, whether KV is bound |

And on the Chatwoot side, `/app/login` grows a Hack Club button — see [The Chatwoot login
screen](#the-chatwoot-login-screen).

## Local configuration

`wrangler.jsonc` is committed with placeholder hostnames and an empty `ADMIN_EMAILS`. Put
your real values in **`wrangler.local.jsonc`** (gitignored) — copy the committed file and
edit it. `npm run dev`, `npm run deploy` and `scripts/setup.sh` all prefer that file when it
exists, so your deployment details never end up in git.

A working setup looks like:

- Chatwoot at `https://chatwoot.example.com`, account `1`
- the Worker on `https://chatwoot-login.example.com` (custom domain route, DNS created on deploy)
- `AUTO_PROVISION=false` with both allow-lists empty — the gate is already having a Chatwoot
  agent account, and nobody is created automatically
- `ADMIN_EMAILS` listing whoever may open `/admin`

Pick a hostname **one label below the apex**. Cloudflare's Universal SSL wildcard covers
`*.example.com` but not `login.chatwoot.example.com`, and a deeper name fails with
`ERR_SSL_VERSION_OR_CIPHER_MISMATCH` until you add Advanced Certificate Manager.

### FRONTEND_URL on the Chatwoot side

Make sure your Chatwoot's `FRONTEND_URL` has **no trailing slash**. Chatwoot builds the SSO
link as `"#{FRONTEND_URL}/app/login?..."`, so a trailing slash yields `//app/login`; the
frontend router does not match that path, redirects to `/app/login` and drops the query
string — taking the `sso_auth_token` with it, leaving you on the login form. This Worker
normalises the path defensively, but everything else Chatwoot builds from `FRONTEND_URL`
(password resets, invitations, notification links) has the same defect.

## Platform App permissibles

Chatwoot's `PlatformController` only lets a Platform App act on users **it created**:

```ruby
def validate_platform_app_permissible
  return if @platform_app.platform_app_permissibles.find_by(permissible: @resource)
  render json: { error: 'Non permissible resource' }, status: :unauthorized
end
```

So agents who existed before this bridge cannot be handed an SSO link straight away — the
first attempt comes back `401 Non permissible resource`. When that happens the Worker calls
`POST /platform/api/v1/users` with the same email and retries once. That endpoint is
find-or-create:

```ruby
@resource = (User.from_email(user_params[:email]) || User.new(user_params))
@resource.save!
@platform_app.platform_app_permissibles.find_or_create_by!(permissible: @resource)
```

For an address that already exists it returns that user and registers the permissible
**without applying the submitted attributes**, so nothing about the existing account is
overwritten and no new user appears. It is an adoption, and it happens once per agent.

The equivalent by hand, if you would rather do it on the server:

```ruby
PlatformApp.first.platform_app_permissibles.find_or_create_by(
  permissible: User.find_by(email: "someone@example.com")
)
```

A 401 carrying `{"error":"Invalid access_token"}` is the other case entirely: the token is
not a Platform App token at all. The sign-in page names that one directly.

## Security notes

What the code does, so you can check the claims rather than take them:

- **The `id_token` is verified, not decoded.** RS256 signature against the issuer's JWKS,
  plus `iss`, `aud`, `exp`, `iat` and the per-request `nonce` (`src/oidc.js`). A response
  with no `id_token` is rejected outright, and `alg` must be RS256 — an `alg: none` token
  never reaches the claim checks.
- **PKCE (S256) on every flow**, alongside the client secret.
- **No session store.** The OIDC flow state and the admin session are HMAC-signed cookies —
  `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `/auth` and `/admin`, with an embedded
  expiry that is checked on open. Tampering, re-signing with another key and expiry are
  covered by `test/access.test.mjs`.
- **The userinfo `sub` must match the `id_token` `sub`** before its claims are merged in
  (OIDC core 5.3.2), so a mixed-up profile cannot substitute another identity's email.
- **`email_verified` must be explicitly `true`** when `REQUIRE_VERIFIED_EMAIL` is on. A
  missing claim is not treated as verified — otherwise an unverified `@hackclub.com` address
  would walk straight through the domain allow-list. It is not confirmed that Hack Club Auth
  sends this claim at all; if it does not, the error page says so and you can turn the check
  off at `/admin`.
- **The allow-list reads the domain as the last `@`-segment**, so `a@hackclub.com@evil.com`
  does not match `hackclub.com`. Spoofing shapes are in the tests.
- **The admin form is CSRF-protected** by a random per-session token compared in constant
  time, on top of `SameSite=Lax`. KV contents are re-sanitised on read, so a corrupted or
  hand-edited record cannot inject unexpected fields or an unknown role.
- **Errors do not leak upstream detail.** Chatwoot API bodies and stack traces go to
  `wrangler tail`; the browser gets a short reference id to quote. User-actionable failures
  (not on the list, unverified email) still name the address.
- **Security headers on every response**: a `default-src 'none'` CSP with `frame-ancestors
  'none'` and `form-action 'self'`, `nosniff`, `X-Frame-Options: DENY`, `no-referrer`.
- **`REDIRECT_URI` pins the hostname.** When set, requests arriving on any other host are
  refused, so a spoofed `Host` header cannot steer the flow. Unset, the redirect URI is
  derived from the request origin — fine locally, not for production.
- **Sign-ins are logged** (`auth: signed in …`, `admin: settings updated by …`) and rejections
  are logged at `warn`, visible via `npx wrangler tail`.

### Limits worth knowing

- **Chatwoot's own password login stays open.** Without enterprise SAML there is no supported
  switch to disable it; this adds a front door, it does not lock the old one. `hca-login.js`
  folding the form away is presentation only — the endpoint behind it is untouched, and
  `?password=1` brings the form back. Provisioned
  users get a random password that is generated and discarded, but anyone who knows an
  agent's address can still use *forgot password*. If that matters, put Chatwoot's
  `/app/login` behind Cloudflare Access.
- **No deprovisioning.** Removing someone from Hack Club Auth does not remove their Chatwoot
  agent — delete the agent in Chatwoot too. Taking them off the allow-list only stops future
  sign-ins through this Worker.
- **No rate limiting.** The expensive paths are behind a valid signed state cookie, but if
  you want a belt-and-braces limit, Cloudflare's rate-limiting rules sit in front of this.
- The login screen mirrors the layout and styling of
  [looking-glass.hackclub.dev/login](https://looking-glass.hackclub.dev/login).
