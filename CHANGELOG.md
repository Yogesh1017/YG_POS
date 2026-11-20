# Changelog

## 1.0.1 — 2026-11-20

### Changed
- GSTIN boxes drop spaces and pasted characters and show a 15-character count.
- README rewritten for visitors, with screenshots (demo data only).
- Installers are now published as GitHub Releases.
- Released under the MIT license.

## 1.0.0 — 2026-11-15

Rebuilt as an offline Windows desktop application for a wholesale ice cream business.

### Changed
- Runs entirely on one computer with a local SQLite database. Supabase, Vercel, the service worker
  and the sync queue are gone; the previous web version is archived in `archive/web-supabase-v0.1/`.
- Business rules moved from PostgreSQL functions to a TypeScript core inside the desktop app.
- Sign-in is local (username and password, owner recovery key) instead of email-based.
- Invoice numbers are assigned locally and are final as soon as the invoice is saved.

### Added
- Packing units per product on a single base unit; quantity prices; customer-specific rates.
- Keyboard-first wholesale invoice screen with approval for manual rates, selling beyond stock and
  exceeding a credit limit.
- Batches and expiry dates; earliest-expiry-first selling; expired stock blocked from sale.
- Damaged / melted / expired write-offs; returns into stock or into wastage; credit notes.
- Suppliers, purchase bills, supplier payments and ledgers.
- Customer credit limits, opening balances, ledgers and printable statements.
- Expenses and net profit; product, customer, purchase, wastage, outstanding, stock and GST
  reports; invoice register.
- A4 wholesale tax invoice with amount in words, thermal receipt, PDF export, printer selection.
- Automatic verified backups to two locations; restore with safety copy; backup check.
- Windows installer built by GitHub Actions.

### Known limitations
- The installer is not code-signed (Windows shows an "unknown publisher" warning).
- See README "Not included".

## 0.1.0 — 2026-11-13

First version: a browser app for a retail shop on Supabase. Archived.
