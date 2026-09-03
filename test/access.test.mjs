// node --test
// Covers the two pieces of security logic that are pure and easy to get subtly wrong:
// who the allow-list lets in, and whether a tampered cookie can be opened.

import assert from "node:assert/strict";
import test from "node:test";

import { isAllowed, parseList } from "../src/settings.js";
import { openState, sealState } from "../src/oidc.js";

const S = (domains = [], emails = []) => ({ allowedDomains: domains, allowedEmails: emails });
const SECRET = "test-secret-not-used-anywhere-real";

test("allow-list matches on domain, case-insensitively", () => {
  assert.equal(isAllowed(S(["hackclub.com"]), "someone@hackclub.com"), true);
  assert.equal(isAllowed(S(["hackclub.com"]), "SOMEONE@HackClub.COM"), true);
  assert.equal(isAllowed(S(["hackclub.com"]), "x@evil.com"), false);
});

test("allow-list cannot be spoofed with a lookalike domain", () => {
  // The domain is the last @-segment, not the first.
  assert.equal(isAllowed(S(["hackclub.com"]), "a@hackclub.com@evil.com"), false);
  assert.equal(isAllowed(S(["hackclub.com"]), "x@hackclub.com.evil.com"), false);
  assert.equal(isAllowed(S(["hackclub.com"]), "x@evilhackclub.com"), false);
  // A subdomain is a different domain and must be listed explicitly.
  assert.equal(isAllowed(S(["hackclub.com"]), "x@sub.hackclub.com"), false);
  // A local part that looks like a domain is harmless.
  assert.equal(isAllowed(S(["hackclub.com"]), "evil.com@hackclub.com"), true);
});

test("individual addresses and malformed input", () => {
  assert.equal(isAllowed(S([], ["friend@gmail.com"]), "friend@gmail.com"), true);
  assert.equal(isAllowed(S([], ["friend@gmail.com"]), "other@gmail.com"), false);
  assert.equal(isAllowed(S(["hackclub.com"]), "notanemail"), false);
  assert.equal(isAllowed(S(["hackclub.com"]), ""), false);
  assert.equal(isAllowed(S(["hackclub.com"]), null), false);
});

test("two empty allow-lists mean anyone with a Hack Club account", () => {
  assert.equal(isAllowed(S([], []), "anyone@anywhere.com"), true);
});

test("parseList normalises, splits and de-duplicates", () => {
  assert.deepEqual(parseList("A.com, b.com\nb.com  c.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(parseList(""), []);
  assert.deepEqual(parseList(null), []);
});

test("sealed state round-trips", async () => {
  const token = await sealState({ hello: "world", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  assert.equal((await openState(token, SECRET)).hello, "world");
});

test("sealed state rejects tampering, a wrong key and expiry", async () => {
  const token = await sealState({ email: "user@example.com", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);

  // Flipped signature byte.
  assert.equal(await openState(`${token.slice(0, -1)}${token.at(-1) === "A" ? "B" : "A"}`, SECRET), null);
  // Re-signed with a different key.
  assert.equal(await openState(token, "some-other-secret"), null);
  // Payload swapped, original signature kept.
  const forged = Buffer.from(JSON.stringify({ email: "admin@example.com", exp: 9e9 })).toString("base64url");
  assert.equal(await openState(`${forged}.${token.split(".")[1]}`, SECRET), null);
  // Already expired.
  const stale = await sealState({ exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  assert.equal(await openState(stale, SECRET), null);
  // Junk.
  assert.equal(await openState("", SECRET), null);
  assert.equal(await openState("no-dot", SECRET), null);
});

test("sso link paths with a doubled slash are normalised", () => {
  // Chatwoot yields "//app/login" when FRONTEND_URL has a trailing slash; the frontend
  // router drops the query string on that path, losing the sso_auth_token.
  const fix = (raw, base) => {
    const u = new URL(raw, base);
    u.pathname = u.pathname.replace(/\/{2,}/g, "/");
    return u.toString();
  };
  const base = "https://chatwoot.example.com";
  assert.equal(
    fix("https://chatwoot.example.com//app/login?email=a%40b.com&sso_auth_token=abc", base),
    "https://chatwoot.example.com/app/login?email=a%40b.com&sso_auth_token=abc",
  );
  // Already correct — left alone.
  assert.equal(
    fix("https://chatwoot.example.com/app/login?sso_auth_token=abc", base),
    "https://chatwoot.example.com/app/login?sso_auth_token=abc",
  );
  // FRONTEND_URL unset on the server makes the url relative.
  assert.equal(
    fix("/app/login?sso_auth_token=abc", base),
    "https://chatwoot.example.com/app/login?sso_auth_token=abc",
  );
});
