# Architecture

## Overview

```
 One Windows PC
┌────────────────────────────────────────────────────────────────┐
│ YG POS (Electron)                                              │
│                                                                │
│  Window ── the interface (Next.js/React, built to static files)│
│     │  fetch("/api/rpc")  over the private  app://ygpos address │
│     ▼                                                          │
│  Main process                                                  │
│   ├─ request handler  desktop/server.ts  (files + API)         │
│   ├─ core             desktop/core/      (all business rules)  │
│   │     └─ SQLite     %APPDATA%\YG POS\data\ygpos.db           │
│   ├─ printing, PDF, folder choosers   desktop/main.ts          │
│   └─ backup schedule                                           │
└────────────────────────────────────────────────────────────────┘
```

No network port is opened and nothing is fetched from the internet. A Content-Security-Policy on
every page allows only the app's own files.

## The parts

| Part | Where | Role |
| --- | --- | --- |
| Interface | `src/` | Screens. Holds no business rules beyond showing live totals; never touches the database |
| Shared arithmetic | `src/lib/money.ts`, `tax.ts`, `pricing.ts`, `units.ts` | One implementation of money, GST, price rules and unit conversion, used by both the screens and the core |
| Core | `desktop/core/` | Validates every request, checks permissions, and reads/writes the database. The only code that can change data |
| Request handler | `desktop/server.ts` | One function serving the interface files and `/api/rpc`. Plugged into Electron's `app://` protocol; the same function is served on `127.0.0.1` for development and tests |
| Shell | `desktop/main.ts`, `preload.ts` | Window, printing, PDF, file choosers, backup timer, single-instance lock |

The window runs sandboxed with no Node.js access. Its only bridge to the computer is the small
`window.desktop` object (print, save PDF, list printers, choose a folder or backup file).

## Why these choices

- **Electron** runs the existing React interface as it is, prints to a chosen printer without a
  dialog, and produces real PDF files from the same invoice layout that is printed.
- **SQLite through Node's built-in `node:sqlite`.** One file, transactional, crash-safe. Using the
  built-in module means there is no native add-on to compile for Windows.
- **Rules in a TypeScript core, not in the screens.** The screen's totals are for display; the core
  recomputes every amount from quantities and rates and ignores totals sent to it.
- **Static interface.** Next.js is used only as a build tool (`output: "export"`). There is no web
  server at runtime.

## Numbers

SQLite has no decimal type, so every amount is a whole number and arithmetic is exact:

| Kind | Stored as | Example |
| --- | --- | --- |
| Money | integer paise | ₹1,080.00 → `108000` |
| Quantity (`*_m`) | integer thousandths | 2 cartons → `2000`; 1.25 kg → `1250` |
| Cost per base unit (`cost4`) | integer 1/10000 rupee | a ₹900 carton of 120 → ₹7.50 → `75000` |
| GST rate (`*_bp`) | integer hundredths of a percent | 18% → `1800` |

Divisions round half up, in BigInt, in one place (`divRound`).

```
gross   = round(quantity × rate)
net     = gross − discount            (line discount + this line's share of the bill discount)
rate excludes GST:  taxable = net,                              tax = round(net × rate%)
rate includes GST:  taxable = round(net × 100 / (100 + rate)),  tax = net − taxable
same state:  CGST = round(tax / 2), SGST = tax − CGST      other state: IGST = tax
total       = Σ(taxable + tax), optionally rounded to the nearest rupee
```

## Units

Each product has exactly one smallest **base unit**. Stock, batches and movements exist only in
that unit. A packing unit (box, carton, case) is a name plus the number of base units inside
(`factor_m`); it holds no stock of its own.

- "1 Carton = 12 Box" and "1 Box = 10 pcs" is stored as Carton = 120 pcs.
- Counted products accept only whole base quantities. The core checks this, and database triggers
  reject a fractional quantity even if application code were wrong.
