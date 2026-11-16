// One request handler for the whole app: serves the built interface and the API.
// In the desktop app it is plugged into Electron's private app:// protocol (no network port is opened).
// For development and automated tests the same handler is served on 127.0.0.1.
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Core } from "./core";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".ico": "image/x-icon",
};
// The interface may only load its own files and talk to this handler — nothing on the internet.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function createHandler(core: Core, outDir: string): (req: Request) => Promise<Response> {
  const root = path.resolve(outDir);
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/api/rpc") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body: { method?: unknown; args?: unknown };
      try {
        body = JSON.parse(await req.text());
      } catch {
        return Response.json({ ok: false, error: { code: "invalid", message: "Malformed request" } }, { status: 400 });
      }
      const result = core.call(String(body.method ?? ""), body.args, req.headers.get("x-session"));
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response("Forbidden", { status: 403 });
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    let status = 200;
    if (!existsSync(file)) {
      file = path.join(root, "404.html");
      status = 404;
      if (!existsSync(file)) return new Response("Not found", { status: 404 });
    }
    return new Response(new Uint8Array(readFileSync(file)), {
      status,
      headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-cache" },
    });
  };
}

/** Serve the handler on this computer only (127.0.0.1). Used by `npm run serve` and the browser tests. */
export function serve(core: Core, outDir: string, port: number): Promise<http.Server> {
  const handler = createHandler(core, outDir);
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
