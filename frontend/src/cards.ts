import { css, html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistantLike, KitchenSnapshot } from "./types";

type CardKind = "today" | "planner" | "shopping" | "low-stock" | "inventory" | "suggestions";
type CardConfig = { type: string; days?: number; date?: string };
type CardHass = HomeAssistantLike & {
  navigate?: (path: string) => void;
};

const CARD_TYPES: Array<{ kind: CardKind; name: string; tag: string; description: string }> = [
  { kind: "today", name: "Dan's Kitchen Today", tag: "dans-kitchen-today-card", description: "Today's planned meal and preparation details." },
  { kind: "planner", name: "Dan's Kitchen Planner", tag: "dans-kitchen-planner-card", description: "Upcoming meals in the rolling planner." },
  { kind: "shopping", name: "Dan's Kitchen Shopping", tag: "dans-kitchen-shopping-card", description: "Outstanding shopping items." },
  { kind: "low-stock", name: "Dan's Kitchen Low Stock", tag: "dans-kitchen-low-stock-card", description: "Generic products below their reorder level." },
  { kind: "inventory", name: "Dan's Kitchen Inventory Summary", tag: "dans-kitchen-inventory-card", description: "Product, low-stock and expiry counts." },
  { kind: "suggestions", name: "Dan's Kitchen Meal Suggestions", tag: "dans-kitchen-suggestions-card", description: "Eligible meals for a selected calendar day." },
];

type CardData = {
  today: Record<string, unknown>;
  low_stock: Array<Record<string, unknown>>;
  shopping: Array<Record<string, unknown>>;
  expiring: Array<Record<string, unknown>>;
  inventory_product_count: number;
  planner?: { weeks: Array<{ days: Array<Record<string, unknown>> }> };
};

abstract class KitchenCard extends LitElement {
  @property({ attribute: false }) hass?: CardHass;
  @state() protected data?: CardData;
  @state() protected error = "";
  @state() protected suggestions: Array<Record<string, unknown>> = [];
  protected config: CardConfig = { type: "" };
  protected kind: CardKind = "today";
  private lastLoad = 0;
  private timer?: number;

  static styles = css`
    :host { display:block; }
    ha-card { color:var(--primary-text-color); background:var(--card-background-color); padding:14px; }
    h2 { font-size:16px; margin:0 0 10px; }
    p { margin:5px 0; }
    small, .secondary { color:var(--secondary-text-color); }
    button { color:var(--text-primary-color, #fff); background:var(--primary-color); border:0; border-radius:7px; padding:7px 10px; cursor:pointer; }
    ul { list-style:none; padding:0; margin:0; }
    li { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--divider-color); }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
    .stat { border:1px solid var(--divider-color); border-radius:8px; padding:9px; }
    .value { display:block; font-size:20px; font-weight:650; }
    .error { color:var(--error-color, #b3261e); }
  `;

  setConfig(config: CardConfig): void {
    this.config = config;
  }

  protected updated(): void {
    if (this.hass && Date.now() - this.lastLoad > 60_000) void this.load();
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.timer = window.setInterval(() => void this.load(), 60_000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) window.clearInterval(this.timer);
  }

  protected async load(): Promise<void> {
    if (!this.hass || Date.now() - this.lastLoad < 5000) return;
    this.lastLoad = Date.now();
    try {
      const snapshot = await this.hass.callWS<KitchenSnapshot>({
        type: "dans_kitchen/command",
        command: "get_data",
      });
      this.data = snapshot.dashboard as CardData;
      this.error = "";
      if (this.kind === "suggestions") await this.loadSuggestions();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Dan's Kitchen is not available.";
    }
  }

  protected async loadSuggestions(): Promise<void> {
    if (!this.hass) return;
    const day = this.config.date ?? new Date().toISOString().slice(0, 10);
    try {
      this.suggestions = await this.hass.callWS<Array<Record<string, unknown>>>({
        type: "dans_kitchen/command",
        command: "planner/eligible",
        data: { date: day },
      });
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Meal suggestions could not be loaded.";
    }
  }

