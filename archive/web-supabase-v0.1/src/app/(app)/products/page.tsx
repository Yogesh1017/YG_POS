"use client";
import { useLiveQuery } from "dexie-react-hooks";
import { Package, Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ManagersOnly, Page } from "@/components/app-shell";
import { Badge, Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, Textarea, td, th } from "@/components/ui";
import { db } from "@/lib/db";
import { COMMON_GST_RATES, UNITS } from "@/lib/gst";
import { formatINR, rupeesToPaise } from "@/lib/money";
import { emptyToNull, fieldErrors, productSchema } from "@/lib/schemas";
import { useShop } from "@/lib/session";
import { errorMessage, supabase } from "@/lib/supabase";
import type { Category, Product } from "@/lib/types";

export default function ProductsPage() {
  return <ManagersOnly><Products /></ManagersOnly>;
}

function Products() {
  const { business } = useShop();
  const products = useLiveQuery(() => db.products.where("business_id").equals(business.id).toArray(), [business.id]);
  const categories = useLiveQuery(() => db.categories.where("business_id").equals(business.id).sortBy("name"), [business.id]) ?? [];
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [managingCategories, setManagingCategories] = useState(false);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products ?? [])
      .filter((p) => (showInactive || p.is_active) && (!category || p.category_id === category) &&
        (!s || p.name.toLowerCase().includes(s) || p.sku?.toLowerCase().includes(s) || p.barcode?.includes(s)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, q, category, showInactive]);
  const catName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "";

  const remove = async (p: Product) => {
    const { error } = await supabase().from("products").delete().eq("id", p.id);
    if (error) {
      toast.error(error.code === "23503" ? "This product appears on past bills, so it cannot be deleted. Mark it inactive instead to hide it from billing." : errorMessage(error));
      return;
    }
    await db.products.delete(p.id);
    toast.success("Product deleted");
    setDeleting(null);
  };

  if (!products) return <Spinner />;
  return (
    <Page>
      <PageHeader title="Products" description={`${products.filter((p) => p.is_active).length} active products`} actions={
        <>
          <Button onClick={() => setManagingCategories(true)}><Tags className="size-4" /> Categories</Button>
          <Button variant="primary" onClick={() => setEditing("new")}><Plus className="size-4" /> Add product</Button>
        </>
      } />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search name, SKU or barcode" aria-label="Search products" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="w-44" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Checkbox label="Show inactive" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
      </div>
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<Package />} title={products.length === 0 ? "No products yet" : "No products match"} action={products.length === 0 ? <Button variant="primary" onClick={() => setEditing("new")}>Add your first product</Button> : undefined}>
            {products.length === 0 ? "Add the items you sell. They appear on the billing screen straight away." : "Try a different search or category."}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-surface-2/60"><tr>
                <th className={th}>Product</th><th className={th}>Category</th><th className={`${th} text-right`}>Price</th><th className={`${th} text-right`}>Cost</th>
                {business.gst_registered && <th className={`${th} text-right`}>GST</th>}<th className={`${th} text-right`}>Stock</th><th className={th}><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.id} className={p.is_active ? "" : "opacity-60"}>
                    <td className={td}>
                      <div className="font-medium">{p.name} {!p.is_active && <Badge>Inactive</Badge>}</div>
                      <div className="num text-xs text-muted">{[p.sku && `SKU ${p.sku}`, p.barcode, p.hsn_code && `HSN ${p.hsn_code}`].filter(Boolean).join(" · ")}</div>
                    </td>
                    <td className={`${td} text-muted`}>{catName(p.category_id)}</td>
                    <td className={`${td} num text-right font-medium`}>{formatINR(rupeesToPaise(p.sale_price))}<span className="text-xs font-normal text-muted"> /{p.unit}</span></td>
                    <td className={`${td} num text-right text-muted`}>{formatINR(rupeesToPaise(p.purchase_price))}</td>
                    {business.gst_registered && <td className={`${td} num text-right text-muted`}>{p.tax_rate}%{p.price_includes_tax ? "" : " +"}</td>}
                    <td className={`${td} num text-right`}>{p.track_stock ? <span className={p.stock_qty <= 0 ? "text-danger" : p.stock_qty <= p.low_stock_threshold ? "text-warn" : ""}>{p.stock_qty}</span> : <span className="text-muted">—</span>}</td>
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
      {editing && <ProductDialog product={editing === "new" ? null : editing} categories={categories} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!deleting} danger title="Delete product?" confirmLabel="Delete" onClose={() => setDeleting(null)}
        message={<>Delete <b>{deleting?.name}</b>? Its stock history is deleted too. Products that appear on past bills cannot be deleted — mark those inactive instead.</>}
        onConfirm={() => remove(deleting!)} />
      {managingCategories && <CategoriesDialog categories={categories} onClose={() => setManagingCategories(false)} />}
    </Page>
  );
}

