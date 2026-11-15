import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { z, type ZodType } from "zod";
import { Db, migrate } from "./db";
import { AppError, localDate } from "./util";

export type Role = "owner" | "manager" | "cashier";
export interface User { id: number; username: string; display_name: string; role: Role }
export interface Ctx { db: Db; user: User; now: Date; today: string; core: Core }

type Access = Role[] | "public";
interface Handler { access: Access; input: ZodType; fn: (ctx: Ctx, input: never) => unknown; tx: boolean }
const handlers = new Map<string, Handler>();

export const ANYONE: Role[] = ["owner", "manager", "cashier"];
export const MANAGERS: Role[] = ["owner", "manager"];
export const OWNER: Role[] = ["owner"];

/** Register an API method. Every method validates its input and runs inside one database transaction. */
export function define<S extends ZodType>(name: string, access: Access, input: S, fn: (ctx: Ctx, input: z.output<S>) => unknown, opts: { tx?: boolean } = {}): void {
  if (handlers.has(name)) throw new Error(`duplicate method ${name}`);
  handlers.set(name, { access, input, fn: fn as Handler["fn"], tx: opts.tx ?? true });
}

// ------------------------------------------------------------------ passwords
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 32).toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, Buffer.from(salt, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}
export const zPassword = z.string().min(6, "Use at least 6 characters").max(100);

export function audit(ctx: Pick<Ctx, "db" | "user" | "now">, action: string, entity: string | null, entityId: number | null, details?: unknown): void {
  ctx.db.run("insert into audit_log (user_id, action, entity, entity_id, details, created_at) values (?, ?, ?, ?, ?, ?)",
    ctx.user.id || null, action, entity, entityId, details === undefined ? null : JSON.stringify(details), ctx.now.toISOString());
}

export const zApprover = z.object({ username: z.string(), password: z.string() }).nullish();
/**
 * Some actions need an owner or manager. A cashier can still do them when an owner/manager types
 * their own username and password into the approval box. Returns who authorised, or null if nobody could.
 */
export function authoriser(ctx: Ctx, approver?: { username: string; password: string } | null): User | null {
  if (ctx.user.role !== "cashier") return ctx.user;
  if (!approver) return null;
  const u = ctx.db.get<User & { password_hash: string; is_active: number }>("select * from users where username = ?", approver.username.trim());
  if (!u || !u.is_active || u.role === "cashier" || !verifyPassword(approver.password, u.password_hash)) {
    throw new AppError("The approver's username or password is not correct, or they are not an owner/manager.", "forbidden");
  }
  return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
}

export interface CoreOptions {
  dataDir: string;
  /** Injected in tests to control dates (expiry, financial year). */
  clock?: () => Date;
  /** Called before an existing database is upgraded, so a backup can be taken. */
  beforeUpgrade?: (dbFile: string, fromVersion: number) => void;
}

export class Core {
  db: Db;
  readonly dataDir: string;
  readonly dbFile: string;
  readonly clock: () => Date;
  private sessions = new Map<string, { userId: number; expires: number }>();
  private failures = new Map<string, { count: number; until: number }>();

  constructor(private opts: CoreOptions) {
    this.dataDir = opts.dataDir;
    this.clock = opts.clock ?? (() => new Date());
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    this.dbFile = path.join(this.dataDir, "ygpos.db");
    this.db = this.open();
  }

  private open(): Db {
    const db = new Db(this.dbFile);
    try {
      const check = db.get<{ integrity_check: string }>("pragma integrity_check");
      if (check?.integrity_check !== "ok") throw new Error(`The database file is damaged (${check?.integrity_check}). Restore the latest backup.`);
      migrate(db, (from) => {
        db.exec("pragma wal_checkpoint(truncate)"); // make sure the file on disk is complete before it is copied
        this.opts.beforeUpgrade?.(this.dbFile, from);
      });
    } catch (e) {
      db.close();
      throw e;
    }
    return db;
  }

