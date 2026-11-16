// Backups: consistent copies of the database file, verified after writing, kept in two places.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, closeSync, fsyncSync, openSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MANAGERS, OWNER, audit, define, type Core } from "./core";
import { Db, latestVersion } from "./db";
import { AppError } from "./util";

export interface BackupInfo {
  file: string; name: string; size: number; taken_at: string; kind: string;
  schema_version: number; business_name: string; last_invoice: string | null; invoices: number; customer_dues: number; stock_value: number;
}

const NAME = /^ygpos-(\d{8})-(\d{6})-([a-z-]+)\.db$/;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const parseStamp = (name: string): Date | null => {
  const m = NAME.exec(name);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  return new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), Number(t.slice(0, 2)), Number(t.slice(2, 4)), Number(t.slice(4, 6)));
};

/** Figures that identify the state of a database: used to check a backup really matches. */
function fingerprint(db: Db) {
  const one = <T>(sql: string): T => db.get<T>(sql) as T;
  return {
    schema_version: db.version,
    business_name: one<{ v: string }>("select business_name as v from settings where id = 1").v,
    last_invoice: one<{ v: string | null }>("select (select invoice_no from sales order by id desc limit 1) as v").v,
    invoices: one<{ v: number }>("select count(*) as v from sales").v,
    customer_dues: one<{ v: number }>("select coalesce(sum(balance), 0) as v from customers").v,
    stock_value: one<{ v: number }>("select coalesce(sum(qty_m * cost4), 0) / 100000 as v from stock_batches").v,
  };
}

/** Open a backup file read-only and check it. Throws a readable error if it cannot be trusted. */
export function inspectBackup(file: string): BackupInfo {
  if (!existsSync(file)) throw new AppError("That backup file cannot be found.", "not_found");
  const size = statSync(file).size;
  let db: Db;
  try {
    db = new Db(file, { readOnly: true });
  } catch {
    throw new AppError("That file is not a YG POS backup.");
  }
  try {
    let check: string | undefined;
    try {
      check = db.get<{ integrity_check: string }>("pragma integrity_check")?.integrity_check;
    } catch {
      throw new AppError("That file is not a YG POS backup, or it is damaged.");
    }
    if (check !== "ok") throw new AppError("This backup file is damaged and cannot be used.");
    if (!db.get("select 1 from sqlite_master where type = 'table' and name = 'settings'")) throw new AppError("That file is not a YG POS backup.");
    if (db.version > latestVersion()) throw new AppError("This backup was made by a newer version of YG POS. Install the latest version of the app first.");
    const name = path.basename(file);
    const taken = parseStamp(name) ?? statSync(file).mtime;
    return { file, name, size, taken_at: taken.toISOString(), kind: NAME.exec(name)?.[3] ?? "file", ...fingerprint(db) };
  } finally {
    db.close();
  }
}

const backupDir = (core: Core) => path.join(core.dataDir, "backups");
const secondDir = (core: Core): string | null => core.db.get<{ value: string }>("select value from config where key = 'backup_dir_2'")?.value || null;
const setConfig = (core: Core, key: string, value: string) =>
  core.db.run("insert into config (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, value);

/**
 * Take a backup now. The copy is made by SQLite itself (consistent even while the app is in use),
 * then reopened and compared with the live data. A copy also goes to the second location if one is set.
 */
export function backupNow(core: Core, kind: "auto" | "manual" | "start" | "close" | "pre-restore" | "pre-upgrade" = "manual"): BackupInfo & { second: "ok" | "not_set" | "failed"; second_error?: string } {
  const dir = backupDir(core);
  mkdirSync(dir, { recursive: true });
  let when = core.clock();
  let file = path.join(dir, `ygpos-${stamp(when)}-${kind}.db`);
  while (existsSync(file)) { // two backups in the same second
    when = new Date(when.getTime() + 1000);
    file = path.join(dir, `ygpos-${stamp(when)}-${kind}.db`);
  }
  core.db.exec(`vacuum into '${file.replace(/'/g, "''")}'`);
  const info = inspectBackup(file);
  const live = fingerprint(core.db);
  if (JSON.stringify({ ...live }) !== JSON.stringify({ schema_version: info.schema_version, business_name: info.business_name, last_invoice: info.last_invoice, invoices: info.invoices, customer_dues: info.customer_dues, stock_value: info.stock_value })) {
    rmSync(file, { force: true });
    throw new Error("The backup did not match the live data and was discarded.");
  }
  let second: "ok" | "not_set" | "failed" = "not_set", secondError: string | undefined;
  const dir2 = secondDir(core);
  if (dir2) {
    try {
      mkdirSync(dir2, { recursive: true });
      const copy = path.join(dir2, info.name);
      copyFileSync(file, copy);
      inspectBackup(copy);
      second = "ok";
      setConfig(core, "last_backup_2_at", when.toISOString());
      prune(dir2, core.clock());
    } catch (e) {
      second = "failed";
      secondError = e instanceof Error ? e.message : String(e);
    }
  }
  setConfig(core, "last_backup_at", when.toISOString());
  setConfig(core, "last_backup_2_status", second + (secondError ? `: ${secondError}` : ""));
  prune(dir, core.clock());
  return { ...info, second, second_error: secondError };
}

/** Keep every backup for 7 days, one a day for 60 days, one a month for 2 years. Delete the rest. */
export function prune(dir: string, now: Date): string[] {
  const files = readdirSync(dir).map((name) => ({ name, at: parseStamp(name) })).filter((f): f is { name: string; at: Date } => !!f.at)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const seenDay = new Set<string>(), seenMonth = new Set<string>(), removed: string[] = [];
  for (const f of files) {
    const age = (now.getTime() - f.at.getTime()) / 86400_000;
    const day = f.name.slice(6, 14), month = f.name.slice(6, 12);
    let keep: boolean;
    if (age <= 7) keep = true;
    else if (age <= 60) keep = !seenDay.has(day);
    else if (age <= 730) keep = !seenMonth.has(month);
    else keep = false;
    seenDay.add(day);
    seenMonth.add(month);
    if (!keep) {
      rmSync(path.join(dir, f.name), { force: true });
      removed.push(f.name);
    }
  }
  return removed;
}

export function listBackups(core: Core): { name: string; file: string; size: number; taken_at: string; kind: string }[] {
  const dir = backupDir(core);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => ({ name, at: parseStamp(name) })).filter((f) => f.at)
    .sort((a, b) => b.at!.getTime() - a.at!.getTime())
    .map((f) => ({ name: f.name, file: path.join(dir, f.name), size: statSync(path.join(dir, f.name)).size, taken_at: f.at!.toISOString(), kind: NAME.exec(f.name)![3] }));
}

