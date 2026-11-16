"use client";
import { Package, Pencil, Plus, Tags, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { productLabel } from "@/components/pickers";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, td, th } from "@/components/ui";
import { api, errorText, useApi } from "@/lib/api";
import { COMMON_GST_RATES } from "@/lib/gst";
import { formatINR, paiseToDecimal, parseQty, parseRupees } from "@/lib/money";
import { useShop } from "@/lib/session";
import type { Named, Product, Tier } from "@/lib/types";
import { formatQtyM, formatStock } from "@/lib/units";

export function ProductsScreen() {
  return <ManagersOnly><Products /></ManagersOnly>;
}

function Products() {
  const { gst } = useShop();
  const products = useApi<Product[]>("products.list");
  const brands = useApi<Named[]>("brands.list");
  const categories = useApi<Named[]>("categories.list");
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [lists, setLists] = useState<"brands" | "categories" | null>(null);

  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (products.data ?? []).filter((p) => {
      const text = [p.brand_name, p.name, p.flavour, p.pack_size, p.sku, p.barcode].filter(Boolean).join(" ").toLowerCase();
      return (showInactive || p.is_active) && (!brand || String(p.brand_id) === brand) && (!category || String(p.category_id) === category) && words.every((w) => text.includes(w));
    });
  }, [products.data, q, brand, category, showInactive]);

  if (!products.data || !brands.data || !categories.data) return <Spinner />;
  return (
    <Page>
      <PageHeader title="Products" description={`${products.data.filter((p) => p.is_active).length} active products`} actions={
        <>
          <Button onClick={() => setLists("brands")}><Tags className="size-4" /> Brands</Button>
          <Button onClick={() => setLists("categories")}><Tags className="size-4" /> Categories</Button>
          <Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> Add product</Button>
        </>
      } />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search name, brand, flavour, SKU, barcode" aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-40" aria-label="Brand" value={brand} onChange={(e) => setBrand(e.target.value)}><option value="">All brands</option>{brands.data.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
        <Select className="w-44" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All categories</option>{categories.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Package />} title={products.data.length === 0 ? "No products yet" : "No products match"} action={products.data.length === 0 ? <Button variant="primary" onClick={() => setEditing("new")}>Add your first product</Button> : undefined}>
            {products.data.length === 0 ? "Add each item you sell, with how it is packed (pieces in a box, boxes in a carton) and its rates." : "Try a different search or filter."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr>
                <th className={th}>Product</th><th className={th}>Category</th><th className={th}>Packing and rates</th>{gst && <th className={`${th} text-right`}>GST</th>}<th className={`${th} text-right`}>Stock</th><th className={th}><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.id} className={p.is_active ? "" : "opacity-60"}>
                    <td className={td}>
                      <div className="font-medium">{productLabel(p)} {!p.is_active && <Badge>Inactive</Badge>}</div>
                      <div className="num text-xs text-muted">{[p.flavour, p.sku && `SKU ${p.sku}`, p.barcode, p.hsn_code && `HSN ${p.hsn_code}`].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className={`${td} text-muted`}>{p.category_name}</td>
                    <td className={`${td} num text-xs`}>
                      {p.units.filter((u) => u.is_active).map((u) => (
                        <div key={u.id}><span className="font-medium">{u.name}</span>{!u.is_base && <span className="text-muted"> = {formatQtyM(u.factor_m)} {p.base_unit}</span>} · {formatINR(u.sale_price)}{u.tiers.length > 0 && <span className="text-primary"> · {u.tiers.length} qty price{u.tiers.length > 1 ? "s" : ""}</span>}</div>
                      ))}
                    </td>
                    {gst && <td className={`${td} num text-right text-muted`}>{p.tax_rate_bp / 100}%{p.price_includes_tax ? " incl." : ""}</td>}
                    <td className={`${td} num text-right`}><span className={p.sellable_m <= 0 ? "text-danger" : p.sellable_m <= p.low_stock_m ? "text-warn" : ""}>{formatStock(p.on_hand_m, p.base_unit, p.units)}</span></td>
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <Button size="sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></Button>
                      <Button size="sm" variant="ghost" aria-label={`Delete ${p.name}`} onClick={() => setDeleting(p)}><Trash2 className="size-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ProductDialog product={editing === "new" ? null : editing} brands={brands.data} categories={categories.data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void products.reload(); }} />}
      <ConfirmDialog open={!!deleting} danger title="Delete product?" confirmLabel="Delete" onClose={() => setDeleting(null)}
        message={<>Delete <b>{deleting?.name}</b>? Products with stock or invoice history cannot be deleted — mark those inactive instead.</>}
        onConfirm={async () => {
          try { await api("products.delete", { id: deleting!.id }); toast.success("Product deleted"); setDeleting(null); void products.reload(); }
          catch (e) { toast.error(errorText(e)); }
        }} />
      {lists && <NamedListDialog kind={lists} items={lists === "brands" ? brands.data : categories.data} onClose={() => setLists(null)} onChanged={() => { void brands.reload(); void categories.reload(); void products.reload(); }} />}
    </Page>
  );
}

interface TierRow { min: string; price: string }
interface UnitRow { id: number | null; name: string; contains: string; of: number; price: string; active: boolean; tiers: TierRow[] }
const tierRows = (t: Tier[]): TierRow[] => t.map((x) => ({ min: formatQtyM(x.min_qty_m), price: paiseToDecimal(x.price) }));

function TierEditor({ unit, tiers, onChange }: { unit: string; tiers: TierRow[]; onChange: (t: TierRow[]) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
      {tiers.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1">
          from <input aria-label={`Minimum ${unit} for quantity price ${i + 1}`} className="num h-6 w-14 rounded border border-border bg-surface px-1 text-right text-text" inputMode="decimal" value={t.min} onChange={(e) => onChange(tiers.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} />
          {unit}: ₹ <input aria-label={`Rate for quantity price ${i + 1} of ${unit}`} className="num h-6 w-20 rounded border border-border bg-surface px-1 text-right text-text" inputMode="decimal" value={t.price} onChange={(e) => onChange(tiers.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
          <button type="button" aria-label="Remove quantity price" onClick={() => onChange(tiers.filter((_, j) => j !== i))}><X className="size-3.5" /></button>
        </span>
      ))}
      <button type="button" className="font-medium text-primary hover:underline" onClick={() => onChange([...tiers, { min: "", price: "" }])}>+ quantity price for {unit}</button>
    </div>
  );
}

function ProductDialog({ product: p, brands, categories, onClose, onSaved }: { product: Product | null; brands: Named[]; categories: Named[]; onClose: () => void; onSaved: () => void }) {
  const { gst, settings } = useShop();
  const base = p?.units.find((u) => u.is_base);
  const [v, setV] = useState({
    name: p?.name ?? "", brand_id: p?.brand_id ? String(p.brand_id) : "", category_id: p?.category_id ? String(p.category_id) : "", flavour: p?.flavour ?? "", pack_size: p?.pack_size ?? "",
    sku: p?.sku ?? "", barcode: p?.barcode ?? "", hsn_code: p?.hsn_code ?? "", tax_rate: String((p?.tax_rate_bp ?? settings.default_tax_rate_bp) / 100),
    price_includes_tax: p ? !!p.price_includes_tax : !!settings.prices_include_tax, base_unit: p?.base_unit ?? "pcs", weighed: p?.qty_decimals === 3,
    track_expiry: p ? !!p.track_expiry : true, low_stock: p ? formatQtyM(p.low_stock_m) : "0", cost: p ? String(p.cost4 / 10000) : "", description: p?.description ?? "", is_active: p ? !!p.is_active : true,
    base_price: base ? paiseToDecimal(base.sale_price) : "", opening: "", opening_expiry: "", opening_batch: "",
    sale_unit: p?.units.find((u) => u.is_default_sale)?.name ?? "", purchase_unit: p?.units.find((u) => u.is_default_purchase)?.name ?? "",
  });
  const [baseTiers, setBaseTiers] = useState<TierRow[]>(tierRows(base?.tiers ?? []));
  const [units, setUnits] = useState<UnitRow[]>((p?.units ?? []).filter((u) => !u.is_base && !u.name.endsWith("(old)")).map((u) => ({ id: u.id, name: u.name, contains: formatQtyM(u.factor_m), of: -1, price: paiseToDecimal(u.sale_price), active: !!u.is_active, tiers: tierRows(u.tiers) })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((s) => ({ ...s, [k]: value }));
  const setUnit = (i: number, patch: Partial<UnitRow>) => setUnits((us) => us.map((u, j) => (j === i ? { ...u, ...patch } : u)));

  // "1 Carton = 12 Box" and "1 Box = 10 pcs" -> a carton holds 120 pcs. Everything is stored against the base unit.
  const factorM = (i: number, depth = 0): number | null => {
    const u = units[i];
    const n = parseQty(u.contains);
    if (n === null || depth > 8) return null;
    if (u.of < 0) return n;
    const inner = factorM(u.of, depth + 1);
    return inner === null ? null : Math.round((n * inner) / 1000);
  };
  const parseTiers = (rows: TierRow[], unit: string): { min_qty_m: number; price: number }[] | string => {
    const out = [];
    for (const t of rows) {
      if (!t.min.trim() && !t.price.trim()) continue;
      const m = parseQty(t.min), pr = parseRupees(t.price);
      if (m === null || pr === null) return `Check the quantity prices for ${unit}.`;
      out.push({ min_qty_m: m, price: pr });
    }
    return out;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const basePrice = parseRupees(v.base_price || "0"), cost = v.cost.trim() === "" ? 0 : Number(v.cost), low = v.low_stock.trim() === "" ? 0 : parseQty(v.low_stock) ?? (Number(v.low_stock) === 0 ? 0 : null);
    if (basePrice === null) return setError(`Enter the rate for one ${v.base_unit}.`);
    if (!Number.isFinite(cost) || cost < 0) return setError("Enter a valid cost price.");
    if (low === null) return setError("Enter a valid low-stock level.");
    const bt = parseTiers(baseTiers, v.base_unit);
    if (typeof bt === "string") return setError(bt);
    const unitPayload = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i], f = factorM(i), price = parseRupees(u.price || "0"), t = parseTiers(u.tiers, u.name);
      if (!u.name.trim()) return setError("Give every packing unit a name (for example Box or Carton).");
      if (f === null) return setError(`Enter how many are in one ${u.name}.`);
      if (price === null) return setError(`Enter the rate for one ${u.name}.`);
      if (typeof t === "string") return setError(t);
      unitPayload.push({ id: u.id, name: u.name.trim(), factor_m: f, sale_price: price, is_active: u.active, tiers: t });
    }
    let opening = null;
    if (!p && v.opening.trim()) {
      const qm = parseQty(v.opening);
      if (qm === null) return setError("Enter a valid opening stock quantity.");
      opening = { qty_m: qm, batch_no: v.opening_batch, expiry_date: v.opening_expiry || null };
    }
    setError("");
    setBusy(true);
    try {
      await api("products.save", {
        id: p?.id ?? null, name: v.name, brand_id: v.brand_id ? Number(v.brand_id) : null, category_id: v.category_id ? Number(v.category_id) : null, flavour: v.flavour, pack_size: v.pack_size,
        sku: v.sku, barcode: v.barcode, hsn_code: v.hsn_code, tax_rate_bp: gst ? Math.round(Number(v.tax_rate || 0) * 100) : p?.tax_rate_bp ?? 0, price_includes_tax: v.price_includes_tax,
        base_unit: v.base_unit.trim(), qty_decimals: v.weighed ? 3 : 0, track_expiry: v.track_expiry, low_stock_m: low, cost4: Math.round(cost * 10000), description: v.description, is_active: v.is_active,
        base_price: basePrice, base_tiers: bt, units: unitPayload, default_sale_unit: v.sale_unit || null, default_purchase_unit: v.purchase_unit || null, opening,
      });
      toast.success(p ? "Product updated" : "Product added");
      onSaved();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };
  const unitNames = [v.base_unit, ...units.filter((u) => u.active && u.name.trim()).map((u) => u.name.trim())];

  return (
    <Dialog open onClose={onClose} wide title={p ? "Edit product" : "Add product"}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-6">
          <Field label="Product name" className="sm:col-span-3">{(f) => <Input {...f} autoFocus placeholder="e.g. Vanilla Cup" value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
          <Field label="Brand" className="sm:col-span-3">{(f) => <Select {...f} value={v.brand_id} onChange={(e) => set("brand_id", e.target.value)}><option value="">None</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>
          <Field label="Flavour" className="sm:col-span-2">{(f) => <Input {...f} value={v.flavour} onChange={(e) => set("flavour", e.target.value)} />}</Field>
          <Field label="Pack size" className="sm:col-span-2">{(f) => <Input {...f} placeholder="e.g. 100 ml" value={v.pack_size} onChange={(e) => set("pack_size", e.target.value)} />}</Field>
          <Field label="Category" className="sm:col-span-2">{(f) => <Select {...f} value={v.category_id} onChange={(e) => set("category_id", e.target.value)}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}</Field>
          <Field label="SKU / item code" className="sm:col-span-2">{(f) => <Input {...f} className="num" value={v.sku} onChange={(e) => set("sku", e.target.value)} />}</Field>
          <Field label="Barcode (optional)" className="sm:col-span-2">{(f) => <Input {...f} className="num" value={v.barcode} onChange={(e) => set("barcode", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} />}</Field>
          {gst && <Field label="HSN code" className="sm:col-span-1">{(f) => <Input {...f} className="num" inputMode="numeric" value={v.hsn_code} onChange={(e) => set("hsn_code", e.target.value)} />}</Field>}
          {gst && <Field label="GST %" className="sm:col-span-1">{(f) => <><Input {...f} className="num" inputMode="decimal" list="gst-rates" value={v.tax_rate} onChange={(e) => set("tax_rate", e.target.value)} /><datalist id="gst-rates">{COMMON_GST_RATES.map((r) => <option key={r} value={r} />)}</datalist></>}</Field>}
        </div>

        <fieldset className="rounded-lg border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Packing and rates</legend>
          <div className="grid gap-4 sm:grid-cols-6">
            <Field label="Smallest unit you count stock in" hint="Stock is always kept in this unit." className="sm:col-span-2">{(f) => <Input {...f} list="base-units" value={v.base_unit} onChange={(e) => set("base_unit", e.target.value)} />}</Field>
            <datalist id="base-units">{["pcs", "cup", "cone", "stick", "bar", "tub", "packet", "kg", "litre"].map((u) => <option key={u} value={u} />)}</datalist>
            <Field label={`Rate for 1 ${v.base_unit || "unit"} (₹)`} className="sm:col-span-2">{(f) => <Input {...f} className="num" inputMode="decimal" value={v.base_price} onChange={(e) => set("base_price", e.target.value)} />}</Field>
            <Field label={`Cost of 1 ${v.base_unit || "unit"} (₹)`} hint="Updated by purchases. Used for profit." className="sm:col-span-2">{(f) => <Input {...f} className="num" inputMode="decimal" value={v.cost} onChange={(e) => set("cost", e.target.value)} />}</Field>
          </div>
          <TierEditor unit={v.base_unit || "unit"} tiers={baseTiers} onChange={setBaseTiers} />
          <div className="mt-4 space-y-3">
            {units.map((u, i) => {
              const f = factorM(i);
              return (
                <div key={i} className={u.active ? "" : "opacity-60"}>
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Packing unit" className="w-32">{(fp) => <Input {...fp} list="pack-units" placeholder="Box" value={u.name} onChange={(e) => setUnit(i, { name: e.target.value })} />}</Field>
                    <Field label="holds" className="w-24">{(fp) => <Input {...fp} className="num" inputMode="decimal" value={u.contains} onChange={(e) => setUnit(i, { contains: e.target.value })} />}</Field>
                    <Field label="of" className="w-32">{(fp) => (
                      <Select {...fp} value={u.of} onChange={(e) => setUnit(i, { of: Number(e.target.value) })}>
                        <option value={-1}>{v.base_unit || "base unit"}</option>
                        {units.map((o, j) => (j < i && o.name.trim() ? <option key={j} value={j}>{o.name}</option> : null))}
                      </Select>
                    )}</Field>
                    <Field label={`Rate for 1 ${u.name || "unit"} (₹)`} className="w-36">{(fp) => <Input {...fp} className="num" inputMode="decimal" value={u.price} onChange={(e) => setUnit(i, { price: e.target.value })} />}</Field>
                    <span className="num pb-2.5 text-xs text-muted">{f !== null && <>= {formatQtyM(f)} {v.base_unit}</>}</span>
                    <span className="ml-auto flex items-center gap-2 pb-1.5">
                      {u.id ? <Checkbox label="In use" checked={u.active} onChange={(e) => setUnit(i, { active: e.target.checked })} />
                        : <Button size="sm" variant="ghost" aria-label={`Remove ${u.name || "unit"}`} onClick={() => setUnits((us) => us.filter((_, j) => j !== i).map((x) => ({ ...x, of: x.of === i ? -1 : x.of > i ? x.of - 1 : x.of })))}><Trash2 className="size-4" /></Button>}
                    </span>
                  </div>
                  <TierEditor unit={u.name || "unit"} tiers={u.tiers} onChange={(t) => setUnit(i, { tiers: t })} />
                </div>
              );
            })}
            <datalist id="pack-units">{["Box", "Carton", "Case", "Packet", "Tray", "Tub"].map((u) => <option key={u} value={u} />)}</datalist>
            <Button size="sm" onClick={() => setUnits((us) => [...us, { id: null, name: "", contains: "", of: us.length - 1, price: "", active: true, tiers: [] }])}><Plus className="size-4" /> Add packing unit (box, carton…)</Button>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <Field label="Usually sold in">{(f) => <Select {...f} value={unitNames.includes(v.sale_unit) ? v.sale_unit : v.base_unit} onChange={(e) => set("sale_unit", e.target.value)}>{unitNames.map((n) => <option key={n}>{n}</option>)}</Select>}</Field>
            <Field label="Usually bought in">{(f) => <Select {...f} value={unitNames.includes(v.purchase_unit) ? v.purchase_unit : v.base_unit} onChange={(e) => set("purchase_unit", e.target.value)}>{unitNames.map((n) => <option key={n}>{n}</option>)}</Select>}</Field>
            {gst && <div className="flex items-end pb-2"><Checkbox label="Rates include GST" checked={v.price_includes_tax} onChange={(e) => set("price_includes_tax", e.target.checked)} /></div>}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-6">
          <div className="space-y-3 sm:col-span-3">
            <Checkbox label="Track expiry dates" hint="Every stock entry then needs an expiry date; expired stock is blocked from sale." checked={v.track_expiry} onChange={(e) => set("track_expiry", e.target.checked)} />
            <Checkbox label="Sold by weight or volume (decimals allowed)" hint="Leave off for anything counted in whole pieces." checked={v.weighed} onChange={(e) => set("weighed", e.target.checked)} />
            <Checkbox label="Active — available for billing" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} />
          </div>
          <Field label={`Warn when stock falls to (${v.base_unit})`} className="sm:col-span-3">{(f) => <Input {...f} className="num" inputMode="decimal" value={v.low_stock} onChange={(e) => set("low_stock", e.target.value)} />}</Field>
          {!p && <>
            <Field label={`Stock in hand now (${v.base_unit})`} hint="Opening stock. Leave empty to add it later." className="sm:col-span-2">{(f) => <Input {...f} className="num" inputMode="decimal" value={v.opening} onChange={(e) => set("opening", e.target.value)} />}</Field>
            <Field label="Its expiry date" className="sm:col-span-2">{(f) => <Input {...f} type="date" value={v.opening_expiry} onChange={(e) => set("opening_expiry", e.target.value)} />}</Field>
            <Field label="Batch no (optional)" className="sm:col-span-2">{(f) => <Input {...f} value={v.opening_batch} onChange={(e) => set("opening_batch", e.target.value)} />}</Field>
          </>}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>{p ? "Save changes" : "Add product"}</Button></div>
      </form>
    </Dialog>
  );
}

export function NamedListDialog({ kind, items, onClose, onChanged }: { kind: "brands" | "categories" | "expense_categories"; items: Named[]; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState("");
  const label = kind === "brands" ? "brand" : "category";
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); onChanged(); } catch (e) { toast.error(errorText(e)); } };
  return (
    <Dialog open onClose={onClose} title={kind === "brands" ? "Brands" : kind === "categories" ? "Categories" : "Expense categories"}>
      <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run(async () => { await api(`${kind}.save`, { name }); setName(""); }); }}>
        <Input autoFocus placeholder={`New ${label} name`} aria-label={`New ${label} name`} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary">Add</Button>
      </form>
      {items.length === 0 ? <p className="py-6 text-center text-sm text-muted">None yet.</p> : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
              <span>{c.name}</span>
              <span>
                <Button size="sm" variant="ghost" aria-label={`Rename ${c.name}`} onClick={() => { const next = window.prompt(`Rename ${label}`, c.name)?.trim(); if (next && next !== c.name) void run(() => api(`${kind}.save`, { id: c.id, name: next })); }}><Pencil className="size-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => { if (window.confirm(`Delete ${label} "${c.name}"? Items using it are kept.`)) void run(() => api(`${kind}.delete`, { id: c.id })); }}><Trash2 className="size-4" /></Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
