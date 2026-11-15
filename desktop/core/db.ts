import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

type Row = Record<string, unknown>;

/** Thin wrapper over the SQLite file: prepared-statement cache and nestable transactions. */
export class Db {
  readonly raw: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly file: string, opts: { readOnly?: boolean } = {}) {
    this.raw = new DatabaseSync(file, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) {
      this.raw.exec("pragma journal_mode = wal");   // readers never block the writer; crash-safe
      this.raw.exec("pragma synchronous = full");   // a committed bill survives a power cut
    }
    this.raw.exec("pragma foreign_keys = on");
    this.raw.exec("pragma busy_timeout = 5000");
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const r = this.stmt(sql).get(...params);
    return r ? ({ ...r } as T) : undefined;
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params).map((r) => ({ ...r })) as T[];
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Run fn as one atomic unit: either everything it wrote is saved, or nothing is. Nesting is allowed. */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? "begin immediate" : `savepoint ${name}`);
    this.depth += 1;
    try {
      const out = fn();
      this.depth -= 1;
      this.raw.exec(this.depth === 0 ? "commit" : `release ${name}`);
      return out;
    } catch (e) {
      this.depth -= 1;
      try {
        this.raw.exec(this.depth === 0 ? "rollback" : `rollback to ${name}; release ${name}`);
      } catch { /* the original error matters more */ }
      throw e;
    }
  }

  get version(): number {
    return Number((this.raw.prepare("pragma user_version").get() as { user_version: number }).user_version);
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}

/** The schema version this build of the app expects. */
export const latestVersion = (): number => MIGRATIONS.length;

/**
 * Bring the database up to the current schema. Each migration runs in its own transaction together
 * with the version bump, so a failure leaves the previous version intact. `beforeUpgrade` is called
 * once when an existing database (with data) is about to change, so a backup can be taken first.
 */
export function migrate(db: Db, beforeUpgrade?: (from: number) => void): void {
  const current = db.version;
  const LATEST_VERSION = latestVersion();
  if (current > LATEST_VERSION) {
    throw new Error(`This database was written by a newer version of YG POS (schema ${current}). Install the latest version of the app.`);
  }
  if (current === LATEST_VERSION) return;
  if (current > 0) beforeUpgrade?.(current);
  for (let v = current; v < LATEST_VERSION; v++) {
    db.tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
    });
  }
}
