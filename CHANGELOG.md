# Changelog

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