  /** Close and reopen the database file (after a restore replaced it). Everyone is signed out. */
  reopen(): void {
    this.db.close();
    this.sessions.clear();
    this.db = this.open();
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- sessions
  startSession(userId: number): string {
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, { userId, expires: Date.now() + 16 * 3600_000 });
    return token;
  }
  endSession(token: string | null): void {
    if (token) this.sessions.delete(token);
  }
  endSessionsOf(userId: number): void {
    for (const [t, s] of this.sessions) if (s.userId === userId) this.sessions.delete(t);
  }
  private userFor(token: string | null): User | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s || s.expires < Date.now()) return null;
    const u = this.db.get<User & { is_active: number }>("select id, username, display_name, role, is_active from users where id = ?", s.userId);
    if (!u || !u.is_active) return null;
    return { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
  }

  /** Too many wrong passwords for one username: make them wait. */
  checkLockout(username: string): void {
    const f = this.failures.get(username.toLowerCase());
    if (f && f.until > Date.now()) throw new AppError(`Too many wrong attempts. Wait ${Math.ceil((f.until - Date.now()) / 1000)} seconds and try again.`, "auth");
  }
  noteLogin(username: string, ok: boolean): void {
    const key = username.toLowerCase();
    if (ok) return void this.failures.delete(key);
    const f = this.failures.get(key) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= 5) { f.until = Date.now() + 60_000; f.count = 0; }
    this.failures.set(key, f);
  }

  // ---------------------------------------------------------------- dispatch
  /** Run an API method. Never throws: failures come back as { ok: false, error }. */
  call(method: string, args: unknown, token: string | null): { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; data?: unknown } } {
    try {
      if (method === "auth.logout") {
        this.endSession(token);
        return { ok: true, data: null };
      }
      const h = handlers.get(method);
      if (!h) throw new AppError(`Unknown method ${method}`, "not_found");
      let user: User;
      if (h.access === "public") user = this.userFor(token) ?? { id: 0, username: "", display_name: "", role: "cashier" };
      else {
        const u = this.userFor(token);
        if (!u) throw new AppError("Please sign in again.", "auth");
        if (!h.access.includes(u.role)) throw new AppError("You do not have permission to do that.", "forbidden");
        user = u;
      }
      const parsed = h.input.safeParse(args ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        throw new AppError(first.path.length ? `${first.path.join(".")}: ${first.message}` : first.message, "invalid");
      }
      const now = this.clock();
      const ctx: Ctx = { db: this.db, user, now, today: localDate(now), core: this };
      // Backup and restore work on the database file itself and cannot run inside a transaction.
      const data = h.tx ? this.db.tx(() => h.fn(ctx, parsed.data as never)) : h.fn(ctx, parsed.data as never);
      return { ok: true, data: data === undefined ? null : data };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, data: e.data } };
      const msg = e instanceof Error ? e.message : String(e);
      // Constraint messages raised by our own triggers are already readable.
      if (/Countable products|cannot be edited|cannot be deleted/.test(msg)) return { ok: false, error: { code: "invalid", message: msg } };
      if (/UNIQUE constraint failed: products\.sku/.test(msg)) return { ok: false, error: { code: "conflict", message: "Another product already uses this SKU." } };
      if (/UNIQUE constraint failed: products\.barcode/.test(msg)) return { ok: false, error: { code: "conflict", message: "Another product already uses this barcode." } };
      if (/UNIQUE constraint failed: users\.username/.test(msg)) return { ok: false, error: { code: "conflict", message: "That username is already taken." } };
      if (/UNIQUE constraint failed/.test(msg)) return { ok: false, error: { code: "conflict", message: "That name is already in use." } };
      if (/FOREIGN KEY constraint failed/.test(msg)) return { ok: false, error: { code: "conflict", message: "This record is used elsewhere and cannot be removed." } };
      console.error(`[core] ${method} failed:`, e);
      return { ok: false, error: { code: "internal", message: `Something went wrong and nothing was saved. (${msg})` } };
    }
  }
}

export const methodNames = (): string[] => [...handlers.keys()];