- Products marked "sold by weight or volume" use kg or litre as the base with three decimals.
- A rate belongs to a unit (a carton's rate is its own figure, not 120 × the piece rate).
- Every invoice and purchase line stores the unit name and size used, so later packing changes do
  not alter old documents. A unit that appears on any document cannot change size; add a new unit
  and switch the old one off.

## Price rules

In order: a rate agreed with this customer for this unit → the quantity price the quantity reaches
→ the unit's list rate. A hand-typed rate overrides all three, is marked "manual" on the line, and
needs an owner or manager.

## One invoice, one transaction

`sales.create` does all of this inside a single SQLite transaction, so it happens completely or not at all:

1. Validate the request and price every line by the rules.
2. Compute totals; check payments, the credit limit and stock.
3. If anything needs approval (manual rate, stock shortfall, credit limit), stop unless it was
   confirmed by someone allowed to — a cashier supplies an owner/manager's username and password.
4. Take the next invoice number.
5. Save the invoice and lines; take stock from batches, earliest expiry first; record which batches
   each line used and their actual cost.
6. Record payments and raise the customer's balance by any unpaid amount.

SQLite allows one writer at a time and the app is the only process using the file, so two invoices
can never be given the same stock. A constraint also forbids any batch quantity below zero. A
repeated submit (same `client_ref`) returns the first result instead of creating a second invoice.

**Invoice numbers** are sequential within a financial year, unique and never reused. A cancelled
invoice keeps its number. The invoice register report lists every number and flags any that are
missing — which can only follow restoring an older backup.

**Selling beyond recorded stock.** With approval, the excess is recorded as a shortfall on the
product rather than driving a batch negative. The next stock-in settles the shortfall first.

## Roles

| | Owner | Manager | Cashier |
| --- | --- | --- | --- |
| Invoices at list / quantity / customer rates; add customers; record payments; view invoices | ✓ | ✓ | ✓ |
| Manual rates; approve stock shortfall and credit-limit excess | ✓ | ✓ | with an approver |
| Products, stock, purchases, suppliers, expenses; cancel invoices; returns; reports; customer rates, limits, opening balances | ✓ | ✓ | |
| Take a backup | ✓ | ✓ | |
| Business settings, users, restore a backup, audit log | ✓ | | |

Passwords are stored as salted scrypt hashes. Five wrong passwords for a username lock it for a
minute. Sessions end when the app closes.

## Backup and recovery

**Automatic.** A backup is taken when the app opens, every two hours, and when it closes — by
SQLite itself (`VACUUM INTO`), so it is consistent even mid-use. Each backup is then reopened, its
integrity checked, and its last invoice number, customer dues and stock value compared with the
live database; a mismatch discards it and reports an error.

**Two locations.** Backups go to `data\backups` and to the second location chosen in Settings. The
menu shows "Backup needs attention" while no second location is set, the last copy failed, or none
has succeeded for over a day.

**Kept:** everything for 7 days, one per day for 60 days, one per month for 2 years.

**Restore** (owner): the chosen file is checked; the current data is saved as a `pre-restore`
backup; the backup is copied beside the database and swapped in with one atomic rename; older
backups are upgraded to the current schema. If the app dies mid-restore, the old database is still
in place and the half-copied file is removed at the next start.

**App updates.** Schema changes are forward-only migrations. Before an update changes an existing
database, a `pre-upgrade` copy is kept. An older app refuses to open a newer database.

### Recovery procedures

| Situation | What to do |
| --- | --- |
| A mistake was entered | Cancel the invoice or purchase, or adjust stock. Nothing needs restoring |
| Data looks wrong after a bad day | Settings → Backup → *Check* a backup from before the problem → *Restore* |
| The app says the database is damaged | Do not delete anything. Reinstall if needed, then restore the newest backup that passes *Check* |
| New or replaced computer | Install YG POS, complete first-run setup with any values, then Settings → Backup → *Check or restore another file* and choose the newest backup from the second drive |
| Forgotten owner password | Sign-in screen → *Owner forgot the password?* → enter the recovery key |
| Undo a restore | Restore the `pre-restore` backup made at that moment |

Do a restore check on the real machine from time to time; a backup that has never been checked is a hope, not a backup.

## Printing and hardware

| Device | How | Limits |
| --- | --- | --- |
| A4 and thermal printers | Through Windows printing. A printer can be chosen per paper type, with optional printing without the dialog | The printer and its driver must be installed in Windows; thermal paper size is set in the driver |
| PDF | Generated by the app from the invoice layout and saved where you choose | — |
| Barcode scanner | Keyboard-type scanners work in every product search box | Must send Enter after the code |
| Cash drawer | Opened by the receipt printer driver's "open drawer on print" option | Cannot be opened without printing |

## Layout of the repository

```
desktop/core/      schema (migrations.ts) and services: auth, catalog, stock, sales, purchases, parties, reports, backup
desktop/           main.ts (Electron), preload.ts, server.ts (request handler), dev-server.ts
src/app/           screens      src/components/  shared UI, documents, pickers      src/lib/  api client, arithmetic
tests/             core tests (Vitest)          e2e/  browser and desktop-shell tests
scripts/           desktop bundler             .github/workflows/  Windows tests and installer build; releases
archive/           the previous web/Supabase version, unused
```