  protected async command(command: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!this.hass) return;
    try {
      await this.hass.callWS({ type: "dans_kitchen/command", command, data });
      this.lastLoad = 0;
      await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "The request could not be completed.";
    }
  }

  protected openPanel(): void {
    this.hass?.navigate?.("/dans-kitchen");
  }

  protected renderCard() {
    if (this.error) return html`<p class="error" role="alert">${this.error}</p>`;
    if (!this.data) return html`<p class="secondary">Loading Dan's Kitchen…</p>`;
    switch (this.kind) {
      case "today": return this.renderToday();
      case "planner": return this.renderPlanner();
      case "shopping": return this.renderShopping();
      case "low-stock": return this.renderLowStock();
      case "inventory": return this.renderInventory();
      case "suggestions": return this.renderSuggestions();
    }
  }

  protected renderToday() {
    const meal = this.data!.today;
    const recipe = meal.recipe as Record<string, unknown> | null;
    return html`<h2>Today's meal</h2><p><strong>${String(meal.recipe_name ?? "Unplanned")}</strong></p>
      ${recipe ? html`<p class="secondary">${String(recipe.effort ?? "Effort unset")} · ${Number(recipe.preparation_minutes ?? 0) + Number(recipe.cooking_minutes ?? 0)} min</p><p class="secondary">${meal.availability ? "" : ""}</p>` : ""}
      <button @click=${() => this.openPanel()}>Open meal planner</button>`;
  }

  protected renderPlanner() {
    const count = Math.max(1, Math.min(14, this.config.days ?? 7));
    const days = this.data!.planner?.weeks.flatMap((week) => week.days).slice(0, count) ?? [];
    return html`<h2>Upcoming meals</h2><ul>${days.map((day) => html`<li><span>${String(day.date)}</span><strong>${String(day.recipe_name ?? "Unplanned")}</strong></li>`)}</ul>`;
  }

  protected renderShopping() {
    const items = this.data!.shopping.slice(0, 12);
    return html`<h2>Shopping list · ${this.data!.shopping.length}</h2>
      ${items.length ? html`<ul>${items.map((item) => html`<li><span>${String(item.product_name ?? item.custom_name)}</span>
        <button aria-label=${`Mark ${String(item.product_name ?? item.custom_name)} purchased`} @click=${() => this.command("shopping/status", { item_id: item.id, status: "purchased" })}>Done</button></li>`)}</ul>` : html`<p class="secondary">Nothing needed.</p>`}
      <button @click=${() => this.openPanel()}>Open shopping</button>`;
  }

  protected renderLowStock() {
    const products = this.data!.low_stock.slice(0, 12);
    return html`<h2>Low stock · ${this.data!.low_stock.length}</h2>
      ${products.length ? html`<ul>${products.map((item) => html`<li><span>${String(item.name)}</span><small>${String(item.quantity)} / ${String(item.reorder_level)} ${String(item.stock_unit)}</small></li>`)}</ul>` : html`<p class="secondary">No products need replenishing.</p>`}`;
  }

  protected renderInventory() {
    return html`<h2>Inventory summary</h2><div class="stats">
      <div class="stat"><span class="value">${this.data!.inventory_product_count}</span><small>Products</small></div>
      <div class="stat"><span class="value">${this.data!.low_stock.length}</span><small>Low stock</small></div>
      <div class="stat"><span class="value">${this.data!.expiring.length}</span><small>Expiring</small></div>
    </div>`;
  }

  protected renderSuggestions() {
    return html`<h2>Eligible meals</h2><ul>${this.suggestions.slice(0, 8).map((recipe) => html`<li><span>${String(recipe.name)}</span><small>${String(recipe.effort ?? "—")}</small></li>`)}</ul>
      <button @click=${() => this.loadSuggestions()}>Refresh</button>`;
  }

  render() {
    return html`<ha-card>${this.renderCard()}</ha-card>`;
  }
}

for (const definition of CARD_TYPES) {
  const CardElement = class extends KitchenCard {
    protected kind = definition.kind;
    static getStubConfig(): CardConfig {
      return { type: `custom:${definition.tag}`, days: 7 };
    }
    static getConfigElement(): HTMLElement {
      return document.createElement("dans-kitchen-card-editor");
    }
  };
  customElements.define(definition.tag, CardElement);
}

@customElement("dans-kitchen-card-editor")
class KitchenCardEditor extends LitElement {
  @property({ attribute: false }) hass?: CardHass;
  @property({ type: Object }) config: CardConfig = { type: "" };

  static styles = css`
    :host { display:grid; gap:10px; }
    label { display:grid; gap:5px; }
    input { min-height:36px; }
  `;

  setConfig(config: CardConfig): void {
    this.config = config;
  }

  render() {
    return html`<label>Number of upcoming days<input type="number" min="1" max="14" .value=${String(this.config.days ?? 7)}
      @change=${(event: Event) => this.emitConfig({ days: Number((event.currentTarget as HTMLInputElement).value) })}></label>
      <label>Suggestion date (optional, YYYY-MM-DD)<input type="date" .value=${this.config.date ?? ""}
      @change=${(event: Event) => this.emitConfig({ date: (event.currentTarget as HTMLInputElement).value || undefined })}></label>`;
  }

  private emitConfig(changes: Partial<CardConfig>): void {
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: { ...this.config, ...changes } },
      bubbles: true,
      composed: true,
    }));
  }
}

declare global {
  interface Window {
    customCards?: Array<{ type: string; name: string; description: string; preview?: boolean }>;
  }
}

window.customCards = window.customCards ?? [];
for (const definition of CARD_TYPES) {
  if (!window.customCards.some((card) => card.type === definition.tag)) {
    window.customCards.push({
      type: definition.tag,
      name: definition.name,
      description: definition.description,
      preview: true,
    });
  }
}
