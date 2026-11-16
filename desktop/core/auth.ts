import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ANYONE, OWNER, audit, define, hashPassword, verifyPassword, zPassword, type User } from "./core";
import { AppError, isValidGstin, zBool, zBoolD, zId, zOptText, zState, zText } from "./util";

const zUsername = z.string().trim().min(3, "Use at least 3 characters").max(30).regex(/^[a-zA-Z0-9._-]+$/, "Letters, digits, dot, dash and underscore only");
const zRole = z.enum(["manager", "cashier"]);

export const zBusiness = z.object({
  business_name: zText(120).min(1, "Business name is required"),
  legal_name: zOptText(160), phone: zOptText(20), email: zOptText(160), address: zOptText(400), city: zOptText(80),
  pincode: zOptText(6).refine((v) => v === null || /^[1-9][0-9]{5}$/.test(v), "PIN code has 6 digits"),
  state_code: zState,
  gst_registered: zBool,
  gstin: zOptText(40).transform((v) => (v ? v.toUpperCase().replace(/[^0-9A-Z]/g, "") || null : null)),
  default_tax_rate_bp: z.number().int().min(0).max(10000).default(0),
  prices_include_tax: zBoolD(false),
  round_off_total: zBoolD(true),
  invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, "1–6 letters or digits").refine((v) => v !== "CN", "CN is reserved for credit notes").default("INV"),
  invoice_terms: zOptText(600), bank_details: zOptText(400), receipt_footer: zOptText(300),
}).superRefine((v, ctx) => {
  if (!v.gst_registered) return;
  if (!v.state_code) ctx.addIssue({ code: "custom", path: ["state_code"], message: "Select your state" });
  if (!v.gstin || !isValidGstin(v.gstin)) ctx.addIssue({ code: "custom", path: ["gstin"], message: "Enter a valid 15-character GSTIN — check each character" });
  else if (v.state_code && v.gstin.slice(0, 2) !== v.state_code) ctx.addIssue({ code: "custom", path: ["gstin"], message: "The first two digits of the GSTIN must match the state" });
});

const BUSINESS_COLS = ["business_name", "legal_name", "phone", "email", "address", "city", "pincode", "state_code", "gst_registered", "gstin",
  "default_tax_rate_bp", "prices_include_tax", "round_off_total", "invoice_prefix", "invoice_terms", "bank_details", "receipt_footer"] as const;

const newRecoveryKey = (): string => randomBytes(10).toString("hex").toUpperCase().match(/.{4}/g)!.join("-");
const publicSettings = "select business_name, legal_name, phone, email, address, city, pincode, state_code, gst_registered, gstin, default_tax_rate_bp, prices_include_tax, round_off_total, invoice_prefix, invoice_terms, bank_details, receipt_footer, setup_complete from settings where id = 1";

define("app.status", "public", z.object({}), (ctx) => {
  const s = ctx.db.get<{ setup_complete: number; business_name: string }>("select setup_complete, business_name from settings where id = 1")!;
  return { setup_complete: !!s.setup_complete, business_name: s.business_name, user: ctx.user.id ? ctx.user : null };
});

// First run only: creates the owner account and the business profile.
define("setup.create", "public", z.object({ username: zUsername, display_name: zText(80).min(1), password: zPassword, business: zBusiness }), (ctx, a) => {
  const s = ctx.db.get<{ setup_complete: number }>("select setup_complete from settings where id = 1")!;
  if (s.setup_complete) throw new AppError("This computer is already set up. Sign in instead.", "conflict");
  const { id } = ctx.db.run("insert into users (username, display_name, role, password_hash, created_at) values (?, ?, 'owner', ?, ?)",
    a.username, a.display_name, hashPassword(a.password), ctx.now.toISOString());
  const key = newRecoveryKey();
  ctx.db.run(`update settings set ${BUSINESS_COLS.map((c) => `${c} = ?`).join(", ")}, setup_complete = 1, recovery_hash = ? where id = 1`,
    ...BUSINESS_COLS.map((c) => a.business[c]), hashPassword(key));
  const user: User = { id, username: a.username, display_name: a.display_name, role: "owner" };
  audit({ ...ctx, user }, "setup.create", "user", id);
  return { token: ctx.core.startSession(id), user, recovery_key: key };
});

define("auth.login", "public", z.object({ username: z.string().trim().min(1), password: z.string().min(1) }), (ctx, a) => {
  ctx.core.checkLockout(a.username);
  const u = ctx.db.get<User & { password_hash: string; is_active: number }>("select * from users where username = ?", a.username);
  const ok = !!u && !!u.is_active && verifyPassword(a.password, u.password_hash);
  ctx.core.noteLogin(a.username, ok);
  if (!ok) throw new AppError("Wrong username or password.", "auth");
  return { token: ctx.core.startSession(u!.id), user: { id: u!.id, username: u!.username, display_name: u!.display_name, role: u!.role } };
});

