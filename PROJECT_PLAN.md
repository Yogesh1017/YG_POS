# Project plan and status

## Direction (approved)

One Windows billing computer · fully offline · desktop application · local SQLite database as the
only source of truth · no Supabase, Vercel, internet, cloud sync or LAN · the earlier web version
kept as an archived reference.

## Decisions taken for the business this was built for

| Topic | Decision |
| --- | --- |
| Packing | Per product; any levels; all levels can be sold; each size of a flavour is its own product |
| Weight / volume | Supported: a product can be marked "sold by weight or volume" and then allows decimals |
| Expiry | Tracked per product (on by default); batch number optional |
| Freezers | One stock total, no freezer-wise tracking |
| Selling beyond stock | Warning; an owner or manager can approve; recorded as a shortfall that the next stock-in settles |
| Rates | Quoted before GST by default (switchable per product) |
| Manual rates | Owner and manager; a cashier needs their password; always logged |
| Rounding | Invoice total rounded to the nearest rupee (switchable) |
| Invoice numbers | `PREFIX/FY/N`, restarting each April; sequential, unique, never reused; cancelled numbers stay in the register |
| Cash sales | Allowed without a customer, but must be paid in full |
| Credit limit | Warning; owner or manager can approve |
| GST | Regular scheme, tax invoices; IGST when the customer's state differs |
| Data | Started empty; nothing carried over from the web version |

## Feature checklist

✅ built and covered by automated tests · 🟡 built, checked on screen only · ⬜ not built

**Users and settings**
- ✅ First-run setup, local sign-in, lockout after repeated wrong passwords, owner recovery key
- ✅ Owner / manager / cashier permissions enforced in the core; audit log
- ✅ Business, GST and invoice settings

**Products and packing**
- ✅ Brand, flavour, pack size, category, SKU, barcode, HSN, GST rate
- ✅ Base unit with any number of packing units; whole-number rule for counted goods; decimals for weighed goods
- ✅ Unit rates, quantity prices, customer rates; a used unit's size is frozen
- ⬜ Import from Excel/CSV

**Invoices**
- ✅ Customer selection, product search, barcode entry, unit, quantity, rate, line and bill discount
- ✅ GST per line, CGST/SGST/IGST, round-off; totals recomputed by the core
- ✅ Paid / part paid / credit; split payments; credit-limit check
- ✅ Approval flow for manual rate, stock shortfall, credit limit
- ✅ Final sequential numbering; double-submit protection; draft survives restart
- ✅ A4 invoice and thermal receipt content · ✅ PDF export (desktop shell test) · 🟡 paper output on real printers
- ✅ Search by number, customer, date, status; reprint
- ✅ Cancel with reason; partial returns with credit notes; 🟡 credit note print layout

**Stock**
- ✅ Batches, expiry, earliest-expiry-first, expired stock blocked
- ✅ Opening stock, count correction, damaged / melted / expired write-off, movement history
- ✅ Low-stock and expiring lists; stock value at cost
- ⬜ Freezer-wise stock

**Purchases and suppliers**
- ✅ Supplier bills in any unit with batch, expiry, discount, GST; real cost per base unit
- ✅ Supplier balances, payments, ledger; cancel an untouched purchase
- ⬜ Purchase returns to supplier (use a stock adjustment and note for now)

**Customers and credit**
- ✅ Shop name, contact, GSTIN, state, address, credit limit, opening balance
- ✅ Payments settle oldest dues first; ledger with running balance; 🟡 printed statement layout
- ⬜ Advance payments (a payment larger than the balance is refused)

**Reports**
- ✅ Sales and profit, products, customers, purchases, wastage, outstanding, stock, GST, invoice register
- ✅ Dashboard; CSV export
- ⬜ GSTR-shaped exports, e-invoice, e-way bill

**Backup and recovery**
- ✅ Automatic verified backups (start, every 2 hours, close), rotation, second location with warnings
- ✅ Check a backup; restore with safety copy; damaged files refused; old-version backups upgraded
- ✅ Crash safety (hard kill mid-use), interrupted restore, single-instance lock

**Delivery**
- ✅ Desktop shell tested on Linux; Windows tests and installer build run on GitHub Actions
- ✅ Trial run by the owner on the billing PC
- ⬜ Code-signed installer

## Possible next steps

In order of likely value: product import from Excel, purchase returns, customer advance payments,
GST export for the accountant, a code-signed installer.

## Risks that remain

| Risk | Mitigation | Still open |
| --- | --- | --- |
| The PC's disk fails | Backups to a second drive, verified, with warnings when it is missing | The second drive must actually be plugged in; consider swapping two drives weekly |
| The PC is lost or stolen | Data folder can be restored on a new PC | The database file is not encrypted; use Windows BitLocker |
| Wrong GST treatment | Tested arithmetic, configurable rates | Accountant review; no e-invoice/e-way bill |
| Printer differences | Uses Windows printing, selectable printers | Untested on real hardware |
| Forgotten owner password | Recovery key shown at setup | If both are lost, the data can only be opened by a developer |
