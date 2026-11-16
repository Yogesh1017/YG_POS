// The YG POS core: everything that touches the database. The window (and the tests) talk to it
// only through core.call(method, args, token).
import path from "node:path";
import { copyFileSync, mkdirSync } from "node:fs";
import { Core, type CoreOptions } from "./core";
import { cleanInterruptedRestore } from "./backup";
import "./auth";
import "./catalog";
import "./stock";
import "./parties";
import "./sales";
import "./purchases";
import "./reports";
import "./backup";

export { Core, methodNames } from "./core";
export type { Role, User } from "./core";
export { backupNow, backupStatus, inspectBackup, listBackups, prune, restoreBackup } from "./backup";
export { latestVersion } from "./db";

export function createCore(opts: CoreOptions): Core {
  cleanInterruptedRestore(opts.dataDir);
  return new Core({
    // Before a newer app version changes an existing database, keep a plain copy of the file as it was.
    beforeUpgrade: (dbFile, from) => {
      const dir = path.join(opts.dataDir, "backups");
      mkdirSync(dir, { recursive: true });
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      copyFileSync(dbFile, path.join(dir, `ygpos-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-pre-upgrade.db`));
      void from;
    },
    ...opts,
  });
}
