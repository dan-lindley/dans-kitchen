# Changelog

## 0.2.6

- Added camera scanning directly to the unified Add product card and routed
  scanned results back into that form.
- Made USB/Bluetooth barcode scanners trigger lookup when they send Enter, and
  clarified that browser camera access requires HTTPS or localhost.

## 0.2.5

- Replaced the separate add-product and barcode-registration prompts with one
  responsive product card containing lookup, product and brand details,
  generic-product assignment, storage location and quantity controls.
- Added distinct **Add to products** and **Add to stock** actions, including
  exact handling for barcodes already present in the catalogue.

## 0.2.4

- Tightened recipe editor height to its content and increased spacing for clearer
  field labels and controls.
- Added persistent free-text recipe ingredients alongside saved product links,
  including safe migration and recipe-shopping-list support.

## 0.2.3

- Grouped optional recipe details under a collapsible Instructions section while
  keeping required fields and Save/Cancel controls visible.

## 0.2.2

- Kept recipe Save and Cancel controls visible while the form content scrolls.
- Replaced the full inventory ingredient list with a searchable add/remove picker.

## 0.2.1

- Versioned the Home Assistant panel asset URL so browsers reload the updated
  form-based UI instead of reusing a cached panel bundle.
- Added component-level regression coverage for opening the Add Product and
  Add Recipe forms without native browser dialogues.

## 0.2.0

- Replaced browser-native prompts and confirmations with styled, complete
  application forms and confirmation dialogs.
- Added a complete recipe editor. Name, effort, cooking time and at least one
  eligible weekday are now required; new recipes default to all seven weekdays.
- Enforced required recipe effort and cooking time in backend create, update,
  manual assignment and recurrence paths, and excluded incomplete legacy
  records from automatic suggestions.
- Improved backend barcode validation and Open Food Facts feedback, including
  check-digit validation, explicit network/service/not-found/incomplete states,
  and parsing quantities such as `400 g e`.
- Added recipe-form and barcode-lookup regression tests.

## 0.1.0

- Initial Dan's Kitchen integration using a dedicated, versioned SQLite database.
- Added generic products, branded variants, batch stock, expiry dates, auditable
  stock transactions, recipe ingredients, weekday eligibility, meal planning,
  recurrence exceptions, shopping, locations and persistent preferences.
- Added responsive Home Assistant panel, live camera barcode scanning with a
  bundled decoder fallback, Open Food Facts lookup and six Lovelace cards.
- Added backup, validated SQLite restore, JSON/CSV export, tests and CI.
