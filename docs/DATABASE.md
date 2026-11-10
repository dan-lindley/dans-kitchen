# Database architecture

Dan's Kitchen stores application data in
`<Home Assistant config>/dans_kitchen/dans_kitchen.sqlite3`. SQLite is the
authoritative source; the integration does not use Recorder, JSON inventory
files, or an external database service. The database directory is inside the
Home Assistant configuration directory and is included in normal Home
Assistant backups.

All SQLite operations run in a worker thread. A process-local async lock
serializes the read/write connection and each write callback runs in a
`BEGIN IMMEDIATE` transaction. Connections enforce foreign keys, use a busy
timeout, WAL journaling, and full synchronous writes. Schema migrations are
numbered, recorded in `schema_migrations`, and committed atomically. The
database refuses to start when a newer schema is present rather than silently
downgrading it.

## Tables and relationships

| Table | Purpose and relationships |
| --- | --- |
| `storage_locations` | Editable household locations. Product defaults and inventory batches reference stable IDs. |
| `products` | Generic catalogue and stock unit; owns reorder level and default location. |
| `product_variants` | Optional branded/barcoded variants belonging to one generic product. Barcodes are text and unique when present. |
| `inventory_batches` | Per-variant stock, location, acquisition and expiry dates. |
| `stock_transactions` | Append-only stock audit events with before/after balances and optional request idempotency. |
| `recipes` | Recipe descriptions, effort, timings, instructions, image path and archive state. |
| `recipe_ingredients` | Generic product requirements, optionally constrained to a variant. |
| `recipe_weekdays` | Monday-zero weekday eligibility; newly created recipes enable all weekdays. |
| `meal_recurrence_rules` | Weekly, fortnightly and four-week rules anchored to a real date. |
| `recurrence_exceptions` | Explicit one-date overrides and skipped occurrences without changing recurrence rules. |
| `meal_plan_entries` | Persisted fixed, random, override and unplanned dates. Recurrences are resolved from their rule and exceptions. |
| `shopping_items` | Manual, recipe and opt-in generic-product low-stock items. |
| `unit_conversions` | Explicit unit-to-unit multiplication factors; no implicit unit mixing is performed. |
| `app_settings` | JSON-encoded application preferences. |
| `barcode_lookup_cache` | Successful external lookup responses, indexed by exact barcode. |
| `idempotency_requests` | Durable request keys and responses for duplicate-safe stock operations. |
| `schema_migrations` | Applied migration number and timestamp. |

`reorder_level = 0` disables low-stock suggestions. Product stock is always
calculated by summing batch quantities in the product's declared stock unit;
package sizes are descriptive metadata and do not silently convert stock.
Recipe availability uses an explicit unit conversion or reports a quantity as
not comparable.

## Backup, restore and recovery

Home Assistant configuration backups include the database and SQLite sidecars.
The integration's explicit backup uses SQLite's online backup API, so committed
WAL contents are included. Restore stages a copy, runs `integrity_check`,
`foreign_key_check`, and schema checks, then replaces the live database and
runs migrations before reopening it. Keep an independent Home Assistant backup
before restoring. JSON and per-table CSV exports are for inspection or
portability and are not an alternate live database.
