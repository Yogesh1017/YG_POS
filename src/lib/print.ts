"use client";
// Printing and PDF. Inside the desktop app these go through the app itself (chosen printer, real PDF
// file). In a plain browser (development / tests) they fall back to the browser's print dialog.
export type Paper = "a4" | "80mm" | "58mm";

export interface DesktopBridge {
  print(opts: { paper: Paper; printer?: string; silent?: boolean }): Promise<{ ok: boolean; error?: string }>;
  savePdf(opts: { paper: Paper; filename: string }): Promise<{ ok: boolean; file?: string; error?: string }>;
  printers(): Promise<{ name: string; label: string }[]>;
  pickFolder(): Promise<string | null>;
  pickBackupFile(): Promise<string | null>;
  openFolder(folder: string): Promise<void>;
  version(): Promise<string>;
}
declare global {
  interface Window { desktop?: DesktopBridge }
}
export const desktop = (): DesktopBridge | undefined => (typeof window === "undefined" ? undefined : window.desktop);
