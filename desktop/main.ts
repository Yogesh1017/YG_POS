// YG POS desktop shell. Owns the window, the local database (through the core), printing, PDF
// export and the automatic backup schedule. Nothing here uses the internet or opens a network port:
// the interface is served over the app's own private app:// address.
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { backupNow, createCore, type Core } from "./core";
import { createHandler } from "./server";

const ORIGIN = "app://ygpos";
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let core: Core | null = null;
let win: BrowserWindow | null = null;
let backupTimer: NodeJS.Timeout | null = null;

const dataDir = () => process.env.YGPOS_DATA ?? path.join(app.getPath("userData"), "data");
const isSetUp = () => !!core?.db.get<{ n: number }>("select setup_complete as n from settings where id = 1")?.n;

function autoBackup(kind: "start" | "auto" | "close"): void {
  try {
    if (core && isSetUp()) backupNow(core, kind);
  } catch (e) {
    console.error(`Backup (${kind}) failed:`, e);
  }
}

type Paper = "a4" | "80mm" | "58mm";
// Page sizes in microns. Thermal rolls are continuous; the height is a generous maximum.
const pageSize = (paper: Paper) => (paper === "a4" ? ("A4" as const) : { width: paper === "58mm" ? 58000 : 80000, height: 297000 });

function registerIpc(): void {
  ipcMain.handle("desktop:print", (_e, opts: { paper: Paper; printer?: string; silent?: boolean }) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      if (!win) return resolve({ ok: false, error: "no window" });
      win.webContents.print(
        { silent: !!opts.silent && !!opts.printer, deviceName: opts.printer || undefined, printBackground: true, pageSize: pageSize(opts.paper), margins: { marginType: opts.paper === "a4" ? "default" : "none" } },
        (success, reason) => resolve(success ? { ok: true } : { ok: false, error: reason || "cancelled" }),
      );
    }));
  ipcMain.handle("desktop:savePdf", async (_e, opts: { paper: Paper; filename: string }) => {
    if (!win) return { ok: false, error: "no window" };
    const target = process.env.YGPOS_PDF_DIR
      ? { canceled: false, filePath: path.join(process.env.YGPOS_PDF_DIR, path.basename(opts.filename)) }   // automated tests: no dialog
      : await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath("documents"), path.basename(opts.filename)), filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (target.canceled || !target.filePath) return { ok: false };
    try {
      const pdf = await win.webContents.printToPDF({ pageSize: pageSize(opts.paper), printBackground: true, preferCSSPageSize: true });
      writeFileSync(target.filePath, pdf);
      return { ok: true, file: target.filePath };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle("desktop:printers", async () => (win ? (await win.webContents.getPrintersAsync()).map((p) => ({ name: p.name, label: p.displayName || p.name })) : []));
  ipcMain.handle("desktop:pickFolder", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Choose the second backup location", properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("desktop:pickBackupFile", async () => {
    const r = await dialog.showOpenDialog(win!, { title: "Choose a YG POS backup file", properties: ["openFile"], filters: [{ name: "YG POS backup", extensions: ["db"] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("desktop:openFolder", (_e, folder: string) => void shell.openPath(folder));
  ipcMain.handle("desktop:version", () => app.getVersion());
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1366, height: 800, minWidth: 1024, minHeight: 640, show: false, title: "YG POS", backgroundColor: "#f4f2ec",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // The window only ever shows the app itself.
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(ORIGIN)) e.preventDefault(); });
  win.once("ready-to-show", () => { win?.maximize(); win?.show(); });
  win.on("closed", () => { win = null; });
  void win.loadURL(`${ORIGIN}/`);
}

if (!app.requestSingleInstanceLock()) {
  // A second copy would open the same database file; bring the first one forward instead.
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  void app.whenReady().then(() => {
    try {
      core = createCore({ dataDir: dataDir() });
    } catch (e) {
      dialog.showErrorBox("YG POS cannot open its data", `${e instanceof Error ? e.message : e}\n\nData folder: ${dataDir()}\nBackups are in the "backups" folder inside it. Do not delete anything; contact whoever supports this software.`);
      app.exit(1);
      return;
    }
    const handler = createHandler(core, path.join(app.getAppPath(), "out"));
    protocol.handle("app", (request) => handler(request));
    registerIpc();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }] },
      { label: "Help", submenu: [{ label: "Open data folder", click: () => void shell.openPath(dataDir()) }, { label: `Version ${app.getVersion()}`, enabled: false }] },
    ]));
    createWindow();
    autoBackup("start");
    backupTimer = setInterval(() => autoBackup("auto"), 2 * 3600_000);
  });
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => {
    if (backupTimer) clearInterval(backupTimer);
    autoBackup("close");
    core?.close();
    core = null;
  });
}
