"use client";
import { FileDown, Printer } from "lucide-react";
import { useCallback, useState } from "react";
import { InvoiceA4, PrintJob, ReceiptThermal, type PrintRequest } from "@/components/documents";
import { Button } from "@/components/ui";
import { useApi } from "@/lib/api";
import { useShop } from "@/lib/session";
import type { Sale } from "@/lib/types";

export type PrintConfig = Partial<Record<"a4_printer" | "thermal_printer" | "thermal_width" | "default_paper" | "silent_print", string>>;

/** Runs one print/PDF job at a time. Returns the hidden job element to render, and a function to start a job. */
export function usePrinter() {
  const { data: config } = useApi<PrintConfig>("config.get");
  const [job, setJob] = useState<PrintRequest | null>(null);
  const done = useCallback(() => setJob(null), []);
  const start = useCallback((j: Omit<PrintRequest, "printer" | "silent">) => {
    const printer = j.paper === "a4" ? config?.a4_printer : config?.thermal_printer;
    setJob({ ...j, printer: printer || undefined, silent: config?.silent_print === "1" && !!printer });
  }, [config]);
  return { element: job ? <PrintJob job={job} onDone={done} /> : null, start, busy: !!job, config: config ?? {} };
}

/** Print A4 / thermal / save PDF for an invoice. */
export function SalePrintButtons({ sale, autoFocus }: { sale: Sale; autoFocus?: boolean }) {
  const { settings } = useShop();
  const printer = usePrinter();
  const width = printer.config.thermal_width === "58mm" ? "58mm" : "80mm";
  const file = `${sale.invoice_no.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
  return (
    <>
      <Button variant="primary" autoFocus={autoFocus} disabled={printer.busy} onClick={() => printer.start({ paper: "a4", mode: "print", content: <InvoiceA4 sale={sale} settings={settings} /> })}><Printer className="size-4" /> Print A4</Button>
      <Button disabled={printer.busy} onClick={() => printer.start({ paper: width, mode: "print", content: <ReceiptThermal sale={sale} settings={settings} width={width} /> })}><Printer className="size-4" /> Thermal</Button>
      <Button disabled={printer.busy} onClick={() => printer.start({ paper: "a4", mode: "pdf", filename: file, content: <InvoiceA4 sale={sale} settings={settings} /> })}><FileDown className="size-4" /> Save PDF</Button>
      {printer.element}
    </>
  );
}
