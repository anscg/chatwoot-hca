// Login, error and admin screens. Layout and styling mirror
// https://looking-glass.hackclub.dev/login (Geist, #0a0a0a page, panel, Hack Club red CTA).

const CSS = `
*,*:before,*:after{box-sizing:border-box;margin:0;padding:0}
:root{
  --space-xs:4px;--space-sm:8px;--space-md:12px;--space-lg:16px;--space-xl:20px;
  --space-xxl:24px;--space-xxxl:32px;
  --radius-sm:6px;--radius-md:8px;--radius-lg:10px;
  --text-xs:11px;--text-sm:12px;--text-md:13px;--text-lg:14px;--text-xl:16px;
  --text-xxl:18px;--text-heading:20px;--text-display:24px;
  --font-sans:"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  --color-text-primary:#fff;
}
html{color-scheme:dark}
body{
  font-family:var(--font-sans);background:#0a0a0a;color:var(--color-text-primary);
  -webkit-font-smoothing:antialiased;min-height:100vh;font-size:var(--text-lg);line-height:1.5;
}
a{color:inherit;text-decoration:none}
.page{
  display:flex;flex-direction:column;justify-content:center;align-items:center;
  gap:var(--space-xl);min-height:100vh;padding:var(--space-xl);background:#0a0a0a;
}
.page.wide{justify-content:flex-start;padding-top:56px;padding-bottom:64px}
.brandRow{width:100%;max-width:400px;padding-left:2px;display:flex;align-items:center}
.wide .brandRow,.wide .panel{max-width:560px}
.brand{
  display:flex;align-items:center;gap:var(--space-sm);font-size:var(--text-lg);
  letter-spacing:-.01em;white-space:nowrap;font-weight:600;
}
.who{margin-left:auto;font-size:var(--text-md);color:#ffffff73;display:flex;align-items:center;gap:var(--space-md)}
.who a:hover{color:#fffc}
.mark{object-fit:contain;border-radius:4px;flex:none;width:20px;height:20px}
.panel{
  display:flex;flex-direction:column;gap:var(--space-lg);border-radius:var(--radius-lg);
  width:100%;max-width:400px;padding:var(--space-xxl);background:#101010;
  border:1px solid #ffffff1a;animation:.24s both rise;
}
.title{font-size:var(--text-xxl);letter-spacing:-.01em;color:#fff;font-weight:600}
.blurb{font-size:var(--text-md);color:#ffffff8c;margin-top:-10px;line-height:1.55}
.cta{
  display:flex;justify-content:center;align-items:center;color:#fff;height:42px;
  font-size:var(--text-lg);letter-spacing:-.005em;font-weight:600;border-radius:999px;
  background:linear-gradient(#f04a63 0%,#ec3750 55%,#d92b43 100%);border:none;cursor:pointer;
  font-family:inherit;transition:transform .1s,filter .12s;
  box-shadow:inset 0 1px #ffffff59,inset 0 -1px #0000002e,0 2px 10px #ec375047;
}
.cta:hover{filter:brightness(1.06)}
.cta:active{filter:brightness(.96);transform:translateY(1px)}
.detail{
  font-family:var(--font-mono);font-size:var(--text-sm);color:#ffffff73;background:#ffffff0a;
  border:1px solid #ffffff14;border-radius:var(--radius-md);padding:var(--space-md);word-break:break-word;
}
.back{font-size:var(--text-md);color:#ffffff73;text-align:center}
.back:hover{color:#fffc}

/* --- admin ------------------------------------------------------------- */
.field{display:flex;flex-direction:column;gap:6px}
.label{font-size:var(--text-md);font-weight:500;color:#ffffffd9}
.hint{font-size:var(--text-sm);color:#ffffff73;line-height:1.5}
.input,.select,textarea.input{
  font-family:var(--font-mono);font-size:var(--text-md);color:#fff;background:#ffffff0a;
  border:1px solid #ffffff1f;border-radius:var(--radius-md);padding:10px var(--space-md);
  width:100%;resize:vertical;transition:border-color .12s,background .12s;
}
.select{font-family:var(--font-sans)}
.input:focus,.select:focus{outline:none;border-color:#ffffff4d;background:#ffffff12}
.row{display:flex;align-items:flex-start;gap:var(--space-md)}
.row .label{cursor:pointer}
.check{
  appearance:none;flex:none;width:16px;height:16px;margin-top:2px;border-radius:5px;
  border:1px solid #ffffff38;background:#ffffff0a;cursor:pointer;display:grid;place-items:center;
}
.check:checked{background:#ec3750;border-color:#ec3750}
.check:checked:after{content:"";width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg) translate(-1px,-1px)}
.sep{height:1px;background:#ffffff14;margin:var(--space-xs) 0}
.flash{
  font-size:var(--text-md);border-radius:var(--radius-md);padding:10px var(--space-md);
  border:1px solid #22c55e40;background:#22c55e1a;color:#86efac;
}
.flash.warn{border-color:#f59e0b40;background:#f59e0b1a;color:#fcd34d}
.flash.bad{border-color:#ef444440;background:#ef44441a;color:#fca5a5}
.meta{font-size:var(--text-sm);color:#ffffff59}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

const LOGO = "https://assets.hackclub.com/icon-rounded.png";

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function shell({ title, brand, body, wide = false, who = "" }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="${LOGO}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap">
<style>${CSS}</style>
</head><body>
<main class="page${wide ? " wide" : ""}">
  <div class="brandRow">
    <a class="brand" href="/"><img class="mark" src="${LOGO}" alt="" width="20" height="20">${esc(brand)}</a>
    ${who}
  </div>
  ${body}
</main>
</body></html>`;
}

