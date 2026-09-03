/*
 * hca-login.js — makes Chatwoot's own login screen point at chatwoot-hca.
 *
 * Chatwoot has no supported way to add a sign-in provider without the enterprise
 * SAML licence, so this is injected into the dashboard layout instead (see
 * docker/Dockerfile.example). It does three things on /app/login:
 *
 *   1. puts a "Continue with Hack Club" button above the form, in the slot
 *      Chatwoot itself uses for Google OAuth;
 *   2. folds the email/password form away behind a link, so the SSO route is the
 *      obvious one rather than one option among two;
 *   3. covers the page while an SSO hand-off completes. Chatwoot's login view
 *      auto-submits when it sees ?sso_auth_token= (`created(){ if (this.ssoAuthToken)
 *      this.submitLogin() }`), which otherwise flashes the password form at
 *      someone who has already signed in.
 *
 * Everything degrades to the stock login form: no config, a parse error, a Worker
 * that is down — you get Chatwoot exactly as it ships. ?password=1 forces that too.
 *
 * Configure it on the script tag, no rebuild of this file needed:
 *
 *   <script src="/hca-login.js"
 *           data-login-url="https://chatwoot-login.example.com/auth/login"
 *           data-label="Continue with Hack Club"
 *           data-note="Only if you already have an account provisioned."
 *           data-collapse-password="true"
 *           data-logo="https://assets.hackclub.com/icon-rounded.png"
 *           data-auto-redirect="false"
 *           defer></script>
 */
