#!/usr/bin/env bash
# One-shot setup for chatwoot-hca. Run it after `npx wrangler login`.
# Safe to re-run: it skips anything already done.
set -euo pipefail

cd "$(dirname "$0")/.."

# Real deployments keep their hostnames and admin roster in a gitignored
# wrangler.local.jsonc so the committed config can stay generic.
CONFIG=wrangler.jsonc
[ -f wrangler.local.jsonc ] && CONFIG=wrangler.local.jsonc
echo "Using $CONFIG"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }

say "1/4  Checking Cloudflare login"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "  Not logged in. Run:  npx wrangler login"
  exit 1
fi
npx wrangler whoami 2>/dev/null | grep -iE 'associated with|account name' || true

say "2/4  KV namespace for the admin dashboard"
if grep -q 'REPLACE_WITH_KV_NAMESPACE_ID' "$CONFIG"; then
  out=$(npx wrangler kv namespace create CONFIG -c "$CONFIG" 2>&1) || { echo "$out"; exit 1; }
  # Wrangler prints the new binding as JSON/TOML; pull the 32-hex id out of it.
  id=$(printf '%s' "$out" | grep -oE '[0-9a-f]{32}' | head -1)
  if [ -z "$id" ]; then
    echo "$out"
    echo "  Could not find the namespace id in that output — paste it into wrangler.jsonc by hand."
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const p = process.argv[2];
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("REPLACE_WITH_KV_NAMESPACE_ID", process.argv[1]));
  ' "$id" "$CONFIG"
  ok "created and wired up namespace $id"
else
  ok "already configured in $CONFIG"
fi

say "3/4  Secrets"
existing=$(npx wrangler secret list -c "$CONFIG" 2>/dev/null || echo '[]')

put_secret() {
  local name="$1" prompt="$2"
  if printf '%s' "$existing" | grep -q "\"$name\""; then
    ok "$name already set (delete it with: npx wrangler secret delete $name)"
    return
  fi
  echo
  echo "  $prompt"
  npx wrangler secret put "$name" -c "$CONFIG"
}

if printf '%s' "$existing" | grep -q '"SESSION_SECRET"'; then
  ok "SESSION_SECRET already set"
else
  openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET -c "$CONFIG"
  ok "SESSION_SECRET generated"
fi

put_secret HCA_CLIENT_ID     "Client id from https://auth.hackclub.com/oauth/applications"
put_secret HCA_CLIENT_SECRET "Client secret for that same application"
put_secret CHATWOOT_PLATFORM_TOKEN \
  "Platform App token — <your-chatwoot>/super_admin → Platform Apps"
put_secret CHATWOOT_ADMIN_TOKEN \
  "Access token of a Chatwoot administrator — Profile Settings → Access Token"

say "4/4  Deploy"
npx wrangler deploy -c "$CONFIG"

cat <<'DONE'

Done. Remaining manual step:

  Register the redirect URI on Hack Club Auth
  https://auth.hackclub.com/oauth/applications
    Redirect URI:  <your worker URL>/auth/callback
    Scopes:        openid profile

Then check <your worker URL>/healthz and sign in.
DONE