define("auth.changePassword", ANYONE, z.object({ current: z.string(), next: zPassword }), (ctx, a) => {
  const u = ctx.db.get<{ password_hash: string }>("select password_hash from users where id = ?", ctx.user.id)!;
  if (!verifyPassword(a.current, u.password_hash)) throw new AppError("Your current password is not correct.", "auth");
  ctx.db.run("update users set password_hash = ? where id = ?", hashPassword(a.next), ctx.user.id);
  audit(ctx, "auth.change_password", "user", ctx.user.id);
});

// The owner forgot their password: the recovery key printed at setup resets it. A new key is issued.
define("auth.recover", "public", z.object({ recovery_key: z.string().trim().min(1), password: zPassword }), (ctx, a) => {
  ctx.core.checkLockout("__recovery__");
  const s = ctx.db.get<{ recovery_hash: string | null }>("select recovery_hash from settings where id = 1")!;
  const ok = !!s.recovery_hash && verifyPassword(a.recovery_key.toUpperCase(), s.recovery_hash);
  ctx.core.noteLogin("__recovery__", ok);
  if (!ok) throw new AppError("That recovery key is not correct.", "auth");
  const owner = ctx.db.get<User>("select id, username, display_name, role from users where role = 'owner' order by id limit 1")!;
  const key = newRecoveryKey();
  ctx.db.run("update users set password_hash = ?, is_active = 1 where id = ?", hashPassword(a.password), owner.id);
  ctx.db.run("update settings set recovery_hash = ? where id = 1", hashPassword(key));
  ctx.core.endSessionsOf(owner.id);
  audit({ ...ctx, user: owner }, "auth.recover", "user", owner.id);
  return { username: owner.username, recovery_key: key };
});

define("settings.get", ANYONE, z.object({}), (ctx) => ctx.db.get(publicSettings));
define("settings.update", OWNER, zBusiness, (ctx, a) => {
  ctx.db.run(`update settings set ${BUSINESS_COLS.map((c) => `${c} = ?`).join(", ")} where id = 1`, ...BUSINESS_COLS.map((c) => a[c]));
  audit(ctx, "settings.update", "settings", 1);
  return ctx.db.get(publicSettings);
});

// Per-computer preferences. Only known keys are accepted.
const CONFIG_KEYS = ["a4_printer", "thermal_printer", "thermal_width", "default_paper", "silent_print", "backup_dir_2"] as const;
define("config.get", ANYONE, z.object({}), (ctx) =>
  Object.fromEntries(ctx.db.all<{ key: string; value: string }>("select key, value from config").map((r) => [r.key, r.value])));
define("config.set", ANYONE, z.object({ key: z.enum(CONFIG_KEYS), value: z.string().max(500) }), (ctx, a) => {
  if (a.key === "backup_dir_2" && ctx.user.role !== "owner") throw new AppError("Only the owner can change backup settings.", "forbidden");
  ctx.db.run("insert into config (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", a.key, a.value);
});

define("users.list", OWNER, z.object({}), (ctx) => ctx.db.all("select id, username, display_name, role, is_active, created_at from users order by id"));
define("users.create", OWNER, z.object({ username: zUsername, display_name: zText(80).min(1), role: zRole, password: zPassword }), (ctx, a) => {
  const { id } = ctx.db.run("insert into users (username, display_name, role, password_hash, created_at) values (?, ?, ?, ?, ?)",
    a.username, a.display_name, a.role, hashPassword(a.password), ctx.now.toISOString());
  audit(ctx, "user.create", "user", id, { role: a.role });
  return { id };
});
define("users.update", OWNER, z.object({ id: zId, display_name: zText(80).min(1), role: zRole, is_active: zBool, password: zPassword.nullish() }), (ctx, a) => {
  const u = ctx.db.get<User>("select id, role from users where id = ?", a.id);
  if (!u) throw new AppError("User not found.", "not_found");
  if (u.role === "owner") throw new AppError("The owner account cannot be changed here.", "forbidden");
  ctx.db.run("update users set display_name = ?, role = ?, is_active = ? where id = ?", a.display_name, a.role, a.is_active, a.id);
  if (a.password) ctx.db.run("update users set password_hash = ? where id = ?", hashPassword(a.password), a.id);
  if (!a.is_active || a.password) ctx.core.endSessionsOf(a.id);
  audit(ctx, "user.update", "user", a.id, { role: a.role, is_active: a.is_active, password_reset: !!a.password });
});

define("audit.list", OWNER, z.object({ limit: z.number().int().min(1).max(500).default(200) }), (ctx, a) =>
  ctx.db.all("select a.*, u.display_name as user_name from audit_log a left join users u on u.id = a.user_id order by a.id desc limit ?", a.limit));
