# Archived: web + Supabase version (v0.1)

This folder is a frozen copy of the first version of YG POS: a browser app for a retail shop that
stored its data in Supabase (PostgreSQL) and synced offline bills.

It was replaced by the offline Windows desktop application in the repository root, built for a
wholesale ice cream business with a local SQLite database. Nothing here is used by the desktop app.
It is kept as a reference: the PostgreSQL functions in `supabase/migrations/` were the specification
for the desktop app's business rules, and the tests document the expected behaviour.

To run it again, copy this folder somewhere, run `npm install`, and follow its `README.md`.
