// Runs YG POS without the desktop shell: `npm run serve`, then open http://127.0.0.1:3210 in a browser.
// Same core, same database file format. Printing uses the browser's print dialog in this mode.
import path from "node:path";
import { createCore, backupNow } from "./core";
import { serve } from "./server";

const dataDir = path.resolve(process.env.YGPOS_DATA ?? ".data");
const port = Number(process.env.YGPOS_PORT ?? 3210);
const core = createCore({ dataDir });
void serve(core, path.resolve(process.env.YGPOS_OUT ?? "out"), port).then(() => console.log(`YG POS is running at http://127.0.0.1:${port}  (data: ${dataDir})`));
const stop = () => {
  try {
    if (core.db.get<{ n: number }>("select setup_complete as n from settings")?.n) backupNow(core, "close");
  } catch (e) {
    console.error("Backup on close failed:", e);
  }
  core.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
