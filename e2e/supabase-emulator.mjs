// TEST ONLY. A small stand-in for the two Supabase HTTP services the app talks to
// (PostgREST at /rest/v1 and Auth at /auth/v1), backed by a real local PostgreSQL database
// that has the real migrations applied. Every request runs as the "authenticated" (or "anon")
// database role with the caller's user id in the JWT claims, so Row Level Security and the
// SQL functions behave exactly as in production. It implements only the request shapes this
// app uses; it is not a general PostgREST and performs no real password hashing or JWT signing.
import http from "node:http";
import { randomUUID } from "node:crypto";

const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Object.assign(new Error(`bad identifier ${s}`), { status: 400 });
  return `"${s}"`;
};
const EMBEDS = {
  businesses: (t) => `(select to_jsonb(e) from public.businesses e where e.id = ${t}.business_id)`,
  sale_items: (t) => `(select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.sale_items e where e.sale_id = ${t}.id)`,
  payments: (t) => `(select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.payments e where e.sale_id = ${t}.id)`,
  sale_returns: (t) => `(select coalesce(jsonb_agg(to_jsonb(e)), '[]') from public.sale_returns e where e.sale_id = ${t}.id)`,
};
const OPS = { eq: "=", gte: ">=", lte: "<=", gt: ">", lt: "<", ilike: "ilike", neq: "<>" };

function condition(col, expr, params) {
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot), value = expr.slice(dot + 1);
  if (op === "is") return `t.${ident(col)} is ${value === "null" ? "null" : value === "true" ? "true" : "false"}`;
  if (!OPS[op]) throw Object.assign(new Error(`unsupported operator ${op}`), { status: 400 });
  params.push(op === "ilike" ? value.replaceAll("*", "%") : value);
  const n = `$${params.length}`;
  if (op === "ilike") return `t.${ident(col)} ilike ${n}`;
  if (op === "eq" || op === "neq") return `t.${ident(col)}::text ${OPS[op]} ${n}`;
  return `t.${ident(col)} ${OPS[op]} ${n}::timestamptz`; // range filters are only used on timestamps
}

function whereClause(query, params) {
  const parts = [];
  for (const [k, v] of query) {
    if (["select", "order", "limit", "offset", "columns", "on_conflict"].includes(k)) continue;
    if (k === "or") {
      const inner = v.slice(1, -1).split(",").map((c) => {
        const i = c.indexOf(".");
        return condition(c.slice(0, i), c.slice(i + 1), params);
      });
      parts.push(`(${inner.join(" or ")})`);
    } else parts.push(condition(k, v, params));
  }
  return parts.length ? `where ${parts.join(" and ")}` : "";
}

