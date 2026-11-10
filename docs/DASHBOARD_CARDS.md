# Lovelace cards

After installing the integration, add this Lovelace JavaScript module as a
dashboard resource:

```yaml
url: /dans_kitchen/cards.js
type: module
```

The integration serves this bundled file locally; no CDN is used. Add cards
with Home Assistant's visual card picker or YAML:

```yaml
type: custom:dans-kitchen-today-card
```

```yaml
type: custom:dans-kitchen-planner-card
days: 7
```

Available elements:

- `dans-kitchen-today-card`
- `dans-kitchen-planner-card`
- `dans-kitchen-shopping-card`
- `dans-kitchen-low-stock-card`
- `dans-kitchen-inventory-card`
- `dans-kitchen-suggestions-card`

The planner card supports 1–14 upcoming days. The suggestion card accepts an
optional ISO date. Cards use the authenticated Home Assistant WebSocket API and
the same backend calculations as the panel and summary sensors.
