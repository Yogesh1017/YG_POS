import Dexie, { type EntityTable } from "dexie";
import type { Business, Category, Customer, LocalSale, Member, Product } from "./types";

export interface CachedSession {
  user_id: string;
  member: Member;
  business: Business;
  cached_at: string;
}

/**
 * On-device database (IndexedDB). Holds a copy of the catalog so billing works offline,
 * and every sale made on this device until the server has confirmed it.
 */
class PosDatabase extends Dexie {
  products!: EntityTable<Product, "id">;
  categories!: EntityTable<Category, "id">;
  customers!: EntityTable<Customer, "id">;
  sales!: EntityTable<LocalSale, "id">;
  sessions!: EntityTable<CachedSession, "user_id">;

  constructor() {
    super("ygpos");
    this.version(1).stores({
      products: "id, business_id, barcode",
      categories: "id, business_id",
      customers: "id, business_id",
      sales: "id, business_id, status, sold_at, [business_id+status]",
      sessions: "user_id",
    });
  }
}

export const db = new PosDatabase();
