import { z } from "zod";
import { isValidGstin } from "./gst";

const optionalText = (max: number) => z.string().trim().max(max, `Keep this under ${max} characters`);

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters"),
});

export const businessSchema = z
  .object({
    name: z.string().trim().min(1, "Shop name is required").max(120),
    legal_name: optionalText(160),
    phone: z.string().trim().regex(/^$|^[0-9+ -]{6,20}$/, "Enter a valid phone number"),
    email: z.string().trim().regex(/^$|^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address"),
    address: optionalText(400),
    city: optionalText(80),
    pincode: z.string().trim().regex(/^$|^[1-9][0-9]{5}$/, "PIN code has 6 digits"),
    state_code: z.string(),
    gst_registered: z.boolean(),
    gstin: z.string().trim().toUpperCase(),
    default_tax_rate: z.number().min(0).max(100),
    prices_include_tax: z.boolean(),
    round_off_total: z.boolean(),
    invoice_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, "1–4 letters or digits").refine((v) => v !== "CN", "CN is reserved for credit notes"),
    receipt_footer: optionalText(300),
  })
  .superRefine((v, ctx) => {
    if (!v.gst_registered) return;
    if (!v.state_code) ctx.addIssue({ code: "custom", path: ["state_code"], message: "Select your state" });
    if (!isValidGstin(v.gstin)) ctx.addIssue({ code: "custom", path: ["gstin"], message: "This GSTIN is not valid — check each character" });
    else if (v.state_code && v.gstin.slice(0, 2) !== v.state_code) {
      ctx.addIssue({ code: "custom", path: ["gstin"], message: "The first two digits of the GSTIN must match the state" });
    }
  });
export type BusinessForm = z.infer<typeof businessSchema>;

export const productSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  category_id: z.string(),
  sku: optionalText(60),
  barcode: optionalText(60),
  hsn_code: z.string().trim().regex(/^$|^[0-9]{4,8}$/, "HSN/SAC is 4 to 8 digits"),
  unit: z.string().trim().min(1, "Unit is required").max(12),
  sale_price: z.number({ error: "Enter the selling price" }).min(0).max(10000000),
  purchase_price: z.number({ error: "Enter a valid cost" }).min(0).max(10000000),
  tax_rate: z.number({ error: "Enter a valid rate" }).min(0, "0 to 100").max(100, "0 to 100"),
  price_includes_tax: z.boolean(),
  track_stock: z.boolean(),
  low_stock_threshold: z.number({ error: "Enter a valid quantity" }).min(0).max(1000000),
  description: optionalText(1000),
  is_active: z.boolean(),
});
export type ProductForm = z.infer<typeof productSchema>;

export const customerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  phone: z.string().trim().regex(/^$|^[0-9+ -]{6,20}$/, "Enter a valid phone number"),
  gstin: z.string().trim().toUpperCase().refine((v) => v === "" || isValidGstin(v), "This GSTIN is not valid"),
  state_code: z.string(),
  address: optionalText(400),
});
export type CustomerForm = z.infer<typeof customerSchema>;

/** Flatten zod issues to { field: message } for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export const emptyToNull = (v: string): string | null => (v.trim() === "" ? null : v.trim());
