# Changelog

## 0.1.0 — 2026-11-13

First version. Scope: one shop; billing, products, sales history, invoices and basic inventory first.

### Added
- Database schema with Row Level Security, and SQL functions for sales, cancellations, returns,
  stock adjustments, dues collection, staff and reports (`supabase/migrations/`).
- Sign-up, sign-in, password reset, shop setup; owner / manager / cashier roles.
- Billing screen: search, barcode scanning, discounts, split payments, credit sales, change calculation.
- GST: optional registration, CGST/SGST/IGST, inclusive/exclusive prices, HSN/SAC, invoice numbering by financial year.
- Bill printing for 58 mm, 80 mm and A4 through the browser.
- Offline: installable app shell (service worker), on-device catalog and sales queue with idempotent upload.
- Sales history with cancel and partial return (credit notes).
- Products, categories, stock adjustments and history, low-stock indicators.
- Customers, dues and payment collection.
- Dashboard and date-range reports with CSV export.
- Tests: 18 arithmetic unit tests, 36 database integration tests, 27-step browser end-to-end test.

### Known limitations
- Not yet run against a hosted Supabase project or deployed; see README "Before you rely on it".
- No suppliers/purchases, expenses, net profit, multiple outlets, variants, images or loyalty points.
- New customers cannot be created while offline.
- Net profit is not reported because expenses are not recorded.
