# Dan's Kitchen

Dan's Kitchen is a local-first Home Assistant custom integration for household
inventory, recipes, four-week meal planning and shopping. It is an independent
project with the `dans_kitchen` domain and a dedicated SQLite data store.

## Features

- Generic products with separate branded variants, exact text barcodes and
  multiple expiry-aware stock batches.
- Auditable add/use/correct/discard/transfer transactions and duplicate-safe
  request keys. Stock is consumed from earliest-expiring batches first by
  default; negative stock and implicit unit conversions are rejected.
- Generic-product reorder thresholds, optional location defaults, safe
  location renaming/deletion and user-managed locations.
- Optional recipe ingredients, exact-variant constraints, explicit unit
  conversions, quantity availability and Monday-zero weekday eligibility.
- Persistent rolling four-week planner, fixed/random/recurring/override states,
  weekly/fortnightly/four-week recurrences, one-date exceptions and varied
  automatic suggestions.
- Manual shopping items, explicit low-stock refresh, recipe ingredient
  shopping, purchased/dismissed states and inventory intake.
- Responsive Home Assistant panel with four tabs, compact inventory and recipe
  tables/tiles, barcode registration, settings, exports, backup and restore.
- Rear-camera barcode scanning on secure origins using native
  `BarcodeDetector` when available and bundled ZXing fallback otherwise.
  Manual barcode entry remains available when camera APIs are not.
- Eight summary entities, documented Home Assistant actions and six local
  Lovelace cards.

Open Food Facts is queried only after an exact local barcode miss and when
external lookup is enabled. Normal inventory operations do not require
internet access. Camera APIs generally require HTTPS (or localhost); the UI
states this and offers manual barcode entry.

## Installation

1. In HACS, add `https://github.com/dan-lindley/dans-kitchen` as a custom
   **Integration** repository and download Dan's Kitchen.
2. Restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration** and select
   **Dan's Kitchen**.
4. Open **Dan's Kitchen** in the sidebar. The integration creates its SQLite
   database below the Home Assistant configuration directory.
5. To use dashboard cards, add `/dans_kitchen/cards.js` as a dashboard resource
   with type **JavaScript module**. Examples are in
   [docs/DASHBOARD_CARDS.md](docs/DASHBOARD_CARDS.md).

For manual installation, copy `custom_components/dans_kitchen` into the
Home Assistant configuration's `custom_components` directory and restart.

## Home Assistant actions

Actions are available under `dans_kitchen`: `add_product`, `add_stock`,
`use_stock`, `correct_stock`, `add_shopping_item`,
`complete_shopping_item`, `plan_meal`, `shuffle_meal`, and `suggest_meals`.
Each returns response data for scripts and automations. Input fields and
examples are described in the integration's Actions UI and `services.yaml`.

## Data and backup

See [docs/DATABASE.md](docs/DATABASE.md) for the relational schema, migration
policy, unit rules and backup/restore details. Home Assistant configuration
backups include the database. The Settings tab also supports SQLite backup,
validated restore, JSON export and CSV exports. Never put real household data
or credentials in source control.

## Development

Python 3.12+:

```text
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
py -3 -m pip install -r requirements_test.txt
py -3 -m pytest
py -3 -m ruff check custom_components tests
```

Frontend:

```text
cd frontend
npm ci
npm run typecheck
npm test
npm run build
```

The frontend build writes the local panel and dashboard card bundles to
`custom_components/dans_kitchen/frontend/dist`. The CI workflow tests backend
and frontend code on clean Linux runners.

## Scope and limitations

- This is the initial `0.1.0` release. It does not use Grocy, Home Assistant
  Recorder, a separate server or a remote database.
- Product and recipe image paths are metadata; image upload and management are
  not part of this release.
- Companion App native barcode APIs are not assumed. Camera scanning uses
  browser APIs and an offline bundled decoder.
- Sensor attributes are intentionally bounded to avoid large Home Assistant
  states. Detailed records remain in SQLite and the panel.
- A Home Assistant instance is needed to verify the integration's runtime
  registration, entity lifecycle and camera permissions. Automated unit tests
  exercise the SQLite backend and planner independently.