/**
 * Replace the live database with a backup.
 *  1. the backup is checked;  2. the current data is saved aside as a "pre-restore" backup;
 *  3. the backup is copied next to the live file and swapped in with one atomic rename, so a power
 *     cut at any moment leaves either the old database or the restored one — never a mixture.
 */
export function restoreBackup(core: Core, file: string): BackupInfo {
  const info = inspectBackup(file);
  const safety = backupNow(core, "pre-restore");
  const temp = `${core.dbFile}.restoring`;
  copyFileSync(file, temp);
  const fd = openSync(temp, "r+");
  fsyncSync(fd);
  closeSync(fd);
  inspectBackup(temp);
  core.db.close();
  try {
    for (const ext of ["-wal", "-shm"]) rmSync(core.dbFile + ext, { force: true });
    renameSync(temp, core.dbFile);
    core.reopen(); // also upgrades a backup from an older version
  } catch (e) {
    // Put back what was there before, then report the failure.
    for (const ext of ["-wal", "-shm"]) rmSync(core.dbFile + ext, { force: true });
    copyFileSync(safety.file, core.dbFile);
    core.reopen();
    throw new AppError(`The restore failed and your previous data was put back. (${e instanceof Error ? e.message : e})`);
  }
  return info;
}

/** Remove a half-finished restore copy left behind by a crash. The live database was never touched. */
export function cleanInterruptedRestore(dataDir: string): boolean {
  const temp = path.join(dataDir, "ygpos.db.restoring");
  if (!existsSync(temp)) return false;
  rmSync(temp, { force: true });
  return true;
}

export function backupStatus(core: Core) {
  const cfg = Object.fromEntries(core.db.all<{ key: string; value: string }>("select key, value from config where key like 'last_backup%' or key = 'backup_dir_2'").map((r) => [r.key, r.value]));
  const dir2 = cfg.backup_dir_2 || null;
  const last2 = cfg.last_backup_2_at ? new Date(cfg.last_backup_2_at).getTime() : 0;
  const now = core.clock().getTime();
  let warning: string | null = null;
  if (!dir2) warning = "No second backup location is set. If this computer's disk fails, backups stored on it are lost too. Choose a USB or external drive.";
  else if ((cfg.last_backup_2_status ?? "").startsWith("failed")) warning = "The last backup could not be copied to the second location. Check that the drive is connected.";
  else if (now - last2 > 26 * 3600_000) warning = "No backup has reached the second location for more than a day. Check that the drive is connected.";
  return { folder: backupDir(core), second_folder: dir2, last_backup_at: cfg.last_backup_at ?? null, last_backup_2_at: cfg.last_backup_2_at ?? null, warning, backups: listBackups(core).slice(0, 60) };
}

define("backup.status", MANAGERS, z.object({}), (ctx) => backupStatus(ctx.core), { tx: false });
define("backup.now", MANAGERS, z.object({}), (ctx) => {
  const r = backupNow(ctx.core, "manual");
  audit(ctx, "backup.manual", null, null, { name: r.name, second: r.second });
  return r;
}, { tx: false });
define("backup.inspect", OWNER, z.object({ file: z.string().min(1) }), (_ctx, a) => inspectBackup(a.file), { tx: false });
define("backup.restore", OWNER, z.object({ file: z.string().min(1) }), (ctx, a) => {
  const info = restoreBackup(ctx.core, a.file);
  audit({ db: ctx.core.db, user: ctx.user, now: ctx.now }, "backup.restore", null, null, { name: info.name, last_invoice: info.last_invoice });
  return info;
}, { tx: false });