(function () {
  "use strict";

  var script = document.currentScript || (function () {
    var all = document.querySelectorAll('script[src*="hca-login"]');
    return all[all.length - 1] || null;
  })();
  var data = (script && script.dataset) || {};

  var CONFIG = {
    // Where /auth/login lives on your chatwoot-hca deployment. Required — with no
    // value the script does nothing at all, rather than render a dead button.
    loginUrl: data.loginUrl || window.HCA_LOGIN_URL || "",
    label: data.label || "Continue with Hack Club",
    note: data.note === undefined ? "Only if you already have an account provisioned." : data.note,
    // Hide the email/password form until someone asks for it. Chatwoot's password
    // login stays fully functional either way — this is presentation only.
    collapsePassword: data.collapsePassword !== "false",
    // Skip the login screen entirely and bounce straight to Hack Club Auth. Off by
    // default: it takes the password form away from anyone who needs it, including
    // whoever has to get in when Hack Club Auth is the thing that is broken.
    autoRedirect: data.autoRedirect === "true",
    logo: data.logo === undefined ? "https://assets.hackclub.com/icon-rounded.png" : data.logo,
  };

  var ROOT_ID = "hca-root";
  var STYLE_ID = "hca-style";
  var OVERLAY_ID = "hca-overlay";
  var PREF_KEY = "hca:show-password-form";
  var REDIRECT_GUARD_KEY = "hca:auto-redirect-at";

  if (!CONFIG.loginUrl) {
    console.warn("[hca-login] no data-login-url on the script tag — leaving the login page alone");
    return;
  }

  /* --- helpers ----------------------------------------------------------- */

  function onLoginRoute() {
    return /^\/app\/login\/?$/.test(location.pathname);
  }

  function params() {
    return new URLSearchParams(location.search);
  }

  /** An SSO hand-off in progress: Chatwoot is about to log this person in. */
  function handingOff() {
    return Boolean(params().get("sso_auth_token"));
  }

  /** Deliberate opt-out, so password login is always reachable by URL. */
  function passwordForced() {
    var v = params().get("password");
    return v === "1" || v === "true";
  }

  function stored(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function store(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private mode, storage disabled — the toggle just stops being sticky */
    }
  }

  function css() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    // Scoped to #hca-* ids and driven by Chatwoot's own .dark ancestor, so a
    // Chatwoot upgrade that renames Tailwind classes cannot restyle this.
    style.textContent = [
      "#hca-root{--hca-muted:#4a5568;--hca-rule:rgba(0,0,0,.1);--hca-link:#2781f6;",
      "display:flex;flex-direction:column;gap:14px;font-family:inherit}",
      ".dark #hca-root{--hca-muted:rgba(255,255,255,.55);--hca-rule:rgba(255,255,255,.12);--hca-link:#5fa5f9}",
      "#hca-btn{display:flex;align-items:center;justify-content:center;gap:10px;height:48px;",
      "padding:0 20px;border:0;border-radius:8px;cursor:pointer;text-decoration:none;",
      "font:600 16px/1 inherit;color:#fff;background:linear-gradient(#f04a63 0%,#ec3750 55%,#d92b43 100%);",
      "box-shadow:inset 0 1px rgba(255,255,255,.35),0 2px 10px rgba(236,55,80,.28);",
      "transition:filter .12s,transform .1s}",
      "#hca-btn:hover{filter:brightness(1.06)}",
      "#hca-btn:active{filter:brightness(.96);transform:scale(.985)}",
      "#hca-btn:focus-visible{outline:2px solid #ec3750;outline-offset:2px}",
      "#hca-btn img{width:20px;height:20px;border-radius:4px;object-fit:contain;flex:none}",
      "#hca-note{font-size:13px;line-height:1.5;color:var(--hca-muted);text-align:center;margin-top:-4px}",
      "#hca-or{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--hca-muted)}",
      "#hca-or:before,#hca-or:after{content:'';flex:1;height:1px;background:var(--hca-rule)}",
      "#hca-toggle{align-self:center;background:none;border:0;padding:4px;cursor:pointer;",
      "font:500 14px/1.4 inherit;color:var(--hca-link);text-decoration:underline;text-underline-offset:2px}",
      "#hca-toggle:hover{filter:brightness(1.1)}",
      ".hca-hidden{display:none!important}",
      "#hca-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;",
      "align-items:center;justify-content:center;gap:18px;background:#f9fafb;color:#1f2933;",
      "font:500 15px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
      "#hca-overlay.hca-dark{background:#151718;color:rgba(255,255,255,.86)}",
      "#hca-spinner{width:28px;height:28px;border-radius:50%;border:3px solid rgba(236,55,80,.25);",
      "border-top-color:#ec3750;animation:hca-spin .7s linear infinite}",
      "@keyframes hca-spin{to{transform:rotate(1turn)}}",
      "@media (prefers-reduced-motion:reduce){#hca-spinner{animation-duration:2s}",
      "#hca-btn{transition:none}}",
    ].join("");
    document.head.appendChild(style);
  }

  /* --- the hand-off cover ------------------------------------------------ */

  function showOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    css();
    var el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    if (document.querySelector(".dark") || matchMedia("(prefers-color-scheme: dark)").matches) {
      el.className = "hca-dark";
    }
    var spinner = document.createElement("div");
    spinner.id = "hca-spinner";
    var text = document.createElement("div");
    text.textContent = "Signing you in…";
    el.appendChild(spinner);
    el.appendChild(text);
    (document.body || document.documentElement).appendChild(el);

    // If the hand-off never completes — expired token, Chatwoot API down — do not
    // leave someone staring at a spinner with no way back to the form.
    window.setTimeout(function () {
      var still = document.getElementById(OVERLAY_ID);
      if (still) still.remove();
    }, 15000);
  }

  /* --- the button -------------------------------------------------------- */

  /** Chatwoot renders its Google OAuth button in a flex column just above the form. */
  function slotFor(form) {
    var sibling = form.previousElementSibling;
    if (sibling && sibling.classList.contains("flex") && sibling.classList.contains("flex-col")) {
      return { parent: sibling, before: null };
    }
    return { parent: form.parentElement, before: form };
  }

  function build(form) {
    var root = document.createElement("div");
    root.id = ROOT_ID;

    var btn = document.createElement("a");
    btn.id = "hca-btn";
    btn.href = CONFIG.loginUrl;
    if (CONFIG.logo) {
      var img = document.createElement("img");
      img.src = CONFIG.logo;
      img.alt = "";
      img.width = 20;
      img.height = 20;
      // A blocked or missing asset should cost the label nothing.
      img.onerror = function () {
        img.remove();
      };
      btn.appendChild(img);
    }
    btn.appendChild(document.createTextNode(CONFIG.label));
    root.appendChild(btn);

    if (CONFIG.note) {
      var note = document.createElement("div");
      note.id = "hca-note";
      note.textContent = CONFIG.note;
      root.appendChild(note);
    }

    if (!CONFIG.collapsePassword) return root;

    var or = document.createElement("div");
    or.id = "hca-or";
    or.appendChild(document.createTextNode("or"));

    var toggle = document.createElement("button");
    toggle.id = "hca-toggle";
    toggle.type = "button";
    toggle.textContent = "Sign in with a password";
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", function () {
      reveal(form);
      store(PREF_KEY, "1");
      var email = form.querySelector('[data-testid="email_input"]');
      if (email) email.focus();
    });

    root.appendChild(or);
    root.appendChild(toggle);
    return root;
  }

  function collapse(form) {
    form.classList.add("hca-hidden");
    // "Forgot your password?" sits inside the form, so it goes with it; the signup
    // link and any Chatwoot alert live outside and stay visible.
  }

  function reveal(form) {
    form.classList.remove("hca-hidden");
    // The "or" rule stays: with the form open it is the only thing separating the
    // two ways in. Only the link that opened it has nothing left to do.
    var toggle = document.getElementById("hca-toggle");
    if (toggle) toggle.classList.add("hca-hidden");
  }

  function decorate() {
    if (document.getElementById(ROOT_ID)) return true;

    var email = document.querySelector('[data-testid="email_input"]');
    var form = email && email.closest("form");
    if (!form) return false;

    css();
    var slot = slotFor(form);
    var root = build(form);
    slot.parent.insertBefore(root, slot.before);

    if (CONFIG.collapsePassword) {
      // Someone who has used the password form before keeps it open: this is meant
      // to clear the path for the common case, not to hide the other one twice.
      if (stored(PREF_KEY) === "1") reveal(form);
      else collapse(form);
    }
    return true;
  }

  /* --- lifecycle --------------------------------------------------------- */

  var observer = null;

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function watch() {
    if (observer) return;
    // The login view is a Vue route: it mounts after this script runs, and Vue may
    // re-render the form (validation, locale, theme) and drop the injected node.
    observer = new MutationObserver(function () {
      if (!onLoginRoute()) {
        stop();
        return;
      }
      decorate();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(stop, 30000);
  }

  function maybeAutoRedirect() {
    var last = Number(window.sessionStorage.getItem(REDIRECT_GUARD_KEY) || 0);
    // A rejected sign-in comes back to this same page. Without the guard that is a
    // redirect loop between Chatwoot and the Worker.
    if (Date.now() - last < 30000) return false;
    try {
      window.sessionStorage.setItem(REDIRECT_GUARD_KEY, String(Date.now()));
    } catch (e) {
      return false;
    }
    location.replace(CONFIG.loginUrl);
    return true;
  }

  function run() {
    if (!onLoginRoute()) return;

    if (handingOff()) {
      showOverlay();
      return;
    }
    if (passwordForced()) return;
    if (CONFIG.autoRedirect && !params().get("error") && maybeAutoRedirect()) return;

    decorate();
    watch();
  }

  function boot() {
    run();
    // Chatwoot navigates client-side (logout, session expiry, /app -> /app/login),
    // so the login route can appear without a page load.
    ["pushState", "replaceState"].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var out = original.apply(this, arguments);
        window.setTimeout(run, 0);
        return out;
      };
    });
    window.addEventListener("popstate", function () {
      window.setTimeout(run, 0);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
