// Runs the Worker on plain Node, for hosts without Cloudflare (Docker, Kubernetes).
// The Worker only needs a fetch handler and a KV-shaped CONFIG binding, so this maps
// Node's http server onto the first and a JSON file onto the second.
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import worker from "../src/index.js";

const PORT = Number(process.env.PORT || 8787);
const KV_PATH = process.env.KV_PATH || "/data/kv.json";
const LOGIN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../public/hca-login.js");

// Enough of the KV API for settings.js: get(key, "json") and put(key, string).
function fileKv(path) {
  let queue = Promise.resolve();
  const load = async () => {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  };
  return {
    async get(key, type) {
      const value = (await load())[key];
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    put(key, value) {
      queue = queue.then(async () => {
        const all = await load();
        all[key] = String(value);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, JSON.stringify(all));
        await rename(`${path}.tmp`, path);
      });
      return queue;
    },
  };
}

const env = { ...process.env };
if (process.env.KV_DISABLED !== "true") env.CONFIG = fileKv(KV_PATH);

function toRequest(req) {
  const proto = req.headers["x-forwarded-proto"]?.split(",")[0] || "https";
  const host = req.headers["x-forwarded-host"]?.split(",")[0] || req.headers.host;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`${proto}://${host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? "half" : undefined,
  });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") headers[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    for await (const chunk of response.body) res.write(chunk);
  }
  res.end();
}

createServer(async (req, res) => {
  try {
    // Served from here so Chatwoot can load it through DASHBOARD_SCRIPTS, with no
    // custom image.
    if (req.url.split("?")[0] === "/hca-login.js") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      });
      return res.end(await readFile(LOGIN_SCRIPT));
    }
    await send(res, await worker.fetch(toRequest(req), env, { waitUntil() {}, passThroughOnException() {} }));
  } catch (e) {
    console.error("chatwoot-hca node:", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
}).listen(PORT, () => console.log(`chatwoot-hca listening on :${PORT}`));