export function startEmulator({ pool, port }) {
  const passwords = new Map(); // email -> password (test accounts only)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sessionFor = (user) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return {
      access_token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", exp })}.test`,
      token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: `refresh-${user.id}`,
      user: { id: user.id, email: user.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    };
  };
  const uidOf = (req) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? null; } catch { return null; }
  };

  async function asUser(uid, fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local role ${uid ? "authenticated" : "anon"}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [uid ? JSON.stringify({ sub: uid }) : ""]);
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async function rest(req, url, body) {
    const uid = uidOf(req);
    const seg = url.pathname.split("/").filter(Boolean); // rest, v1, table | rpc, fn
    const prefer = req.headers.prefer ?? "";
    const single = (req.headers.accept ?? "").includes("vnd.pgrst.object");
    const finish = (rowsOut, extraHeaders = {}) => {
      if (single) {
        if (rowsOut.length !== 1) return { status: 406, json: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rowsOut.length} rows` } };
        return { status: 200, json: rowsOut[0], headers: extraHeaders };
      }
      return { status: 200, json: rowsOut, headers: extraHeaders };
    };

    if (seg[2] === "rpc") {
      const args = body ?? {};
      const keys = Object.keys(args);
      const sql = `select to_jsonb(public.${ident(seg[3])}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")})) as r`;
      const r = await asUser(uid, (c) => c.query(sql, keys.map((k) => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k]))));
      return { status: 200, json: r.rows[0].r };
    }

    const table = `public.${ident(seg[2])}`;
    const params = [];
    if (req.method === "GET") {
      const where = whereClause(url.searchParams, params);
      const embeds = [...(url.searchParams.get("select") ?? "").matchAll(/([a-z_]+)\(\*\)/g)].map((m) => m[1]);
      const cols = ["t.*", ...embeds.map((e) => `${EMBEDS[e]("t")} as ${ident(e)}`)].join(", ");
      const order = (url.searchParams.get("order") ?? "").split(",").filter(Boolean).map((o) => {
        const [c, dir] = o.split(".");
        return `t.${ident(c)} ${dir === "desc" ? "desc" : "asc"}`;
      });
      const limit = url.searchParams.get("limit"), offset = url.searchParams.get("offset");
      const sql = `select coalesce(jsonb_agg(to_jsonb(q)), '[]') as rows, (select count(*) from ${table} t ${where}) as total from (
        select ${cols} from ${table} t ${where} ${order.length ? `order by ${order.join(", ")}` : ""} ${limit ? `limit ${Number(limit)}` : ""} ${offset ? `offset ${Number(offset)}` : ""}) q`;
      const r = await asUser(uid, (c) => c.query(sql, params));
      const out = r.rows[0].rows;
      return finish(out, { "content-range": `0-${Math.max(out.length - 1, 0)}/${r.rows[0].total}` });
    }
    if (req.method === "POST") {
      const row = Array.isArray(body) ? body[0] : body;
      const cols = Object.keys(row).map(ident).join(", ");
      const sql = `insert into ${table} as t (${cols}) select ${cols} from jsonb_populate_record(null::${table}, $1::jsonb) returning to_jsonb(t.*) as row`;
      const r = await asUser(uid, (c) => c.query(sql, [JSON.stringify(row)]));
      return prefer.includes("return=representation") ? { ...finish(r.rows.map((x) => x.row)), status: 201 } : { status: 201, json: null };
    }
    if (req.method === "PATCH") {
      params.push(JSON.stringify(body));
      const where = whereClause(url.searchParams, params);
      const sets = Object.keys(body).map((k) => `${ident(k)} = r.${ident(k)}`).join(", ");
      const sql = `update ${table} as t set ${sets} from jsonb_populate_record(null::${table}, $1::jsonb) r ${where} returning to_jsonb(t.*) as row`;
      const r = await asUser(uid, (c) => c.query(sql, params));
      return prefer.includes("return=representation") ? finish(r.rows.map((x) => x.row)) : { status: 204, json: null };
    }
    if (req.method === "DELETE") {
      const where = whereClause(url.searchParams, params);
      if (!where) throw Object.assign(new Error("refusing unfiltered delete"), { status: 400 });
      const r = await asUser(uid, (c) => c.query(`delete from ${table} as t ${where} returning to_jsonb(t.*) as row`, params));
      return prefer.includes("return=representation") ? finish(r.rows.map((x) => x.row)) : { status: 204, json: null };
    }
    return { status: 405, json: { message: "method not supported by the test emulator" } };
  }

  async function auth(req, url, body) {
    const route = url.pathname.replace("/auth/v1", "");
    if (route === "/signup" && req.method === "POST") {
      const email = String(body.email).toLowerCase();
      if (passwords.has(email)) return { status: 422, json: { code: 422, error_code: "user_already_exists", msg: "User already registered" } };
      const { rows } = await pool.query("insert into auth.users (id, email) values ($1, $2) returning id, email", [randomUUID(), email]);
      passwords.set(email, body.password);
      return { status: 200, json: sessionFor(rows[0]) };
    }
    if (route === "/token" && req.method === "POST") {
      if (url.searchParams.get("grant_type") === "refresh_token") {
        const id = String(body.refresh_token).replace("refresh-", "");
        const { rows } = await pool.query("select id, email from auth.users where id = $1", [id]);
        return rows[0] ? { status: 200, json: sessionFor(rows[0]) } : { status: 400, json: { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" } };
      }
      const email = String(body.email).toLowerCase();
      if (passwords.get(email) !== body.password) return { status: 400, json: { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" } };
      const { rows } = await pool.query("select id, email from auth.users where email = $1", [email]);
      return { status: 200, json: sessionFor(rows[0]) };
    }
    if (route === "/user") {
      const { rows } = await pool.query("select id, email from auth.users where id = $1", [uidOf(req)]);
      if (!rows[0]) return { status: 401, json: { msg: "invalid JWT" } };
      if (req.method === "PUT" && body?.password) passwords.set(rows[0].email, body.password);
      return { status: 200, json: sessionFor(rows[0]).user };
    }
    if (route === "/logout") return { status: 204, json: null };
    return { status: 404, json: { msg: "not implemented in the test emulator" } };
  }

  const server = http.createServer(async (req, res) => {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-expose-headers": "content-range" };
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
    const url = new URL(req.url, `http://${req.headers.host}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let out;
    try {
      const body = raw ? JSON.parse(raw) : null;
      out = url.pathname.startsWith("/auth/v1") ? await auth(req, url, body) : await rest(req, url, body);
    } catch (e) {
      const status = e.status ?? (e.code === "42501" ? 403 : e.code === "23505" || e.code === "23503" ? 409 : 400);
      out = { status, json: { code: e.code ?? "TEST", message: e.message, details: e.detail ?? null, hint: e.hint ?? null } };
      if (!e.code) console.error("[emulator]", req.method, req.url, e.message);
    }
    res.writeHead(out.status, { ...cors, "content-type": "application/json", ...(out.headers ?? {}) });
    res.end(out.json === null || out.json === undefined ? "" : JSON.stringify(out.json));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
