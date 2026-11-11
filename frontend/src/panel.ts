import { BrowserMultiFormatReader } from "@zxing/browser";
import { html, LitElement, nothing, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { WEEKDAY_NAMES, weekdayMondayZero } from "./date";
import { createRecipeDraft, recipeDraftPayload, type RecipeDraft } from "./recipe-form";
import type {
  HomeAssistantLike,
  KitchenSnapshot,
  Location,
  PlannerDay,
  Product,
  Recipe,
  ShoppingItem,
  Variant,
} from "./types";

type Tab = "kitchen" | "meals" | "shopping" | "settings";
type ScannerControls = { stop(): void };
type FormField = {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "textarea";
  value?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number | "any";
  options?: Array<{ value: string; label: string }>;
  help?: string;
};
type FormValues = Record<string, string>;
type AppForm = { title: string; description?: string; fields: FormField[]; submitLabel?: string };

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => {
      detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
    };
  }
}

@customElement("dans-kitchen-panel")
export class DansKitchenPanel extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistantLike;
  @state() private tab: Tab = "kitchen";
  @state() private snapshot?: KitchenSnapshot;
  @state() private loading = false;
  @state() private working = false;
  @state() private error = "";
  @state() private notice = "";
  @state() private search = "";
  @state() private locationFilter = "";
  @state() private lowStockOnly = false;
  @state() private expiringOnly = false;
  @state() private inventoryPage = 1;
  @state() private inventorySort: "name" | "stock" | "location" | "reorder" | "expiry" = "name";
  @state() private inventoryDescending = false;
  @state() private expandedProduct = "";
  @state() private selectedProduct?: Product;
  @state() private productHistory: Array<Record<string, unknown>> = [];
  @state() private mealSearch = "";
  @state() private mealEffort = "";
  @state() private mealMaxTime = "";
  @state() private mealPage = 1;
  @state() private plannerDay?: PlannerDay;
  @state() private eligibleMeals: Recipe[] = [];
  @state() private includeIneligible = false;
  @state() private pickerSearch = "";
  @state() private pickerEffort = "";
  @state() private pickerMaxTime = "";
  @state() private pickerAvailableOnly = false;
  @state() private pickerPage = 1;
  @state() private shoppingSearch = "";
  @state() private shoppingStatus = "needed";
  @state() private scannerOpen = false;
  @state() private unknownBarcode?: Record<string, unknown>;
  @state() private barcode = "";
  @state() private scannerQuantity = "1";
  @state() private backupFiles: string[] = [];
  @state() private databaseInfo?: Record<string, unknown>;
  @state() private appForm?: AppForm;
  @state() private appFormError = "";
  @state() private recipeDraft?: RecipeDraft;
  @state() private recipeFormError = "";
  @state() private recipeIngredientSearch = "";
  @state() private recipeDetailsOpen = false;
  private scannerControls?: ScannerControls;
  private scannerStream?: MediaStream;
  private nativeScanFrame = 0;
  private lastBarcode = "";
  private lastBarcodeAt = 0;
  private appFormResolver?: (values: FormValues | undefined) => void;

  static styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
      background: var(--primary-background-color);
      min-height: 100%;
      font: 14px/1.45 var(--paper-font-body1_-_font-family, Roboto, sans-serif);
    }
    * { box-sizing: border-box; }
    main { max-width: 1440px; margin: 0 auto; padding: 18px clamp(12px, 2vw, 26px) 36px; }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    h1 { font-size:clamp(20px, 3vw, 27px); margin:0; font-weight:650; }
    h2 { font-size:18px; margin:0; }
    h3 { font-size:15px; margin:0 0 8px; }
    p { margin:5px 0; }
    .subtle, small { color:var(--secondary-text-color); }
    nav { display:flex; gap:6px; border-bottom:1px solid var(--divider-color); margin:0 -4px 16px; }
    nav button { background:transparent; color:var(--secondary-text-color); border:0; border-bottom:2px solid transparent; border-radius:0; padding:10px 14px; }
    nav button.active { color:var(--primary-color); border-bottom-color:var(--primary-color); font-weight:600; }
    button, input, select, textarea { font:inherit; }
    button { border:0; border-radius:8px; padding:8px 11px; color:var(--text-primary-color, #fff); background:var(--primary-color); cursor:pointer; }
    button.secondary { color:var(--primary-text-color); background:var(--secondary-background-color, var(--card-background-color)); border:1px solid var(--divider-color); }
    button.danger { color:var(--error-color, #b3261e); }
    button:disabled { opacity:.5; cursor:default; }
    input, select, textarea { color:var(--primary-text-color); background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:7px; padding:8px 10px; min-height:36px; }
    textarea { min-height:80px; resize:vertical; }
    label { display:grid; gap:4px; color:var(--secondary-text-color); font-size:12px; }
    .toolbar { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:end; gap:10px; margin-bottom:12px; }
    .filters { display:flex; flex-wrap:wrap; align-items:end; gap:8px; }
    .filters input[type=search] { min-width:min(310px, 72vw); }
    .section { background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:12px; padding:14px; margin-bottom:14px; box-shadow:var(--ha-card-box-shadow, 0 1px 3px #0001); }
    .section-heading { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; }
    .table-wrap { overflow:auto; }
    table { width:100%; border-collapse:collapse; text-align:left; }
    th, td { padding:9px 10px; border-bottom:1px solid var(--divider-color); vertical-align:middle; }
    th { font-size:12px; color:var(--secondary-text-color); font-weight:600; white-space:nowrap; }
    tbody tr.product-row { cursor:pointer; }
    tbody tr.product-row:hover { background:var(--table-row-background-color, color-mix(in srgb, var(--primary-color) 5%, transparent)); }
    .status { display:inline-flex; border-radius:20px; padding:2px 8px; font-size:11px; background:var(--secondary-background-color); }
    .status.low { color:var(--error-color, #b3261e); background:color-mix(in srgb, var(--error-color, #b3261e) 12%, var(--card-background-color)); }
    .variant-list { padding:8px 10px 10px 25px; background:var(--secondary-background-color); }
    .variant { display:grid; grid-template-columns:minmax(150px,1fr) repeat(3,minmax(90px,auto)); align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--divider-color); }
    .variant:last-child { border-bottom:0; }
    .actions { display:flex; flex-wrap:wrap; gap:5px; }
    .actions button { padding:6px 8px; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; }
    .tile { display:grid; text-align:left; align-content:start; min-height:78px; color:var(--primary-text-color); background:var(--card-background-color); border:1px solid var(--divider-color); padding:9px; }
    .tile strong { overflow-wrap:anywhere; }
    .tile small { margin-top:5px; }
    .planner { display:grid; grid-template-columns:repeat(7,minmax(110px,1fr)); gap:6px; overflow:auto; }
    .day { min-height:100px; text-align:left; color:var(--primary-text-color); background:var(--secondary-background-color); border:1px solid var(--divider-color); padding:8px; }
    .day.fixed { border-top:3px solid var(--primary-color); }
    .day.random { border-top:3px dotted var(--primary-color); }
    .day.recurring { border-top:3px double var(--primary-color); }
    .day.override { border-top:3px dashed var(--warning-color, #a15c00); }
    .day-name { font-size:11px; color:var(--secondary-text-color); }
    .day strong { display:block; margin:4px 0; overflow-wrap:anywhere; }
    .pagination { display:flex; justify-content:center; align-items:center; gap:12px; padding-top:12px; }
    .shop-list, .settings-list { list-style:none; padding:0; margin:0; }
    .shop-list li, .settings-list li { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:9px 2px; border-bottom:1px solid var(--divider-color); }
    .setting-row { display:grid; grid-template-columns:minmax(160px,1fr) minmax(160px,2fr) auto; align-items:center; gap:10px; padding:8px 0; }
    .notice { margin:10px 0; padding:9px 12px; border-radius:8px; color:var(--success-color, #176b3a); background:color-mix(in srgb, var(--success-color, #176b3a) 10%, var(--card-background-color)); }
    .error { margin:10px 0; padding:9px 12px; border-radius:8px; color:var(--error-color, #b3261e); background:color-mix(in srgb, var(--error-color, #b3261e) 10%, var(--card-background-color)); }
    .empty { color:var(--secondary-text-color); text-align:center; padding:24px 12px; }
    .week { margin:14px 0; }
    .week h3 { margin-bottom:7px; }
    .detail { border-top:1px solid var(--divider-color); margin-top:12px; padding-top:12px; }
    .detail-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .detail-grid .wide { grid-column:1/-1; }
    dialog { color:var(--primary-text-color); background:var(--card-background-color); border:1px solid var(--divider-color); border-radius:12px; width:min(580px, calc(100vw - 24px)); max-height:90vh; overflow:auto; padding:16px; }
    dialog.recipe-dialog { width:min(760px, calc(100vw - 24px)); max-height:calc(100vh - 32px); overflow:hidden; padding:0; }
    dialog::backdrop { background:#0008; }
    .dialog-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:7px; margin-top:14px; }
    dialog[open] { position:fixed; inset:50% auto auto 50%; transform:translate(-50%,-50%); margin:0; box-shadow:0 12px 40px #0004; z-index:10; }
    .app-form, .recipe-form { display:grid; gap:12px; }
    .form-fields { display:grid; gap:10px; }
    .recipe-form { display:flex; flex-direction:column; width:100%; min-width:0; max-height:calc(100vh - 32px); gap:0; overflow:hidden; }
    .recipe-header { flex:0 0 auto; margin:0; padding:14px 18px 12px; border-bottom:1px solid var(--divider-color); }
    .recipe-content { flex:0 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; padding:16px 18px; }
    .recipe-footer { flex:0 0 auto; padding:10px 18px; border-top:1px solid var(--divider-color); background:var(--card-background-color); }
    .recipe-footer .dialog-actions { margin-top:0; }
    .recipe-section-toggle { width:100%; display:flex; justify-content:space-between; align-items:center; gap:12px; text-align:left; padding:10px 12px; }
    .recipe-section-title { display:grid; gap:2px; }
    .recipe-section-chevron { font-size:18px; }
    .recipe-section-content[hidden] { display:none; }
    .recipe-section-content { padding-top:16px; }
    .recipe-content .detail-grid { gap:16px 18px; }
    .recipe-content label { gap:7px; color:var(--primary-text-color); font-size:13px; }
    .recipe-intro { display:grid; gap:4px; margin-bottom:10px; }
    .recipe-intro small { line-height:1.45; }
    .recipe-content .weekday-toggle { color:var(--secondary-text-color); font-size:12px; }
    .ingredient-picker { display:grid; gap:7px; }
    .ingredient-results { display:grid; gap:5px; max-height:150px; overflow:auto; }
    .ingredient-result, .ingredient-heading { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .ingredient-result { padding:5px 0 5px 8px; border-bottom:1px solid var(--divider-color); }
    .ingredient-result button, .ingredient-heading button { padding:5px 9px; }
    .ingredient-heading > span { display:grid; gap:3px; }
    .free-text-ingredient { justify-self:start; }
    .recipe-ingredient { padding:9px 0; border-bottom:1px solid var(--divider-color); }
    .ingredient-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-top:7px; }
    .recipe-content .detail-grid, .recipe-content label { min-width:0; }
    .weekday-toggle { display:grid; justify-items:center; gap:4px; color:var(--secondary-text-color); font-size:12px; border:1px solid var(--divider-color); border-radius:7px; padding:6px; }
    .weekday-toggle input { min-height:20px; }
    .form-error { color:var(--error-color, #b3261e); }
    video { width:100%; max-height:55vh; background:#000; border-radius:8px; object-fit:cover; }
    .weekdays { display:flex; flex-wrap:wrap; gap:7px; }
    .weekday { display:flex; align-items:center; gap:3px; border:1px solid var(--divider-color); border-radius:6px; padding:4px 6px; }
    @media (max-width: 900px) { .grid { grid-template-columns:repeat(3,minmax(0,1fr)); } .planner { grid-template-columns:repeat(7,minmax(94px,1fr)); } }
    @media (max-width: 600px) {
      main { padding:12px 9px 24px; } nav { overflow:auto; } nav button { padding:9px 10px; white-space:nowrap; }
      .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .planner { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .variant { grid-template-columns:1fr auto; } .variant .variant-meta { grid-column:1/-1; }
      .detail-grid { grid-template-columns:1fr; } .detail-grid .wide { grid-column:auto; }
      .ingredient-fields { grid-template-columns:1fr; }
      table thead { display:none; } table, tbody, tr, td { display:block; width:100%; } tr.product-row { padding:8px 0; border-bottom:1px solid var(--divider-color); }
      tr.product-row td { display:flex; justify-content:space-between; gap:10px; border:0; padding:3px 0; } tr.product-row td::before { content:attr(data-label); color:var(--secondary-text-color); font-size:11px; }
      .setting-row { grid-template-columns:1fr; } .filters { width:100%; } .filters label { flex:1; }
    }
  `;

  protected updated(): void {
    if (this.hass && !this.snapshot && !this.loading) void this.reload();
    if (this.scannerOpen) void this.startScannerIfNeeded();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopScanner();
  }

  private async request<T>(command: string, data: Record<string, unknown> = {}): Promise<T> {
    if (!this.hass) throw new Error("Home Assistant is not connected.");
    return this.hass.callWS<T>({ type: "dans_kitchen/command", command, data });
  }

  private requestForm(
    title: string,
    fields: FormField[],
    description?: string,
    submitLabel = "Save",
  ): Promise<FormValues | undefined> {
    if (this.appFormResolver) return Promise.reject(new Error("Another form is already open."));
    this.appFormError = "";
    this.appForm = { title, fields, description, submitLabel };
    return new Promise((resolve) => { this.appFormResolver = resolve; });
  }

  private closeAppForm(values?: FormValues): void {
    const resolve = this.appFormResolver;
    this.appFormResolver = undefined;
    this.appForm = undefined;
    this.appFormError = "";
    resolve?.(values);
  }

  private submitAppForm(event: Event): void {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (!this.appForm) return;
    const data = new FormData(form);
    const values: FormValues = {};
    for (const field of this.appForm.fields) {
      const value = String(data.get(field.key) ?? "");
      if (field.required && !value.trim()) {
        this.appFormError = `${field.label} is required.`;
        return;
      }
      if (field.type === "number" && value) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          this.appFormError = `${field.label} must be a number.`;
          return;
        }
        if (field.min !== undefined && number < field.min) {
          this.appFormError = `${field.label} must be at least ${field.min}.`;
          return;
        }
        if (field.max !== undefined && number > field.max) {
          this.appFormError = `${field.label} must be no more than ${field.max}.`;
          return;
        }
        if (typeof field.step === "number") {
          const base = field.min ?? 0;
          const stepCount = (number - base) / field.step;
          if (Math.abs(stepCount - Math.round(stepCount)) > 1e-8) {
            this.appFormError = `${field.label} must use increments of ${field.step}.`;
            return;
          }
        }
      }
      values[field.key] = value;
    }
    this.closeAppForm(values);
  }

  private async requestConfirmation(title: string, description: string, submitLabel: string): Promise<boolean> {
    return (await this.requestForm(title, [], description, submitLabel)) !== undefined;
  }

  private renderFormField(field: FormField) {
    const shared = {
      name: field.key,
      required: field.required ?? false,
    };
    if (field.type === "select") {
      return html`<label>${field.label}<select name=${field.key} ?required=${field.required ?? false}>
        ${field.options?.map((option) => html`<option value=${option.value} ?selected=${option.value === field.value}>${option.label}</option>`)}
      </select>${field.help ? html`<small>${field.help}</small>` : nothing}</label>`;
    }
    if (field.type === "textarea") {
      return html`<label>${field.label}<textarea name=${field.key} .value=${field.value ?? ""} ?required=${field.required ?? false}></textarea>
        ${field.help ? html`<small>${field.help}</small>` : nothing}</label>`;
    }
    return html`<label>${field.label}<input type=${field.type} name=${shared.name} .value=${field.value ?? ""}
      ?required=${shared.required} min=${field.min ?? nothing} max=${field.max ?? nothing} step=${field.step ?? nothing}>
      ${field.help ? html`<small>${field.help}</small>` : nothing}</label>`;
  }

  private async reload(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      this.snapshot = await this.request<KitchenSnapshot>("get_data");
      this.databaseInfo = this.snapshot.database;
    } catch (error) {
      this.error = this.message(error);
    } finally {
      this.loading = false;
    }
  }

  private async mutate(command: string, data: Record<string, unknown> = {}, message = "Saved."): Promise<void> {
    this.working = true;
    this.error = "";
    try {
      await this.request(command, data);
      await this.reload();
      this.notice = message;
    } catch (error) {
      this.error = this.message(error);
    } finally {
      this.working = false;
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : "The request could not be completed.";
  }

  private get products(): Product[] {
    return this.snapshot?.inventory.filter((product) => {
      const locationMatches = !this.locationFilter || product.variants.some((variant) =>
        variant.location_ids?.split(",").includes(this.locationFilter),
      );
      const search = this.search.trim().toLocaleLowerCase();
      const searchMatches = !search || product.name.toLocaleLowerCase().includes(search)
        || product.variants.some((variant) =>
          [variant.brand_name, variant.variant_name, variant.barcode]
            .some((value) => value?.toLocaleLowerCase().includes(search)),
        );
      return locationMatches && searchMatches && (!this.lowStockOnly || product.low_stock)
        && (!this.expiringOnly || Boolean(product.nearest_expiry));
    }).sort((a, b) => {
      const values: Record<typeof this.inventorySort, (item: Product) => string | number> = {
        name: (item) => item.name.toLocaleLowerCase(),
        stock: (item) => item.stock_quantity,
        location: (item) => (item.default_location_name ?? "").toLocaleLowerCase(),
        reorder: (item) => item.reorder_level,
        expiry: (item) => item.nearest_expiry ?? "9999-12-31",
      };
      const left = values[this.inventorySort](a);
      const right = values[this.inventorySort](b);
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), "en-GB");
      return this.inventoryDescending ? -comparison : comparison;
    }) ?? [];
  }

  private sortInventory(key: typeof this.inventorySort): void {
    if (this.inventorySort === key) this.inventoryDescending = !this.inventoryDescending;
    else { this.inventorySort = key; this.inventoryDescending = false; }
    this.inventoryPage = 1;
  }

  private get recipes(): Recipe[] {
    return [...(this.snapshot?.recipes ?? [])]
      .filter((recipe) => recipe.name.toLocaleLowerCase().includes(this.mealSearch.trim().toLocaleLowerCase()))
      .filter((recipe) => !this.mealEffort || recipe.effort === this.mealEffort)
      .filter((recipe) => !this.mealMaxTime || this.recipeMinutes(recipe) <= Number(this.mealMaxTime))
      .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
  }

  private get recipePageCount(): number {
    return Math.max(1, Math.ceil(this.recipes.length / 25));
  }

  private get pickerMeals(): Recipe[] {
    const query = this.pickerSearch.trim().toLocaleLowerCase();
    return this.eligibleMeals.filter((recipe) =>
      (!query || recipe.name.toLocaleLowerCase().includes(query))
      && (!this.pickerEffort || recipe.effort === this.pickerEffort)
      && (!this.pickerMaxTime || this.recipeMinutes(recipe) <= Number(this.pickerMaxTime))
      && (!this.pickerAvailableOnly || recipe.availability?.status === "available"),
    );
  }

  private formatDate(value: string | null): string {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })
      .format(new Date(`${value}T12:00:00`));
  }

  private locationName(id: string | null): string {
    return this.snapshot?.locations.find((location) => location.id === id)?.name ?? "Unassigned";
  }

  protected render() {
    return html`
      <main>
        <header><div><h1>Dan's Kitchen</h1><p class="subtle">Household food, recipes and meal planning</p></div>
          <button class="secondary" @click=${() => this.reload()} ?disabled=${this.loading} aria-label="Refresh data">Refresh</button></header>
        <nav aria-label="Kitchen sections">
          ${(["kitchen", "meals", "shopping", "settings"] as const).map((tab) => html`
            <button class=${this.tab === tab ? "active" : ""} @click=${() => { this.tab = tab; this.notice = ""; }}>
              ${{ kitchen: "My Kitchen", meals: "Meals", shopping: "Shopping", settings: "Settings" }[tab]}
            </button>`)}
        </nav>
        ${this.error ? html`<div class="error" role="alert">${this.error}</div>` : nothing}
        ${this.notice ? html`<div class="notice" role="status">${this.notice}</div>` : nothing}
        ${this.loading && !this.snapshot ? html`<div class="empty" role="status">Loading your kitchen…</div>` : nothing}
        ${this.snapshot ? this.renderTab() : nothing}
        ${this.renderDialogs()}
      </main>`;
  }

  private renderTab() {
    switch (this.tab) {
      case "kitchen": return this.renderKitchen();
      case "meals": return this.renderMeals();
      case "shopping": return this.renderShopping();
      case "settings": return this.renderSettings();
    }
  }

  private renderKitchen() {
    const products = this.products;
    const pageCount = Math.max(1, Math.ceil(products.length / 50));
    this.inventoryPage = Math.min(this.inventoryPage, pageCount);
    const pageProducts = products.slice((this.inventoryPage - 1) * 50, this.inventoryPage * 50);
    return html`
      <section class="section">
        <div class="toolbar"><div><h2>Inventory</h2><p class="subtle">Generic products with branded variants, batches and expiry tracking.</p></div>
          <div class="actions"><button @click=${() => this.openProductForm()}>Add product</button><button class="secondary" @click=${() => this.openScanner()}>Scan barcode</button></div></div>
        <div class="filters">
          <label>Search products<input type="search" .value=${this.search} @input=${(e: Event) => { this.search = (e.currentTarget as HTMLInputElement).value; }} placeholder="Name, brand or barcode"></label>
          <label>Storage location<select .value=${this.locationFilter} @change=${(e: Event) => { this.locationFilter = (e.currentTarget as HTMLSelectElement).value; }}>
            <option value="">All locations</option>${this.snapshot!.locations.map((location) => html`<option value=${location.id}>${location.name}</option>`)}
          </select></label>
          <label class="weekday"><input type="checkbox" .checked=${this.lowStockOnly} @change=${(e: Event) => { this.lowStockOnly = (e.currentTarget as HTMLInputElement).checked; }}>Low stock</label>
          <label class="weekday"><input type="checkbox" .checked=${this.expiringOnly} @change=${(e: Event) => { this.expiringOnly = (e.currentTarget as HTMLInputElement).checked; }}>Has expiry</label>
          <label>Sort by<select .value=${this.inventorySort} @change=${(e: Event) => this.sortInventory((e.currentTarget as HTMLSelectElement).value as typeof this.inventorySort)}>
            <option value="name">Name</option><option value="stock">Stock</option><option value="location">Location</option><option value="reorder">Reorder level</option><option value="expiry">Nearest expiry</option>
          </select></label>
        </div>
        ${pageProducts.length ? html`<div class="table-wrap"><table aria-label="Food inventory"><thead><tr>
          <th><button class="secondary" @click=${() => this.sortInventory("name")}>Product ${this.inventorySort === "name" ? (this.inventoryDescending ? "↓" : "↑") : ""}</button></th>
          <th><button class="secondary" @click=${() => this.sortInventory("stock")}>Total stock ${this.inventorySort === "stock" ? (this.inventoryDescending ? "↓" : "↑") : ""}</button></th>
          <th><button class="secondary" @click=${() => this.sortInventory("location")}>Default location ${this.inventorySort === "location" ? (this.inventoryDescending ? "↓" : "↑") : ""}</button></th>
          <th><button class="secondary" @click=${() => this.sortInventory("reorder")}>Reorder ${this.inventorySort === "reorder" ? (this.inventoryDescending ? "↓" : "↑") : ""}</button></th>
          <th>Status</th><th><button class="secondary" @click=${() => this.sortInventory("expiry")}>Nearest expiry ${this.inventorySort === "expiry" ? (this.inventoryDescending ? "↓" : "↑") : ""}</button></th><th></th>
        </tr></thead><tbody>${pageProducts.map((product) => html`
          <tr class="product-row" @click=${() => this.toggleProduct(product.id)}>
            <td data-label="Product"><strong>${product.name}</strong><small> ${product.variants.length} variant${product.variants.length === 1 ? "" : "s"}</small></td>
            <td data-label="Total stock">${product.stock_quantity} ${product.stock_unit}</td>
            <td data-label="Default location">${product.default_location_name ?? "—"}</td>
            <td data-label="Reorder">${product.reorder_level || "Off"} ${product.reorder_level ? product.stock_unit : ""}</td>
            <td data-label="Status"><span class="status ${product.low_stock ? "low" : ""}">${product.low_stock ? "Low stock" : "In stock"}</span></td>
            <td data-label="Nearest expiry">${this.formatDate(product.nearest_expiry)}</td>
            <td data-label="Actions"><button class="secondary" @click=${(e: Event) => { e.stopPropagation(); void this.openProduct(product.id); }}>Details</button></td>
          </tr>
          ${this.expandedProduct === product.id ? html`<tr><td colspan="7"><div class="variant-list">
            ${product.variants.length ? product.variants.map((variant) => this.renderVariant(product, variant)) : html`<p class="subtle">No branded variants yet.</p>`}
            <button class="secondary" @click=${() => this.openVariantForm(product)}>Add variant</button>
          </div></td></tr>` : nothing}`)}          </tbody></table></div>
          <div class="pagination"><button class="secondary" @click=${() => this.inventoryPage--} ?disabled=${this.inventoryPage <= 1}>Previous</button>
            <span>Page ${this.inventoryPage} of ${pageCount} · ${products.length} products</span>
            <button class="secondary" @click=${() => this.inventoryPage++} ?disabled=${this.inventoryPage >= pageCount}>Next</button></div>`
          : html`<div class="empty">${this.snapshot!.inventory.length ? "No products match these filters." : "Your inventory is empty. Add a generic product to get started."}</div>`}
      </section>
      ${this.selectedProduct ? this.renderProductDetail() : nothing}
    `;
  }

  private renderVariant(product: Product, variant: Variant) {
    return html`<div class="variant">
      <div><strong>${variant.brand_name ?? "Unbranded"} ${variant.variant_name ?? ""}</strong><br><small>${variant.barcode ? `Barcode ${variant.barcode}` : "No barcode"}${variant.package_size ? ` · ${variant.package_size} ${variant.package_unit}` : ""}</small></div>
      <span class="variant-meta">${variant.stock_quantity} ${product.stock_unit}</span>
      <span class="variant-meta">${this.formatDate(variant.nearest_expiry)}</span>
      <div class="actions"><button class="secondary" @click=${() => this.stockAction(product, variant, "add")}>Add</button><button class="secondary" @click=${() => this.stockAction(product, variant, "use")}>Use</button><button class="secondary" @click=${() => this.editVariant(product, variant)}>Edit</button></div>
    </div>`;
  }

  private renderProductDetail() {
    const product = this.selectedProduct!;
    return html`<section class="section">
      <div class="section-heading"><div><h2>${product.name}</h2><p class="subtle">${product.stock_quantity} ${product.stock_unit} total stock</p></div>
        <div class="actions"><button class="secondary" @click=${() => this.editProduct(product)}>Edit product</button><button class="secondary" @click=${() => this.closeProduct()}>Close</button></div></div>
      <div class="actions"><button @click=${() => this.stockAction(product, undefined, "add")}>Add stock</button><button class="secondary" @click=${() => this.stockAction(product, undefined, "use")}>Use stock</button><button class="secondary" @click=${() => this.refreshProductDetails(product.id)}>Refresh history</button></div>
      <h3 style="margin-top:14px">Variants and batches</h3>
      ${product.variants.map((variant) => html`<div class="detail">
        ${this.renderVariant(product, variant)}
        ${(variant.batches ?? []).map((batch) => html`<div class="variant"><span>Batch · ${this.locationName(batch.location_id)} · use by ${this.formatDate(batch.use_by_date)} · best before ${this.formatDate(batch.best_before_date)}</span><span>${batch.quantity} ${product.stock_unit}</span><span></span>
          <button class="secondary" @click=${() => this.correctBatch(batch.id, batch.quantity)}>Correct</button></div>`)}
      </div>`)}
      <h3 style="margin-top:14px">Recent stock transactions</h3>
      ${this.productHistory.length ? html`<ul class="shop-list">${this.productHistory.map((record) => html`<li><span>${String(record.transaction_type)} · ${String(record.reason ?? "Stock change")}</span><small>${String(record.quantity_change)} ${product.stock_unit} · ${this.formatDate(String(record.timestamp).slice(0, 10))}</small></li>`)}</ul>` : html`<p class="subtle">No transactions recorded yet.</p>`}
    </section>`;
  }

  private async toggleProduct(productId: string): Promise<void> {
    this.expandedProduct = this.expandedProduct === productId ? "" : productId;
  }

  private async openProduct(productId: string): Promise<void> {
    try {
      const details = await this.request<{ product: Product; history: Array<Record<string, unknown>> }>("product/detail", { product_id: productId });
      this.selectedProduct = details.product;
      this.productHistory = details.history;
      this.expandedProduct = productId;
    } catch (error) { this.error = this.message(error); }
  }

  private async refreshProductDetails(productId: string): Promise<void> {
    await this.openProduct(productId);
  }

  private closeProduct(): void { this.selectedProduct = undefined; this.productHistory = []; }

  private async openProductForm(): Promise<void> {
    const values = await this.requestForm("Add product", [
      { key: "name", label: "Generic product name", type: "text", required: true },
      { key: "stock_unit", label: "Stock unit (for example tin, bottle or kg)", type: "text", value: "item", required: true },
      { key: "reorder_level", label: "Reorder threshold (0 disables)", type: "number", value: "0", min: 0, step: "any" },
      this.locationField("default_location_id"),
    ]);
    if (!values) return;
    this.working = true;
    try {
      const product = await this.request<Product>("product/create", {
        name: values.name.trim(), stock_unit: values.stock_unit.trim(),
        reorder_level: Number(values.reorder_level || 0), default_location_id: values.default_location_id || undefined,
      });
      await this.request("variant/create", { product_id: product.id });
      await this.reload();
      this.notice = `Added ${product.name}.`;
    } catch (error) { this.error = this.message(error); }
    finally { this.working = false; }
  }

  private async editProduct(product: Product): Promise<void> {
    const values = await this.requestForm("Edit product", [
      { key: "name", label: "Generic product name", type: "text", value: product.name, required: true },
      { key: "stock_unit", label: "Stock unit", type: "text", value: product.stock_unit, required: true },
      { key: "reorder_level", label: `Reorder level in ${product.stock_unit} (0 disables)`, type: "number", value: String(product.reorder_level), min: 0, step: "any" },
      this.locationField("default_location_id", product.default_location_id ?? ""),
    ]);
    if (!values) return;
    await this.mutate("product/update", {
      product_id: product.id, name: values.name.trim(), stock_unit: values.stock_unit.trim(),
      reorder_level: Number(values.reorder_level),
      default_location_id: values.default_location_id || null,
    }, "Product updated.");
    await this.openProduct(product.id);
  }

  private async editVariant(product: Product, variant: Variant): Promise<void> {
    const values = await this.requestForm("Edit product variant", [
      { key: "brand_name", label: "Brand name", type: "text", value: variant.brand_name ?? "" },
      { key: "variant_name", label: "Variant name", type: "text", value: variant.variant_name ?? "" },
      { key: "barcode", label: "Barcode (leave blank to clear)", type: "text", value: variant.barcode ?? "" },
      { key: "package_size", label: "Package size (leave blank to clear)", type: "number", value: variant.package_size === null ? "" : String(variant.package_size), min: 0, step: "any" },
      { key: "package_unit", label: "Package unit", type: "text", value: variant.package_unit ?? product.stock_unit },
    ]);
    if (!values) return;
    const size = values.package_size.trim();
    await this.mutate("variant/update", {
      variant_id: variant.id,
      brand_name: values.brand_name || null,
      variant_name: values.variant_name || null,
      barcode: values.barcode || null,
      package_size: size ? Number(size) : null,
      package_unit: size ? values.package_unit || product.stock_unit : null,
    }, "Variant updated.");
    await this.openProduct(product.id);
  }

  private locationField(key: string, value = "", label = "Default storage location"): FormField {
    return {
      key, label, type: "select", value,
      options: [{ value: "", label: "No default location" }, ...(this.snapshot?.locations ?? []).map((location) => ({ value: location.id, label: location.name }))],
    };
  }

  private async openVariantForm(product: Product): Promise<void> {
    const values = await this.requestForm("Add product variant", [
      { key: "brand_name", label: "Brand name (optional)", type: "text" },
      { key: "variant_name", label: "Variant description (optional)", type: "text" },
      { key: "barcode", label: "Barcode (optional)", type: "text" },
      { key: "package_size", label: "Package size (optional)", type: "number", min: 0, step: "any" },
      { key: "package_unit", label: "Package unit", type: "text", value: product.stock_unit },
    ]);
    if (!values) return;
    const size = values.package_size.trim();
    await this.mutate("variant/create", {
      product_id: product.id,
      brand_name: values.brand_name || undefined,
      variant_name: values.variant_name || undefined,
      barcode: values.barcode || undefined,
      package_size: size ? Number(size) : undefined,
      package_unit: size ? values.package_unit || product.stock_unit : undefined,
    }, "Variant added.");
    await this.openProduct(product.id);
  }

  private async stockAction(product: Product, variant: Variant | undefined, action: "add" | "use"): Promise<void> {
    if (action === "add" && !product.variants.length) {
      this.error = "Add a product variant before adding stock.";
      return;
    }
    const fields: FormField[] = [
      { key: "quantity", label: `${action === "add" ? "Add" : "Use"} quantity in ${product.stock_unit}`, type: "number", value: "1", required: true, min: 0.001, step: "any" },
    ];
    if (action === "add" && !variant && product.variants.length > 1) {
      fields.push({
        key: "variant_id", label: "Product variant", type: "select", required: true,
        options: product.variants.map((item) => ({ value: item.id, label: `${item.brand_name ?? "Unbranded"} ${item.variant_name ?? ""}`.trim() })),
      });
    }
    if (action === "add") {
      fields.push(this.locationField("location_id", product.default_location_id ?? "", "Storage location for this stock addition"));
      fields.push(
        { key: "best_before_date", label: "Best-before date (optional)", type: "date" },
        { key: "use_by_date", label: "Use-by date (optional)", type: "date" },
      );
    }
    const values = await this.requestForm(`${action === "add" ? "Add" : "Use"} stock · ${product.name}`, fields);
    if (!values) return;
    const quantity = Number(values.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      this.error = "Quantity must be greater than zero.";
      return;
    }
    try {
      if (action === "add") {
        const variantId = variant?.id ?? values.variant_id ?? product.variants[0]?.id;
        if (!variantId) throw new Error("Add a product variant before adding stock.");
        await this.request("stock/add", {
          variant_id: variantId, quantity, location_id: values.location_id || undefined,
          best_before_date: values.best_before_date || undefined, use_by_date: values.use_by_date || undefined,
        });
      } else {
        await this.request("stock/use", { product_id: product.id, variant_id: variant?.id, quantity });
      }
      await this.reload();
      this.notice = `${action === "add" ? "Added" : "Used"} ${quantity} ${product.stock_unit}.`;
      if (this.selectedProduct?.id === product.id) await this.openProduct(product.id);
    } catch (error) { this.error = this.message(error); }
  }

  private async correctBatch(batchId: string, quantity: number): Promise<void> {
    const values = await this.requestForm("Correct batch quantity", [
      { key: "quantity", label: "Quantity", type: "number", value: String(quantity), required: true, min: 0, step: "any" },
    ]);
    if (!values) return;
    await this.mutate("stock/correct", { batch_id: batchId, quantity: Number(values.quantity), reason: "Manual correction" }, "Stock corrected.");
    if (this.selectedProduct) await this.openProduct(this.selectedProduct.id);
  }

  private renderMeals() {
    const meals = this.recipes.slice((this.mealPage - 1) * 25, this.mealPage * 25);
    return html`
      <section class="section">
        <div class="toolbar"><div><h2>Four-week meal planner</h2><p class="subtle">Fixed, random, recurring and override assignments are saved locally.</p></div>
          <button @click=${() => this.suggestMeals()} ?disabled=${this.working}>${this.working ? "Suggesting…" : "Suggest meals"}</button></div>
        ${this.snapshot!.planner.weeks.map((week) => html`<div class="week">
          <h3>Week commencing ${this.formatDate(week.start_date)}</h3>
          <div class="planner">${week.days.map((day) => this.renderDay(day))}</div>
        </div>`)}
      </section>
      <section class="section">
        <div class="toolbar"><div><h2>Recipe library</h2><p class="subtle">Name-only recipes are supported. Select a tile to view or edit.</p></div>
          <button @click=${() => this.createRecipe()}>Add recipe</button></div>
        <div class="filters">
          <label>Search recipes<input type="search" .value=${this.mealSearch} @input=${(e: Event) => { this.mealSearch = (e.currentTarget as HTMLInputElement).value; this.mealPage = 1; }}></label>
          <label>Effort<select .value=${this.mealEffort} @change=${(e: Event) => { this.mealEffort = (e.currentTarget as HTMLSelectElement).value; this.mealPage = 1; }}>
            <option value="">Any effort</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select></label>
          <label>Maximum total time<input type="number" min="0" .value=${this.mealMaxTime} @input=${(e: Event) => { this.mealMaxTime = (e.currentTarget as HTMLInputElement).value; this.mealPage = 1; }} placeholder="Any time"></label>
        </div>
        ${meals.length ? html`<div class="grid">${meals.map((recipe) => html`<button class="tile" @click=${() => this.editRecipe(recipe)}>
          <strong>${recipe.name}</strong><small>${recipe.effort ?? "Effort not set"} · ${this.recipeMinutes(recipe)} min · ${recipe.availability.status === "available" ? "Ingredients ready" : recipe.availability.status === "no_ingredients" ? "No ingredients" : `${recipe.availability.missing_count} missing`}</small>
          <small>${recipe.weekdays.map((weekday) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][weekday]).join(" · ")}</small>
        </button>`)}</div>
        <div class="pagination"><button class="secondary" @click=${() => this.mealPage--} ?disabled=${this.mealPage <= 1}>Previous</button>
          <span>Page ${this.mealPage} of ${this.recipePageCount} · ${this.recipes.length} recipes</span>
          <button class="secondary" @click=${() => this.mealPage++} ?disabled=${this.mealPage >= this.recipePageCount}>Next</button></div>`
        : html`<div class="empty">${this.snapshot!.recipes.length ? "No recipes match the search or filters." : "No recipes yet. Add a recipe to begin."}</div>`}
      </section>`;
  }

  private recipeMinutes(recipe: Recipe): number {
    return (recipe.preparation_minutes ?? 0) + (recipe.cooking_minutes ?? 0);
  }

  private renderDay(day: PlannerDay) {
    return html`<button class="day ${day.assignment_type}" @click=${() => this.openPlannerDay(day)}>
      <span class="day-name">${WEEKDAY_NAMES[weekdayMondayZero(day.date)]} · ${this.formatDate(day.date)}</span>
      <strong>${day.recipe_name ?? "Unplanned"}</strong>
      <small>${day.assignment_type[0].toUpperCase()}${day.assignment_type.slice(1)}</small>
    </button>`;
  }

  private async suggestMeals(): Promise<void> {
    this.working = true;
    try {
      const result = await this.request<{ changed_dates: string[]; unavailable_dates: string[]; preserved_fixed_count: number; preserved_recurring_count: number; unchanged_random_count: number }>("planner/suggest");
      await this.reload();
      this.notice = result.changed_dates.length
        ? `Planner updated: ${result.changed_dates.length} dates changed; ${result.preserved_fixed_count} fixed and ${result.preserved_recurring_count} recurring entries preserved.${result.unavailable_dates.length ? ` No eligible recipes on ${result.unavailable_dates.map((day) => this.formatDate(day)).join(", ")}.` : ""}`
        : `No dates changed.${result.unchanged_random_count ? ` ${result.unchanged_random_count} random suggestions had no better eligible alternatives.` : ""}`;
    } catch (error) { this.error = this.message(error); }
    finally { this.working = false; }
  }

  private async openPlannerDay(day: PlannerDay): Promise<void> {
    this.plannerDay = day;
    this.includeIneligible = false;
    this.pickerSearch = "";
    this.pickerEffort = "";
    this.pickerMaxTime = "";
    this.pickerAvailableOnly = false;
    this.pickerPage = 1;
    await this.loadEligibleMeals();
  }

  private async loadEligibleMeals(): Promise<void> {
    if (!this.plannerDay) return;
    try {
      if (this.includeIneligible) {
        this.eligibleMeals = this.snapshot?.recipes ?? [];
      } else {
        const eligible = await this.request<Array<{ id: string }>>("planner/eligible", { date: this.plannerDay.date });
        this.eligibleMeals = eligible.map((item) => this.snapshot?.recipes.find((recipe) => recipe.id === item.id)).filter((recipe): recipe is Recipe => Boolean(recipe));
      }
      this.pickerPage = 1;
    } catch (error) { this.error = this.message(error); }
  }

  private async createRecipe(): Promise<void> {
    this.recipeDraft = createRecipeDraft();
    this.recipeFormError = "";
    this.recipeIngredientSearch = "";
    this.recipeDetailsOpen = false;
  }

  private async editRecipe(recipe: Recipe): Promise<void> {
    this.recipeDraft = createRecipeDraft(recipe);
    this.recipeFormError = "";
    this.recipeIngredientSearch = "";
    this.recipeDetailsOpen = false;
  }

  private updateRecipeDraft<K extends keyof RecipeDraft>(key: K, value: RecipeDraft[K]): void {
    if (!this.recipeDraft) return;
    this.recipeDraft = { ...this.recipeDraft, [key]: value };
  }

  private toggleRecipeWeekday(day: number, enabled: boolean): void {
    const weekdays = new Set(this.recipeDraft?.weekdays ?? []);
    if (enabled) weekdays.add(day);
    else weekdays.delete(day);
    this.updateRecipeDraft("weekdays", [...weekdays].sort((a, b) => a - b));
  }

  private addRecipeIngredient(product: Product): void {
    if (!this.recipeDraft) return;
    if (this.recipeDraft.ingredients.some((item) => item.productId === product.id)) return;
    this.updateRecipeDraft("ingredients", [
      ...this.recipeDraft.ingredients,
      { productId: product.id, ingredientName: "", quantity: "", unit: "", variantId: "", notes: "" },
    ]);
    this.recipeIngredientSearch = "";
  }

  private addFreeTextRecipeIngredient(): void {
    if (!this.recipeDraft) return;
    const ingredientName = this.recipeIngredientSearch.trim();
    if (!ingredientName) return;
    this.updateRecipeDraft("ingredients", [
      ...this.recipeDraft.ingredients,
      { productId: "", ingredientName, quantity: "", unit: "", variantId: "", notes: "" },
    ]);
    this.recipeIngredientSearch = "";
  }

  private removeRecipeIngredient(index: number): void {
    if (!this.recipeDraft) return;
    this.updateRecipeDraft(
      "ingredients",
      this.recipeDraft.ingredients.filter((_, ingredientIndex) => ingredientIndex !== index),
    );
  }

  private get recipeIngredientMatches(): Product[] {
    const query = this.recipeIngredientSearch.trim().toLocaleLowerCase();
    if (!query) return [];
    return (this.snapshot?.inventory ?? [])
      .filter((product) => !this.recipeDraft?.ingredients.some((item) => item.productId === product.id))
      .filter((product) => [
        product.name,
        product.stock_unit,
        ...product.variants.flatMap((variant) => [
          variant.brand_name ?? "",
          variant.variant_name ?? "",
          variant.barcode ?? "",
        ]),
      ].some((value) => value.toLocaleLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name, "en-GB"))
      .slice(0, 8);
  }

  private updateRecipeIngredient(
    index: number,
    key: "quantity" | "unit" | "variantId" | "notes",
    value: string,
  ): void {
    if (!this.recipeDraft) return;
    this.updateRecipeDraft("ingredients", this.recipeDraft.ingredients.map((item, ingredientIndex) =>
      ingredientIndex === index ? { ...item, [key]: value } : item,
    ));
  }

  private async saveRecipe(): Promise<void> {
    if (!this.recipeDraft) return;
    const result = recipeDraftPayload(this.recipeDraft, this.snapshot?.inventory ?? []);
    if (!result.payload) {
      this.recipeFormError = result.error ?? "Check the recipe details.";
      return;
    }
    this.working = true;
    this.recipeFormError = "";
    try {
      await this.request(this.recipeDraft.recipeId ? "recipe/update" : "recipe/create", result.payload);
      await this.reload();
      this.notice = this.recipeDraft.recipeId ? "Recipe updated." : "Recipe created.";
      this.recipeDraft = undefined;
    } catch (error) {
      this.recipeFormError = this.message(error);
    } finally {
      this.working = false;
    }
  }

  private closeRecipeEditor(): void {
    this.recipeDraft = undefined;
    this.recipeFormError = "";
    this.recipeIngredientSearch = "";
  }

  private async duplicateRecipe(): Promise<void> {
    const draft = this.recipeDraft;
    if (!draft?.recipeId) return;
    const values = await this.requestForm("Duplicate recipe", [
      { key: "name", label: "Name for the duplicate", type: "text", value: `${draft.name.trim()} (copy)`, required: true },
    ]);
    if (!values) return;
    await this.mutate("recipe/duplicate", { recipe_id: draft.recipeId, name: values.name.trim() }, "Recipe duplicated.");
    this.recipeDraft = undefined;
  }

  private async archiveRecipe(recipe: Recipe): Promise<void> {
    const confirmed = await this.requestConfirmation(
      `Archive "${recipe.name}"?`,
      "The recipe will be removed from the active library. Existing planner history will remain.",
      "Archive recipe",
    );
    if (!confirmed) return;
    await this.mutate("recipe/archive", { recipe_id: recipe.id }, "Recipe archived.");
    this.recipeDraft = undefined;
  }

  private async renderShoppingAction(item: ShoppingItem, status: ShoppingItem["status"]): Promise<void> {
    await this.mutate("shopping/status", { item_id: item.id, status }, `Shopping item marked ${status}.`);
  }

  private get shoppingItems(): ShoppingItem[] {
    return (this.snapshot?.shopping ?? []).filter((item) => item.status === this.shoppingStatus)
      .filter((item) => `${item.product_name ?? ""} ${item.custom_name ?? ""}`.toLocaleLowerCase().includes(this.shoppingSearch.toLocaleLowerCase()));
  }

  private renderShopping() {
    return html`<section class="section">
      <div class="toolbar"><div><h2>Shopping list</h2><p class="subtle">Low-stock suggestions are generated only when you request them.</p></div>
        <div class="actions"><button @click=${() => this.addShoppingItem()}>Add item</button><button class="secondary" @click=${() => this.mutate("shopping/refresh_low_stock", {}, "Low-stock suggestions updated.")}>Refresh low-stock suggestions</button></div></div>
      <div class="filters"><label>Search<input type="search" .value=${this.shoppingSearch} @input=${(e: Event) => { this.shoppingSearch = (e.currentTarget as HTMLInputElement).value; }}></label>
        <label>Status<select .value=${this.shoppingStatus} @change=${(e: Event) => { this.shoppingStatus = (e.currentTarget as HTMLSelectElement).value; }}>
          <option value="needed">Needed</option><option value="purchased">Purchased</option><option value="dismissed">Dismissed</option>
        </select></label></div>
      ${this.shoppingItems.length ? html`<ul class="shop-list">${this.shoppingItems.map((item) => html`<li>
        <span><strong>${item.product_name ?? item.custom_name}</strong>${item.quantity ? ` · ${item.quantity} ${item.unit}` : ""}<small> · ${this.sourceName(item.source)}</small></span>
        <span class="actions">${item.status === "needed" ? html`<button @click=${() => this.completeShoppingItem(item)}>${item.product_id ? "Purchased + stock" : "Purchased"}</button><button class="secondary" @click=${() => this.renderShoppingAction(item, "dismissed")}>Dismiss</button>` : html`<button class="secondary" @click=${() => this.renderShoppingAction(item, "needed")}>Needed</button>`}<button class="secondary danger" @click=${() => this.deleteShoppingItem(item)}>Delete</button></span>
      </li>`)}</ul>` : html`<div class="empty">No ${this.shoppingStatus} shopping items match the current search.</div>`}
    </section>`;
  }

  private sourceName(source: string): string {
    return { manual: "Added manually", low_stock: "Low stock", recipe: "Recipe" }[source] ?? source;
  }

  private async addShoppingItem(): Promise<void> {
    const values = await this.requestForm("Add shopping item", [
      { key: "name", label: "Product name or custom item", type: "text", required: true },
      { key: "quantity", label: "Quantity (optional)", type: "number", min: 0.001, step: "any" },
      { key: "unit", label: "Unit (optional)", type: "text", value: "item" },
    ]);
    if (!values) return;
    const name = values.name.trim();
    const product = this.snapshot!.inventory.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const amount = values.quantity ? Number(values.quantity) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      this.error = "Shopping quantity must be greater than zero.";
      return;
    }
    await this.mutate("shopping/add", product
      ? { product_id: product.id, quantity: amount, unit: amount ? values.unit : undefined }
      : { custom_name: name, quantity: amount, unit: amount ? values.unit : undefined }, "Shopping item added.");
  }

  private async completeShoppingItem(item: ShoppingItem): Promise<void> {
    if (!item.product_id) {
      await this.renderShoppingAction(item, "purchased");
      return;
    }
    const product = this.snapshot!.inventory.find((entry) => entry.id === item.product_id);
    if (!product?.variants.length) {
      this.error = "Add a product variant before adding this purchase to inventory.";
      return;
    }
    const suggestedQuantity = item.unit === product.stock_unit ? item.quantity : 1;
    const values = await this.requestForm("Add purchase to inventory", [
      {
        key: "variant_id", label: "Product variant", type: "select", required: true,
        options: product.variants.map((variant) => ({ value: variant.id, label: `${variant.brand_name ?? "Unbranded"} ${variant.variant_name ?? ""}`.trim() })),
      },
      { key: "quantity", label: `Quantity in ${product.stock_unit}`, type: "number", value: String(suggestedQuantity ?? 1), required: true, min: 0.001, step: "any" },
      this.locationField("location_id", product.default_location_id ?? "", "Storage location"),
      { key: "best_before_date", label: "Best-before date (optional)", type: "date" },
    ]);
    if (!values) return;
    const quantity = Number(values.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    await this.mutate("shopping/complete", {
      item_id: item.id, variant_id: values.variant_id, quantity,
      location_id: values.location_id || undefined,
      best_before_date: values.best_before_date || undefined,
      request_key: `purchase-${item.id}-${Date.now()}`,
    }, "Purchase added to inventory and marked complete.");
  }

  private async deleteShoppingItem(item: ShoppingItem): Promise<void> {
    if (!await this.requestConfirmation(
      "Delete shopping item?",
      `Remove "${item.product_name ?? item.custom_name}" from the list?`,
      "Delete item",
    )) return;
    await this.mutate("shopping/delete", { item_id: item.id }, "Shopping item deleted.");
  }

  private renderSettings() {
    const settings = this.snapshot!.settings;
    return html`
      <section class="section"><div class="section-heading"><div><h2>Storage locations</h2><p class="subtle">Rename and reorder locations; referenced locations cannot be deleted.</p></div><button @click=${() => this.addLocation()}>Add location</button></div>
        ${this.snapshot!.locations.length ? html`<ul class="settings-list">${this.snapshot!.locations.map((location) => html`<li><span><strong>${location.name}</strong><small> · ${location.id}</small></span>
          <span class="actions"><button class="secondary" @click=${() => this.renameLocation(location)}>Rename</button><button class="secondary" @click=${() => this.reorderLocation(location, -1)} aria-label=${`Move ${location.name} up`}>↑</button><button class="secondary" @click=${() => this.reorderLocation(location, 1)} aria-label=${`Move ${location.name} down`}>↓</button><button class="secondary danger" @click=${() => this.deleteLocation(location)}>Delete</button></span></li>`)}</ul>` : html`<div class="empty">No active locations.</div>`}
      </section>
      <section class="section"><h2>Inventory and planning preferences</h2>
        ${this.settingNumber("expiry_warning_days", "Expiry warning (days)", Number(settings.expiry_warning_days ?? 5), 0, 365)}
        ${this.settingSelect("planner_max_effort", "Maximum effort for suggestions", String(settings.planner_max_effort ?? ""), [["", "No restriction"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]])}
        ${this.settingNumber("planner_max_cooking_minutes", "Maximum total recipe time (minutes)", settings.planner_max_cooking_minutes === null ? "" : Number(settings.planner_max_cooking_minutes), 0, 1440, true)}
        ${this.settingNumber("repetition_window_days", "Recent-meal variety window (days)", Number(settings.repetition_window_days ?? 7), 0, 28)}
        ${this.settingBoolean("prefer_expiring_stock", "Use earliest expiry first when consuming stock", Boolean(settings.prefer_expiring_stock))}
        ${this.settingBoolean("external_lookup_enabled", "Allow Open Food Facts barcode lookups", Boolean(settings.external_lookup_enabled))}
      </section>
      <section class="section"><div class="section-heading"><div><h2>Data management</h2><p class="subtle">SQLite file storage is included in Home Assistant configuration backups.</p></div><button @click=${() => this.createBackup()}>Create database backup</button></div>
        <p>Database schema v${String(this.snapshot!.database.schema_version ?? "—")} · ${String(this.snapshot!.database.integrity ?? "unknown")} · ${Number(this.snapshot!.database.size_bytes ?? 0).toLocaleString("en-GB")} bytes</p>
        <div class="actions"><button class="secondary" @click=${() => this.exportJson()}>Export JSON</button><button class="secondary" @click=${() => this.exportCsv("products")}>Export products CSV</button><button class="secondary" @click=${() => this.exportCsv("stock_transactions")}>Export history CSV</button><button class="secondary" @click=${() => this.showBackups()}>Restore validated backup</button></div>
      </section>
      <section class="section"><h2>About</h2><p>Dan's Kitchen v0.2.2 · Local SQLite database · <a href="https://github.com/dan-lindley/dans-kitchen" target="_blank" rel="noreferrer">GitHub repository</a></p></section>`;
  }

  private settingNumber(key: string, label: string, value: number | string, min: number, max: number, optional = false) {
    return html`<div class="setting-row"><span>${label}</span><input type="number" min=${min} max=${max} .value=${String(value)} data-setting=${key} data-optional=${optional ? "true" : "false"}>
      <button class="secondary" @click=${(e: Event) => this.saveSettingFromInput(e)}>Save</button></div>`;
  }

  private settingSelect(key: string, label: string, value: string, options: Array<[string, string]>) {
    return html`<div class="setting-row"><span>${label}</span><select data-setting=${key} .value=${value}>${options.map(([option, name]) => html`<option value=${option}>${name}</option>`)}</select>
      <button class="secondary" @click=${(e: Event) => this.saveSettingFromInput(e)}>Save</button></div>`;
  }

  private settingBoolean(key: string, label: string, checked: boolean) {
    return html`<div class="setting-row"><span>${label}</span><input type="checkbox" data-setting=${key} .checked=${checked}>
      <button class="secondary" @click=${(e: Event) => this.saveSettingFromInput(e)}>Save</button></div>`;
  }

  private async saveSettingFromInput(event: Event): Promise<void> {
    const row = (event.currentTarget as HTMLElement).parentElement;
    const control = row?.querySelector("[data-setting]") as HTMLInputElement | HTMLSelectElement | null;
    if (!control) return;
    let value: unknown;
    if (control instanceof HTMLInputElement && control.type === "checkbox") value = control.checked;
    else if (control.getAttribute("data-optional") === "true" && control.value === "") value = null;
    else if (control instanceof HTMLInputElement && control.type === "number") value = Number(control.value);
    else value = control.value || null;
    await this.mutate("settings/set", { key: control.dataset.setting, value }, "Preference saved.");
  }

  private async addLocation(): Promise<void> {
    const values = await this.requestForm("Add storage location", [
      { key: "name", label: "Location name", type: "text", required: true },
    ]);
    if (!values) return;
    await this.mutate("location/create", { name: values.name.trim() }, "Storage location added.");
  }

  private async renameLocation(location: Location): Promise<void> {
    const values = await this.requestForm("Rename storage location", [
      { key: "name", label: "Location name", type: "text", value: location.name, required: true },
    ]);
    if (!values) return;
    await this.mutate("location/update", { location_id: location.id, name: values.name.trim() }, "Storage location renamed.");
  }

  private async reorderLocation(location: Location, offset: number): Promise<void> {
    await this.mutate("location/update", { location_id: location.id, sort_order: location.sort_order + offset }, "Storage locations reordered.");
  }

  private async deleteLocation(location: Location): Promise<void> {
    if (!await this.requestConfirmation(
      `Delete location "${location.name}"?`,
      "Locations referenced by stock or products cannot be deleted.",
      "Delete location",
    )) return;
    await this.mutate("location/delete", { location_id: location.id }, "Storage location deleted.");
  }

  private async createBackup(): Promise<void> {
    const result = await this.request<{ filename: string }>("data/backup");
    this.notice = `Database backup created: ${result.filename}`;
  }

  private async showBackups(): Promise<void> {
    try {
      const result = await this.request<{ backups: string[] }>("data/list_backups");
      this.backupFiles = result.backups;
      if (!result.backups.length) this.notice = "No Dan's Kitchen backups are available yet.";
    } catch (error) { this.error = this.message(error); }
  }

  private async restoreBackup(filename: string): Promise<void> {
    if (!await this.requestConfirmation(
      `Restore ${filename}?`,
      "Current data will be replaced only after integrity and schema validation.",
      "Validate and restore",
    )) return;
    await this.mutate("data/restore", { filename }, "Validated database backup restored.");
    this.backupFiles = [];
  }

  private renderRecipeEditor() {
    const draft = this.recipeDraft!;
    return html`<dialog class="recipe-dialog" open aria-modal="true" aria-label=${draft.recipeId ? "Edit recipe" : "Add recipe"}>
      <form class="recipe-form" novalidate @submit=${(event: Event) => { event.preventDefault(); void this.saveRecipe(); }}>
        <div class="section-heading recipe-header"><div><h2>${draft.recipeId ? "Edit recipe" : "Add recipe"}</h2><p class="subtle">Name, effort, cooking time and eligible weekdays are required.</p></div>
          <button type="button" class="secondary" @click=${() => this.closeRecipeEditor()}>Close</button></div>
        <div class="recipe-content">
          <div class="detail-grid">
            <label class="wide">Recipe name<input type="text" required .value=${draft.name} @input=${(event: Event) => this.updateRecipeDraft("name", (event.currentTarget as HTMLInputElement).value)}></label>
            <label>Effort<select required .value=${draft.effort} @change=${(event: Event) => this.updateRecipeDraft("effort", (event.currentTarget as HTMLSelectElement).value as RecipeDraft["effort"])}>
              <option value="" disabled>Choose effort</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select></label>
            <label>Cooking time (minutes)<input type="number" min="0" max="1440" step="1" required .value=${draft.cookingMinutes} @input=${(event: Event) => this.updateRecipeDraft("cookingMinutes", (event.currentTarget as HTMLInputElement).value)}></label>
            <div class="wide">
              <div class="recipe-intro"><strong>Eligible weekdays</strong><small class="subtle">On means this recipe may be suggested automatically that day.</small></div>
              <div class="weekdays">${WEEKDAY_NAMES.map((name, day) => {
                const eligible = draft.weekdays.includes(day);
                return html`<label class="weekday-toggle"><span>${name}</span><input type="checkbox" aria-label=${`${name} eligibility`} .checked=${eligible}
                  @change=${(event: Event) => this.toggleRecipeWeekday(day, (event.currentTarget as HTMLInputElement).checked)}><small>${eligible ? "On" : "Off"}</small></label>`;
              })}</div></div>
            <div class="wide">
              <button type="button" class="secondary recipe-section-toggle" aria-expanded=${String(this.recipeDetailsOpen)}
                aria-controls="recipe-optional-details" @click=${() => { this.recipeDetailsOpen = !this.recipeDetailsOpen; }}>
                <span class="recipe-section-title"><strong>Instructions</strong><small class="subtle">Description, prep time, ingredients and cooking notes</small></span>
                <span class="recipe-section-chevron" aria-hidden="true">${this.recipeDetailsOpen ? "⌃" : "⌄"}</span>
              </button>
              <div id="recipe-optional-details" class="recipe-section-content" ?hidden=${!this.recipeDetailsOpen}>
                <div class="detail-grid">
                  <label class="wide">Description (optional)<textarea .value=${draft.description} @input=${(event: Event) => this.updateRecipeDraft("description", (event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
                  <label>Prep time (minutes, optional)<input type="number" min="0" max="1440" step="1" .value=${draft.preparationMinutes} @input=${(event: Event) => this.updateRecipeDraft("preparationMinutes", (event.currentTarget as HTMLInputElement).value)}></label>
                  <div class="wide ingredient-picker">
                    <div class="recipe-intro"><strong>Ingredients (optional)</strong><small class="subtle">Choose a saved product or add any ingredient by name.</small></div>
                    <label>Search saved products or type an ingredient<input type="search" maxlength="200" .value=${this.recipeIngredientSearch} placeholder="Start typing, then choose a product or add as free text"
                      @input=${(event: Event) => { this.recipeIngredientSearch = (event.currentTarget as HTMLInputElement).value; }}
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === "Enter" && !event.isComposing) {
                          event.preventDefault();
                          this.addFreeTextRecipeIngredient();
                        }
                      }}></label>
                    ${this.recipeIngredientSearch.trim() ? html`
                      ${this.recipeIngredientMatches.length
                        ? html`<div class="ingredient-results" aria-label="Saved product matches">${this.recipeIngredientMatches.map((product) => html`
                          <div class="ingredient-result"><span><strong>${product.name}</strong><small> · ${product.stock_unit}</small></span>
                            <button type="button" class="secondary" @click=${() => this.addRecipeIngredient(product)}>Add</button></div>`)}</div>`
                        : html`<p class="subtle" role="status">No saved products match. Add this as a free-text ingredient instead.</p>`}
                      <button type="button" class="secondary free-text-ingredient" @click=${() => this.addFreeTextRecipeIngredient()}>
                        Add "${this.recipeIngredientSearch.trim()}" as free text
                      </button>
                    ` : html`<small class="subtle">Search saved products, or type a name and add it as free text.</small>`}
                  </div>
                  <div class="wide">
                    <div class="recipe-intro"><strong>Added ingredients</strong></div>
                    ${draft.ingredients.length ? draft.ingredients.map((ingredient) => {
                      const ingredientIndex = draft.ingredients.indexOf(ingredient);
                      const product = ingredient.productId
                        ? this.snapshot?.inventory.find((item) => item.id === ingredient.productId)
                        : undefined;
                      const displayName = product?.name ?? ingredient.ingredientName ?? "Unavailable product";
                      return html`<div class="recipe-ingredient">
                        <div class="ingredient-heading"><span><strong>${displayName}</strong>${!ingredient.productId ? html`<small class="subtle">Free text · not linked to stock</small>` : nothing}</span>
                          <button type="button" class="secondary" @click=${() => this.removeRecipeIngredient(ingredientIndex)}>Remove</button></div>
                        <div class="ingredient-fields">
                          <label>Quantity (optional)<input type="number" min="0.001" step="any" .value=${ingredient.quantity}
                            @input=${(event: Event) => this.updateRecipeIngredient(ingredientIndex, "quantity", (event.currentTarget as HTMLInputElement).value)}></label>
                          <label>Unit (optional)<input type="text" .value=${ingredient.unit || product?.stock_unit || ""}
                            @input=${(event: Event) => this.updateRecipeIngredient(ingredientIndex, "unit", (event.currentTarget as HTMLInputElement).value)}></label>
                          ${product ? html`<label>Exact product variant (optional)<select .value=${ingredient.variantId}
                            @change=${(event: Event) => this.updateRecipeIngredient(ingredientIndex, "variantId", (event.currentTarget as HTMLSelectElement).value)}>
                            <option value="">Any variant</option>${product.variants.map((variant) => html`<option value=${variant.id}>${variant.brand_name ?? "Unbranded"} ${variant.variant_name ?? ""}</option>`)}
                          </select></label>` : nothing}
                          <label>Notes (optional)<input type="text" .value=${ingredient.notes}
                            @input=${(event: Event) => this.updateRecipeIngredient(ingredientIndex, "notes", (event.currentTarget as HTMLInputElement).value)}></label>
                        </div>
                      </div>`;
                    }) : html`<p class="subtle">No ingredients added.</p>`}
                  </div>
                  <label class="wide">Cooking instructions (optional)<textarea .value=${draft.instructions} @input=${(event: Event) => this.updateRecipeDraft("instructions", (event.currentTarget as HTMLTextAreaElement).value)}></textarea></label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="recipe-footer">
          ${this.recipeFormError ? html`<p class="form-error" role="alert">${this.recipeFormError}</p>` : nothing}
          <div class="dialog-actions">
          ${draft.recipeId ? html`<button type="button" class="secondary" @click=${() => this.duplicateRecipe()}>Duplicate</button>
            <button type="button" class="secondary danger" @click=${() => {
              const recipe = this.snapshot?.recipes.find((item) => item.id === draft.recipeId);
              if (recipe) void this.archiveRecipe(recipe);
            }}>Archive</button>` : nothing}
          <button type="button" class="secondary" @click=${() => this.closeRecipeEditor()}>Cancel</button>
          <button type="submit" ?disabled=${this.working}>${this.working ? "Saving…" : "Save recipe"}</button>
          </div>
        </div>
      </form>
    </dialog>`;
  }

  private async exportJson(): Promise<void> {
    const data = await this.request<Record<string, unknown>>("data/export_json");
    this.downloadFile("dans-kitchen-export.json", JSON.stringify(data, null, 2), "application/json");
  }

  private async exportCsv(table: string): Promise<void> {
    const result = await this.request<{ filename: string; content: string }>("data/export_csv", { table });
    this.downloadFile(result.filename, result.content, "text/csv");
  }

  private downloadFile(filename: string, content: string, mime: string): void {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: mime }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private renderDialogs() {
    return html`
      ${this.recipeDraft ? this.renderRecipeEditor() : nothing}
      ${this.appForm ? html`<dialog open aria-modal="true" aria-label=${this.appForm.title}>
        <form class="app-form" novalidate @submit=${(event: Event) => this.submitAppForm(event)}>
          <div class="section-heading"><div><h2>${this.appForm.title}</h2>${this.appForm.description ? html`<p class="subtle">${this.appForm.description}</p>` : nothing}</div></div>
          <div class="form-fields">${this.appForm.fields.map((field) => this.renderFormField(field))}</div>
          ${this.appFormError ? html`<p class="form-error" role="alert">${this.appFormError}</p>` : nothing}
          <div class="dialog-actions"><button type="button" class="secondary" @click=${() => this.closeAppForm()}>Cancel</button>
            <button type="submit">${this.appForm.submitLabel ?? "Save"}</button></div>
        </form>
      </dialog>` : nothing}
      ${this.plannerDay ? html`<dialog open aria-label="Select a meal for ${this.plannerDay.date}">
        <div class="section-heading"><div><h2>${this.formatDate(this.plannerDay.date)}</h2><p class="subtle">${this.plannerDay.assignment_type} · ${this.plannerDay.recipe_name ?? "Unplanned"}</p></div>
          <button class="secondary" @click=${() => { this.plannerDay = undefined; }}>Close</button></div>
        <label class="weekday"><input type="checkbox" .checked=${this.includeIneligible} @change=${async (e: Event) => { this.includeIneligible = (e.currentTarget as HTMLInputElement).checked; await this.loadEligibleMeals(); }}>Show recipes outside weekday eligibility for manual selection</label>
        <button class="secondary" @click=${() => this.shuffleDay()} ?disabled=${this.working}>Suggest a random meal</button>
        ${this.eligibleMeals.length ? html`        <div class="filters"><label>Search recipes<input type="search" .value=${this.pickerSearch} @input=${(e: Event) => { this.pickerSearch = (e.currentTarget as HTMLInputElement).value; this.pickerPage = 1; }}></label>
          <label>Effort<select .value=${this.pickerEffort} @change=${(e: Event) => { this.pickerEffort = (e.currentTarget as HTMLSelectElement).value; this.pickerPage = 1; }}>
            <option value="">Any effort</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select></label><label>Maximum time<input type="number" min="0" .value=${this.pickerMaxTime} @input=${(e: Event) => { this.pickerMaxTime = (e.currentTarget as HTMLInputElement).value; this.pickerPage = 1; }}></label>
          <label class="weekday"><input type="checkbox" .checked=${this.pickerAvailableOnly} @change=${(e: Event) => { this.pickerAvailableOnly = (e.currentTarget as HTMLInputElement).checked; this.pickerPage = 1; }}>Ingredients available</label></div>
        ${this.pickerMeals.length ? html`<div class="grid">${this.pickerMeals.slice((this.pickerPage - 1) * 25, this.pickerPage * 25).map((recipe) => html`<button class="tile" @click=${() => this.chooseMeal(recipe.id)}><strong>${recipe.name}</strong><small>${recipe.effort ?? "Effort unset"} · ${this.recipeMinutes(recipe)} min</small></button>`)}</div>
          <div class="pagination"><button class="secondary" @click=${() => this.pickerPage--} ?disabled=${this.pickerPage <= 1}>Previous</button><span>Page ${this.pickerPage} of ${Math.max(1, Math.ceil(this.pickerMeals.length / 25))}</span><button class="secondary" @click=${() => this.pickerPage++} ?disabled=${this.pickerPage >= Math.ceil(this.pickerMeals.length / 25)}>Next</button></div>`
          : html`<div class="empty">No recipes currently meet this date's filters.</div>`}
        ` : html`<div class="empty">No eligible recipes exist on this date. Enable manual override to see all recipes.</div>`}
        <div class="dialog-actions"><button class="secondary" @click=${() => this.planMeal(null)}>Leave unplanned</button>
          ${this.plannerDay.recurrence_rule_id ? html`<button class="secondary" @click=${() => this.restoreRecurrence()}>Restore recurrence</button>` : nothing}
          <button class="secondary" @click=${() => this.setRecurrence()}>Set recurrence</button></div>
      </dialog>` : nothing}
      ${this.unknownBarcode ? html`<dialog open aria-label="Register scanned product">
        <div class="section-heading"><h2>${this.barcodeLookupTitle()}</h2><button class="secondary" @click=${() => { this.unknownBarcode = undefined; }}>Close</button></div>
        <p role="status">${String(this.unknownBarcode.lookup_message ?? "No product details were returned. Enter the product manually.")}</p>
        <p>Barcode <strong>${String(this.unknownBarcode.barcode)}</strong>. Review the details and choose a generic product; similar names are suggestions only.</p>
        <label>Product name<input id="scan-name" .value=${String(this.unknownBarcode.name ?? "")}></label>
        <label>Brand<input id="scan-brand" .value=${String(this.unknownBarcode.brand_name ?? "")}></label>
        <label>Assign to generic product<select id="scan-product"><option value="">Create new generic product</option>${this.snapshot?.inventory.map((product) => html`<option value=${product.id}>${product.name}</option>`)}</select></label>
        <label>New product stock unit<input id="scan-unit" value="item"></label>
        <label>Quantity<input id="scan-quantity" type="number" min="0.001" step="any" value=${this.scannerQuantity}></label>
        <div class="dialog-actions"><button class="secondary" @click=${() => { this.unknownBarcode = undefined; }}>Cancel</button><button @click=${() => this.registerUnknownBarcode()}>Save product and stock</button></div>
      </dialog>` : nothing}
      ${this.scannerOpen ? html`<dialog open aria-label="Barcode scanner">
        <div class="section-heading"><div><h2>Scan a barcode</h2><p class="subtle">Camera access requires HTTPS or localhost. The rear camera is preferred.</p></div>
          <button class="secondary" @click=${() => this.closeScanner()}>Close scanner</button></div>
        ${globalThis.isSecureContext ? html`<video id="scanner-video" playsinline muted></video><div class="actions"><button class="secondary" @click=${() => this.toggleTorch()}>Toggle torch</button><label>Quantity<input type="number" min="0.001" step="any" .value=${this.scannerQuantity} @input=${(e: Event) => { this.scannerQuantity = (e.currentTarget as HTMLInputElement).value; }}></label></div>` : html`<p class="error">Camera scanning is unavailable on an insecure origin. Use Home Assistant over HTTPS, or enter the barcode manually below.</p>`}
        <label>Manual barcode entry<input id="manual-barcode" inputmode="numeric" .value=${this.barcode} @input=${(e: Event) => { this.barcode = (e.currentTarget as HTMLInputElement).value; }}></label>
        <div class="dialog-actions"><button @click=${() => this.submitManualBarcode()}>Look up barcode</button></div>
      </dialog>` : nothing}
      ${this.backupFiles.length ? html`<dialog open aria-label="Restore a database backup">
        <div class="section-heading"><h2>Restore backup</h2><button class="secondary" @click=${() => { this.backupFiles = []; }}>Close</button></div>
        <ul class="shop-list">${this.backupFiles.map((filename) => html`<li><span>${filename}</span><button class="danger secondary" @click=${() => this.restoreBackup(filename)}>Validate and restore</button></li>`)}</ul>
      </dialog>` : nothing}
    `;
  }

  private async chooseMeal(recipeId: string): Promise<void> {
    if (!this.plannerDay) return;
    await this.planMeal(recipeId);
  }

  private async planMeal(recipeId: string | null): Promise<void> {
    if (!this.plannerDay) return;
    await this.mutate("planner/plan", {
      date: this.plannerDay.date,
      recipe_id: recipeId,
      allow_ineligible: this.includeIneligible,
    }, recipeId ? "Meal fixed for this date." : "Date left unplanned.");
    this.plannerDay = undefined;
  }

  private async shuffleDay(): Promise<void> {
    if (!this.plannerDay) return;
    try {
      await this.request("planner/shuffle", { date: this.plannerDay.date });
      await this.reload();
      this.plannerDay = undefined;
      this.notice = "Random meal suggestion saved for this date.";
    } catch (error) { this.error = this.message(error); }
  }

  private async restoreRecurrence(): Promise<void> {
    if (!this.plannerDay) return;
    await this.mutate("planner/restore_recurrence", { date: this.plannerDay.date }, "Recurring meal restored.");
    this.plannerDay = undefined;
  }

  private async setRecurrence(): Promise<void> {
    const day = this.plannerDay;
    if (!day) return;
    const values = await this.requestForm("Set recurring meal", [
      {
        key: "recipe_id", label: "Recipe", type: "select", required: true, value: day.recipe_id ?? "",
        options: (this.snapshot?.recipes ?? []).map((recipe) => ({ value: recipe.id, label: recipe.name })),
      },
      {
        key: "interval_weeks", label: "Repeat every", type: "select", value: "1",
        options: [{ value: "1", label: "Every week" }, { value: "2", label: "Every 2 weeks" }, { value: "4", label: "Every 4 weeks" }],
      },
    ], `This creates an explicit recurrence for ${WEEKDAY_NAMES[day.weekday]}.`);
    if (!values) return;
    await this.mutate("recurrence/set", {
      recipe_id: values.recipe_id, weekday: day.weekday, anchor_date: day.date,
      interval_weeks: Number(values.interval_weeks),
    }, "Recurring meal saved.");
    this.plannerDay = undefined;
  }

  private async addBarcode(code: string): Promise<void> {
    const now = Date.now();
    if (code === this.lastBarcode && now - this.lastBarcodeAt < 2500) return;
    this.lastBarcode = code;
    this.lastBarcodeAt = now;
    this.barcode = code;
    try {
      const result = await this.request<{
        matched: boolean;
        variant?: Variant;
        product?: Record<string, unknown> | null;
        source: string;
        lookup_status?: string;
        lookup_message?: string;
      }>("barcode/lookup", { barcode: code });
      if (result.matched && result.variant) {
        await this.request("stock/add", {
          variant_id: result.variant.id,
          quantity: Number(this.scannerQuantity) || 1,
          location_id: result.variant.default_location_id,
          reason: "Barcode scan",
          request_key: `scan-${code}-${now}`,
        });
        await this.reload();
        this.notice = `Added ${this.scannerQuantity} ${result.variant.product_name} to stock.`;
        this.barcode = "";
        return;
      }
      this.unknownBarcode = {
        barcode: code,
        ...(result.product ?? {}),
        lookup_status: result.lookup_status ?? result.source,
        lookup_message: result.lookup_message ?? "No product details were returned. Enter the product manually.",
      };
    } catch (error) { this.error = this.message(error); }
  }

  private async submitManualBarcode(): Promise<void> {
    const code = this.barcode.trim();
    if (!code) return;
    await this.addBarcode(code);
  }

  private async registerUnknownBarcode(): Promise<void> {
    const productName = (this.renderRoot.querySelector("#scan-name") as HTMLInputElement)?.value.trim();
    const brandName = (this.renderRoot.querySelector("#scan-brand") as HTMLInputElement)?.value.trim();
    const productId = (this.renderRoot.querySelector("#scan-product") as HTMLSelectElement)?.value;
    const unit = (this.renderRoot.querySelector("#scan-unit") as HTMLInputElement)?.value.trim() || "item";
    const quantity = Number((this.renderRoot.querySelector("#scan-quantity") as HTMLInputElement)?.value);
    if (!productId && !productName) { this.error = "Enter a name for the generic product."; return; }
    try {
      await this.request("barcode/register", {
        barcode: this.barcode,
        product_id: productId || undefined,
        product_name: productId ? undefined : productName,
        stock_unit: unit,
        brand_name: brandName || undefined,
        quantity,
        external_source: this.unknownBarcode?.external_source,
        external_source_id: this.unknownBarcode?.external_source_id,
        image_url: this.unknownBarcode?.image_url,
        request_key: `scan-${this.barcode}-${this.lastBarcodeAt}`,
      });
      this.unknownBarcode = undefined;
      await this.reload();
      this.notice = "Product variant and initial stock saved.";
    } catch (error) { this.error = this.message(error); }
  }

  private barcodeLookupTitle(): string {
    switch (this.unknownBarcode?.lookup_status) {
      case "found": return "Product details found";
      case "incomplete": return "Product details incomplete";
      case "unavailable": return "External lookup unavailable";
      case "disabled": return "External lookup disabled";
      case "not_found": return "Barcode not found";
      default: return "Barcode lookup result";
    }
  }

  private openScanner(): void {
    this.scannerOpen = true;
    this.error = "";
    this.updateComplete.then(() => this.startScannerIfNeeded());
  }

  private async startScannerIfNeeded(): Promise<void> {
    if (!this.scannerOpen || !globalThis.isSecureContext) return;
    const video = this.renderRoot.querySelector("#scanner-video") as HTMLVideoElement | null;
    if (!video || video.srcObject) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = "This browser does not support camera access; enter the barcode manually.";
      return;
    }
    try {
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      video.srcObject = this.scannerStream;
      await video.play();
      if (window.BarcodeDetector) {
        const detector = new window.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
        const scan = async () => {
          if (!this.scannerOpen || !video.srcObject) return;
          try {
            const result = await detector.detect(video);
            if (result[0]?.rawValue) await this.addBarcode(result[0].rawValue);
          } catch (error) { this.error = this.message(error); }
          this.nativeScanFrame = requestAnimationFrame(() => void scan());
        };
        this.nativeScanFrame = requestAnimationFrame(() => void scan());
      } else {
        const reader = new BrowserMultiFormatReader();
        this.scannerControls = await reader.decodeFromVideoElement(video, (result) => {
          if (result) void this.addBarcode(result.getText());
        });
      }
    } catch (error) {
      this.error = `Camera could not be started: ${this.message(error)}. You can enter the barcode manually.`;
    }
  }

  private async toggleTorch(): Promise<void> {
    const track = this.scannerStream?.getVideoTracks()[0];
    if (!track) return;
    try {
      const capabilities = track.getCapabilities() as MediaTrackCapabilities & { torch?: boolean };
      if (!capabilities.torch) { this.notice = "Torch control is not supported by this camera."; return; }
      const settings = track.getSettings() as MediaTrackSettings & { torch?: boolean };
      await track.applyConstraints({ advanced: [{ torch: !settings.torch } as MediaTrackConstraintSet] });
    } catch { this.notice = "The camera did not allow torch control."; }
  }

  private closeScanner(): void {
    this.scannerOpen = false;
    this.unknownBarcode = undefined;
    this.stopScanner();
  }

  private stopScanner(): void {
    cancelAnimationFrame(this.nativeScanFrame);
    this.scannerControls?.stop();
    this.scannerControls = undefined;
    this.scannerStream?.getTracks().forEach((track) => track.stop());
    this.scannerStream = undefined;
    const video = this.renderRoot?.querySelector("#scanner-video") as HTMLVideoElement | null;
    if (video) video.srcObject = null;
  }
}