export function loginPage({ brand, blurb, loginPath }) {
  return shell({
    title: `Sign in · ${brand}`,
    brand,
    body: `<div class="panel">
    <h1 class="title">Sign in</h1>
    <p class="blurb">${esc(blurb)}</p>
    <a class="cta" href="${esc(loginPath)}">Continue with Hack Club</a>
  </div>`,
  });
}

export function errorPage({ brand, heading, message, detail }) {
  return shell({
    title: `${heading} · ${brand}`,
    brand,
    body: `<div class="panel">
    <h1 class="title">${esc(heading)}</h1>
    <p class="blurb">${esc(message)}</p>
    ${detail ? `<div class="detail">${esc(detail)}</div>` : ""}
    <a class="back" href="/">← Back to sign in</a>
  </div>`,
  });
}

export function adminLoginPage({ brand }) {
  return shell({
    title: `Admin · ${brand}`,
    brand,
    body: `<div class="panel">
    <h1 class="title">Admin</h1>
    <p class="blurb">Sign in with a Hack Club account listed in <code>ADMIN_EMAILS</code> to edit who can reach ${esc(brand)}.</p>
    <a class="cta" href="/admin/login">Continue with Hack Club</a>
    <a class="back" href="/">← Back to sign in</a>
  </div>`,
  });
}

export function adminPage({ brand, email, settings, csrf, flash, readOnly, adminEmails }) {
  const open = settings.allowedDomains.length === 0 && settings.allowedEmails.length === 0;

  const notices = [];
  if (readOnly) {
    notices.push(`<div class="flash bad">No <code>CONFIG</code> KV namespace is bound, so changes cannot be saved.
      Values below come from <code>wrangler.jsonc</code>. See the README to create the namespace.</div>`);
  }
  if (open && settings.autoProvision) {
    notices.push(`<div class="flash warn">Both allow-lists are empty and agents are created automatically —
      <strong>any</strong> Hack Club account can sign in and will be given a seat.</div>`);
  } else if (open) {
    notices.push(`<div class="flash">Both allow-lists are empty, so the only gate is already having a
      ${esc(brand)} agent account. Add a domain below to narrow it further.</div>`);
  }
  if (flash) {
    notices.push(`<div class="flash ${flash.kind === "error" ? "bad" : ""}">${esc(flash.message)}</div>`);
  }

  const who = `<div class="who"><span>${esc(email)}</span><a href="/admin/logout">Sign out</a></div>`;

  const body = `<div class="panel">
    <h1 class="title">Access</h1>
    <p class="blurb">Who may sign in to ${esc(brand)} with Hack Club Auth.</p>
    ${notices.join("\n")}
    <form method="POST" action="/admin" style="display:flex;flex-direction:column;gap:var(--space-lg)">
      <input type="hidden" name="csrf" value="${esc(csrf)}">

      <div class="field">
        <label class="label" for="domains">Allowed email domains</label>
        <textarea class="input" id="domains" name="domains" rows="2" spellcheck="false"
          placeholder="hackclub.com" ${readOnly ? "disabled" : ""}>${esc(settings.allowedDomains.join("\n"))}</textarea>
        <span class="hint">One per line, or comma-separated.</span>
      </div>

      <div class="field">
        <label class="label" for="emails">Allowed individual emails</label>
        <textarea class="input" id="emails" name="emails" rows="4" spellcheck="false"
          placeholder="someone@example.com" ${readOnly ? "disabled" : ""}>${esc(settings.allowedEmails.join("\n"))}</textarea>
        <span class="hint">Addresses outside the domains above. One per line.</span>
      </div>

      <div class="sep"></div>

      <div class="row">
        <input class="check" type="checkbox" id="autoProvision" name="autoProvision" ${settings.autoProvision ? "checked" : ""} ${readOnly ? "disabled" : ""}>
        <div class="field" style="gap:2px">
          <label class="label" for="autoProvision">Create agents automatically</label>
          <span class="hint">Off: only people who already have a ${esc(brand)} agent account can sign in.</span>
        </div>
      </div>

      <div class="row">
        <input class="check" type="checkbox" id="requireVerifiedEmail" name="requireVerifiedEmail" ${settings.requireVerifiedEmail ? "checked" : ""} ${readOnly ? "disabled" : ""}>
        <div class="field" style="gap:2px">
          <label class="label" for="requireVerifiedEmail">Require a verified email</label>
          <span class="hint">Keep this on — an unverified address defeats the domain allow-list.</span>
        </div>
      </div>

      <div class="field">
        <label class="label" for="role">Role for new agents</label>
        <select class="select" id="role" name="role" ${readOnly ? "disabled" : ""}>
          <option value="agent" ${settings.role === "agent" ? "selected" : ""}>Agent</option>
          <option value="administrator" ${settings.role === "administrator" ? "selected" : ""}>Administrator</option>
        </select>
      </div>

      ${readOnly ? "" : `<button class="cta" type="submit">Save changes</button>`}
    </form>
    <div class="sep"></div>
    <span class="meta">${
      settings.updatedAt
        ? `Last changed ${esc(settings.updatedAt)}${settings.updatedBy ? ` by ${esc(settings.updatedBy)}` : ""}.`
        : "Using the defaults from wrangler.jsonc."
    }</span>
    <span class="meta">Dashboard access is fixed in <code>ADMIN_EMAILS</code>: ${
      adminEmails.length ? esc(adminEmails.join(", ")) : "—"
    }</span>
  </div>`;

  return shell({ title: `Access · ${brand}`, brand, body, wide: true, who });
}
