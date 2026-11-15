"use client";
// Keyboard-first search boxes for products and customers/suppliers.
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Input, cn } from "@/components/ui";
import { formatINR } from "@/lib/money";
import type { Product } from "@/lib/types";
import { formatStock } from "@/lib/units";

export const productLabel = (p: Pick<Product, "name" | "brand_name" | "pack_size">): string => [p.brand_name, p.name, p.pack_size].filter(Boolean).join(" ");

interface ComboProps<T> {
  items: T[]; text: (item: T) => string; keyOf: (item: T) => string | number; render: (item: T) => ReactNode;
  onPick: (item: T) => void; placeholder: string; label: string; inputRef?: Ref<HTMLInputElement>; autoFocus?: boolean;
  /** Extra matching, e.g. barcode. Return true for an exact hit that should be picked at once on Enter. */
  exact?: (item: T, q: string) => boolean; footer?: (q: string, close: () => void) => ReactNode; className?: string; max?: number;
}

/** Type to filter, ↑/↓ to move, Enter to pick, Esc to close. */
export function Combo<T>({ items, text, keyOf, render, onPick, placeholder, label, inputRef, autoFocus, exact, footer, className, max = 12 }: ComboProps<T>) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice(0, max);
    return items.filter((it) => { const t = text(it).toLowerCase(); return words.every((w) => t.includes(w)); }).slice(0, max);
  }, [items, q, text, max]);
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const pick = (it: T) => { onPick(it); setQ(""); setOpen(false); };
  return (
    <div ref={box} className={cn("relative", className)}>
      <Input ref={inputRef} autoFocus={autoFocus} role="combobox" aria-expanded={open} aria-label={label} placeholder={placeholder} autoComplete="off" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setIndex((i) => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
          else if (e.key === "Escape") { setOpen(false); setQ(""); }
          else if (e.key === "Enter") {
            e.preventDefault();
            const hit = exact && q.trim() ? items.find((it) => exact(it, q.trim())) : undefined;
            const chosen = hit ?? (open ? matches[index] : undefined);
            if (chosen) pick(chosen);
          }
        }} />
      {open && (matches.length > 0 || footer) && (
        <div className="absolute z-30 mt-1 max-h-80 w-full min-w-72 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl" role="listbox">
          {matches.map((it, i) => (
            <button key={keyOf(it)} type="button" role="option" aria-selected={i === index} onMouseEnter={() => setIndex(i)} onClick={() => pick(it)}
              className={cn("block w-full px-3 py-2 text-left text-sm", i === index && "bg-primary-soft")}>{render(it)}</button>
          ))}
          {matches.length === 0 && q.trim() && <div className="px-3 py-2 text-sm text-muted">Nothing matches “{q.trim()}”.</div>}
          {footer && <div className="border-t border-border p-1.5">{footer(q.trim(), () => { setOpen(false); setQ(""); })}</div>}
        </div>
      )}
    </div>
  );
}

export function ProductCombo({ products, onPick, inputRef, autoFocus, showPrice = true }: { products: Product[]; onPick: (p: Product) => void; inputRef?: Ref<HTMLInputElement>; autoFocus?: boolean; showPrice?: boolean }) {
  const active = useMemo(() => products.filter((p) => p.is_active), [products]);
  return (
    <Combo items={active} keyOf={(p) => p.id} onPick={onPick} inputRef={inputRef} autoFocus={autoFocus} label="Search products" max={15}
      placeholder="Type product name, brand, SKU — or scan a barcode  (F2)"
      text={(p) => [p.brand_name, p.name, p.flavour, p.pack_size, p.sku, p.barcode, p.category_name].filter(Boolean).join(" ")}
      exact={(p, q) => p.barcode === q || p.sku?.toLowerCase() === q.toLowerCase()}
      render={(p) => {
        const unit = p.units.find((u) => u.is_default_sale && u.is_active) ?? p.units[0];
        return (
          <span className="flex items-center justify-between gap-4">
            <span><span className="font-medium">{productLabel(p)}</span>{p.flavour && <span className="text-muted"> · {p.flavour}</span>}</span>
            <span className="num shrink-0 text-xs text-muted">
              <span className={p.sellable_m <= 0 ? "text-danger" : p.sellable_m <= p.low_stock_m ? "text-warn" : ""}>{formatStock(p.sellable_m, p.base_unit, p.units)}</span>
              {showPrice && unit && <> · {formatINR(unit.sale_price)}/{unit.name}</>}
            </span>
          </span>
        );
      }} />
  );
}