const num = (s: string): number => (s.trim() === "" ? NaN : Number(s));

function ProductDialog({ product, categories, onClose }: { product: Product | null; categories: Category[]; onClose: () => void }) {
  const { business } = useShop();
  const [v, setV] = useState({
    name: product?.name ?? "", category_id: product?.category_id ?? "", sku: product?.sku ?? "", barcode: product?.barcode ?? "",
    hsn_code: product?.hsn_code ?? "", unit: product?.unit ?? "pcs", sale_price: product ? String(product.sale_price) : "",
    purchase_price: product ? String(product.purchase_price) : "0", tax_rate: String(product?.tax_rate ?? business.default_tax_rate),
    price_includes_tax: product?.price_includes_tax ?? business.prices_include_tax, track_stock: product?.track_stock ?? true,
    low_stock_threshold: String(product?.low_stock_threshold ?? 0), description: product?.description ?? "", is_active: product?.is_active ?? true,
    opening_stock: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, value: (typeof v)[K]) => setV((s) => ({ ...s, [k]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = productSchema.safeParse({
      ...v, sale_price: num(v.sale_price), purchase_price: num(v.purchase_price || "0"), tax_rate: num(v.tax_rate || "0"),
      low_stock_threshold: num(v.low_stock_threshold || "0"),
    });
    const opening = v.opening_stock.trim() === "" ? 0 : Number(v.opening_stock);
    const errs = parsed.success ? {} : fieldErrors(parsed.error);
    if (!product && v.track_stock && (!Number.isFinite(opening) || opening < 0 || Math.round(opening * 1000) !== opening * 1000)) errs.opening_stock = "Enter a quantity of 0 or more";
    if (!parsed.success || Object.keys(errs).length) return setErrors(errs);
    setErrors({});
    const d = parsed.data;
    const row = {
      name: d.name, category_id: d.category_id || null, sku: emptyToNull(d.sku), barcode: emptyToNull(d.barcode), hsn_code: emptyToNull(d.hsn_code),
      unit: d.unit, sale_price: d.sale_price, purchase_price: d.purchase_price, tax_rate: business.gst_registered ? d.tax_rate : 0,
      price_includes_tax: d.price_includes_tax, track_stock: d.track_stock, low_stock_threshold: d.low_stock_threshold,
      description: emptyToNull(d.description), is_active: d.is_active,
    };
    setBusy(true);
    const res = product
      ? await supabase().from("products").update(row).eq("id", product.id).select().single()
      : await supabase().from("products").insert({ ...row, business_id: business.id }).select().single();
    if (res.error) { setBusy(false); toast.error(errorMessage(res.error)); return; }
    const saved = res.data as Product;
    if (!product && d.track_stock && opening > 0) {
      const stock = await supabase().rpc("adjust_stock", { p_product_id: saved.id, p_qty_change: opening, p_reason: "opening" });
      if (stock.error) toast.warning(`Product saved, but the opening stock was not recorded: ${errorMessage(stock.error)} Add it from Stock.`);
      else saved.stock_qty = Number(stock.data);
    }
    // Keep stock as this device knows it (it may include bills not uploaded yet).
    const local = await db.products.get(saved.id);
    await db.products.put(product && local ? { ...saved, stock_qty: local.stock_qty } : saved);
    setBusy(false);
    toast.success(product ? "Product updated" : "Product added");
    onClose();
  };

  return (
    <Dialog open onClose={onClose} wide title={product ? "Edit product" : "Add product"}>
      <form onSubmit={submit} noValidate className="grid gap-4 sm:grid-cols-6">
        <Field label="Name" error={errors.name} className="sm:col-span-4">{(p) => <Input {...p} autoFocus value={v.name} onChange={(e) => set("name", e.target.value)} />}</Field>
        <Field label="Category" className="sm:col-span-2">{(p) => (
          <Select {...p} value={v.category_id} onChange={(e) => set("category_id", e.target.value)}><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        )}</Field>
        <Field label="Selling price (₹)" error={errors.sale_price} className="sm:col-span-2">{(p) => <Input {...p} className="num" type="number" min={0} step="0.01" inputMode="decimal" value={v.sale_price} onChange={(e) => set("sale_price", e.target.value)} />}</Field>
        <Field label="Cost price (₹)" error={errors.purchase_price} hint="Used for profit reports" className="sm:col-span-2">{(p) => <Input {...p} className="num" type="number" min={0} step="0.01" inputMode="decimal" value={v.purchase_price} onChange={(e) => set("purchase_price", e.target.value)} />}</Field>
        <Field label="Unit" error={errors.unit} className="sm:col-span-2">{(p) => (
          <><Input {...p} list="units" value={v.unit} onChange={(e) => set("unit", e.target.value)} /><datalist id="units">{UNITS.map((u) => <option key={u} value={u} />)}</datalist></>
        )}</Field>
        {business.gst_registered && <>
          <Field label="GST rate (%)" error={errors.tax_rate} className="sm:col-span-2">{(p) => (
            <><Input {...p} className="num" type="number" min={0} max={100} step="0.01" list="rates" value={v.tax_rate} onChange={(e) => set("tax_rate", e.target.value)} /><datalist id="rates">{COMMON_GST_RATES.map((r) => <option key={r} value={r} />)}</datalist></>
          )}</Field>
          <Field label="HSN / SAC code" error={errors.hsn_code} className="sm:col-span-2">{(p) => <Input {...p} className="num" inputMode="numeric" value={v.hsn_code} onChange={(e) => set("hsn_code", e.target.value)} />}</Field>
          <div className="flex items-end pb-2 sm:col-span-2"><Checkbox label="Selling price includes GST" checked={v.price_includes_tax} onChange={(e) => set("price_includes_tax", e.target.checked)} /></div>
        </>}
        <Field label="Barcode" error={errors.barcode} hint="Click here and scan the item" className="sm:col-span-3">{(p) => <Input {...p} className="num" value={v.barcode} onChange={(e) => set("barcode", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.preventDefault()} />}</Field>
        <Field label="SKU / item code" error={errors.sku} className="sm:col-span-3">{(p) => <Input {...p} className="num" value={v.sku} onChange={(e) => set("sku", e.target.value)} />}</Field>
        <div className="sm:col-span-6"><Checkbox label="Track stock for this product" hint="Turn off for services or items you do not count." checked={v.track_stock} onChange={(e) => set("track_stock", e.target.checked)} /></div>
        {v.track_stock && <>
          {!product && <Field label={`Stock in hand now (${v.unit || "units"})`} error={errors.opening_stock} className="sm:col-span-3">{(p) => <Input {...p} className="num" type="number" min={0} step="0.001" inputMode="decimal" placeholder="0" value={v.opening_stock} onChange={(e) => set("opening_stock", e.target.value)} />}</Field>}
          <Field label="Warn when stock falls to" error={errors.low_stock_threshold} className="sm:col-span-3">{(p) => <Input {...p} className="num" type="number" min={0} step="0.001" inputMode="decimal" value={v.low_stock_threshold} onChange={(e) => set("low_stock_threshold", e.target.value)} />}</Field>
        </>}
        <Field label="Description" error={errors.description} className="sm:col-span-6">{(p) => <Textarea {...p} rows={2} value={v.description} onChange={(e) => set("description", e.target.value)} />}</Field>
        <div className="sm:col-span-6"><Checkbox label="Active — show on the billing screen" checked={v.is_active} onChange={(e) => set("is_active", e.target.checked)} /></div>
        <div className="flex justify-end gap-2 sm:col-span-6"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>{product ? "Save changes" : "Add product"}</Button></div>
      </form>
    </Dialog>
  );
}

function CategoriesDialog({ categories, onClose }: { categories: Category[]; onClose: () => void }) {
  const { business } = useShop();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const { data, error } = await supabase().from("categories").insert({ business_id: business.id, name: name.trim() }).select().single();
    setBusy(false);
    if (error) return void toast.error(errorMessage(error));
    await db.categories.put(data as Category);
    setName("");
  };
  const rename = async (c: Category) => {
    const next = window.prompt("Rename category", c.name)?.trim();
    if (!next || next === c.name) return;
    const { error } = await supabase().from("categories").update({ name: next }).eq("id", c.id);
    if (error) return void toast.error(errorMessage(error));
    await db.categories.update(c.id, { name: next });
  };
  const remove = async (c: Category) => {
    if (!window.confirm(`Delete category "${c.name}"? Its products are kept and become uncategorised.`)) return;
    const { error } = await supabase().from("categories").delete().eq("id", c.id);
    if (error) return void toast.error(errorMessage(error));
    await db.transaction("rw", db.categories, db.products, async () => {
      await db.categories.delete(c.id);
      await db.products.where("business_id").equals(business.id).and((p) => p.category_id === c.id).modify({ category_id: null });
    });
  };

  return (
    <Dialog open onClose={onClose} title="Categories">
      <form onSubmit={add} className="mb-4 flex gap-2">
        <Input autoFocus placeholder="New category name" aria-label="New category name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" loading={busy}>Add</Button>
      </form>
      {categories.length === 0 ? <p className="py-6 text-center text-sm text-muted">No categories yet. They become quick filters on the billing screen.</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {categories.map((c) => (
            <li key={c.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
              <span>{c.name}</span>
              <span>
                <Button size="sm" variant="ghost" aria-label={`Rename ${c.name}`} onClick={() => void rename(c)}><Pencil className="size-4" /></Button>
                <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => void remove(c)}><Trash2 className="size-4" /></Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
