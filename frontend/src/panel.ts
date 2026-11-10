import { BrowserMultiFormatReader } from "@zxing/browser";
import { html, LitElement, nothing, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { WEEKDAY_NAMES, weekdayMondayZero } from "./date";
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
  private scannerControls?: ScannerControls;
  private scannerStream?: MediaStream;
  private nativeScanFrame = 0;
  private lastBarcode = "";
  private lastBarcodeAt = 0;

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
    dialog::backdrop { background:#0008; }
    .dialog-actions { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:7px; margin-top:14px; }
    video { width:100%; max-height:55vh; background:#000; border-radius:8px; object-fit:cover; }
    .weekdays { display:flex; flex-wrap:wrap; gap:7px; }
    .weekday { display:flex; align-items:center; gap:3px; border:1px solid var(--divider-color); border-radius:6px; padding:4px 6px; }
    @media (max-width: 900px) { .grid { grid-template-columns:repeat(3,minmax(0,1fr)); } .planner { grid-template-columns:repeat(7,minmax(94px,1fr)); } }
    @media (max-width: 600px) {
      main { padding:12px 9px 24px; } nav { overflow:auto; } nav button { padding:9px 10px; white-space:nowrap; }
      .grid { grid-template-columns:repeat(2,minmax(0,1fr)); } .planner { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .variant { grid-template-columns:1fr auto; } .variant .variant-meta { grid-column:1/-1; }
      .detail-grid { grid-template-columns:1fr; } .detail-grid .wide { grid-column:auto; }
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
    const name = window.prompt("Generic product name");
    if (!name?.trim()) return;
    const stockUnit = window.prompt("Stock unit (for example tin, bottle or kg)", "item");
    if (!stockUnit?.trim()) return;
    const reorder = window.prompt(`Reorder threshold in ${stockUnit}; use 0 to disable`, "0");
    if (reorder === null || !Number.isFinite(Number(reorder)) || Number(reorder) < 0) return;
    const locationId = this.selectLocation(undefined, "Default storage location");
    if (locationId === undefined) return;
    this.working = true;
    try {
      const product = await this.request<Product>("product/create", {
        name: name.trim(), stock_unit: stockUnit.trim(), reorder_level: Number(reorder), default_location_id: locationId,
      });
      await this.request("variant/create", { product_id: product.id });
      await this.reload();
      this.notice = `Added ${product.name}.`;
    } catch (error) { this.error = this.message(error); }
    finally { this.working = false; }
  }

  private async editProduct(product: Product): Promise<void> {
    const name = window.prompt("Product name", product.name);
    if (!name?.trim()) return;
    const threshold = window.prompt(`Reorder threshold in ${product.stock_unit} (0 disables)`, String(product.reorder_level));
    if (threshold === null || !Number.isFinite(Number(threshold)) || Number(threshold) < 0) return;
    const location = this.selectLocation(product.default_location_id ?? undefined, "Default storage location");
    if (location === undefined) return;
    await this.mutate("product/update", {
      product_id: product.id, name: name.trim(), reorder_level: Number(threshold), default_location_id: location,
    }, "Product updated.");
    await this.openProduct(product.id);
  }

  private async editVariant(product: Product, variant: Variant): Promise<void> {
    const brand = window.prompt("Brand name", variant.brand_name ?? "");
    if (brand === null) return;
    const name = window.prompt("Variant name", variant.variant_name ?? "");
    if (name === null) return;
    const barcode = window.prompt("Barcode (leave blank to clear)", variant.barcode ?? "");
    if (barcode === null) return;
    const size = window.prompt("Package size (leave blank to clear)", variant.package_size === null ? "" : String(variant.package_size));
    if (size === null) return;
    const unit = size ? window.prompt("Package unit", variant.package_unit ?? product.stock_unit) : null;
    if (size && !unit) return;
    await this.mutate("variant/update", {
      variant_id: variant.id,
      brand_name: brand || null,
      variant_name: name || null,
      barcode: barcode || null,
      package_size: size ? Number(size) : null,
      package_unit: size ? unit : null,
    }, "Variant updated.");
    await this.openProduct(product.id);
  }

  private selectLocation(defaultId?: string, label = "Storage location"): string | null | undefined {
    const locations = this.snapshot?.locations ?? [];
    const currentIndex = defaultId ? locations.findIndex((item) => item.id === defaultId) + 1 : 0;
    const choices = ["0. None", ...locations.map((item, index) => `${index + 1}. ${item.name}`)].join("\n");
    const raw = window.prompt(`${label}:\n${choices}`, String(currentIndex));
    if (raw === null) return undefined;
    const choice = Number(raw);
    if (!Number.isInteger(choice) || choice < 0 || choice > locations.length) {
      this.error = "Select one of the listed storage locations.";
      return undefined;
    }
    return choice === 0 ? null : locations[choice - 1].id;
  }

  private async openVariantForm(product: Product): Promise<void> {
    const brand = window.prompt("Brand name (optional)");
    if (brand === null) return;
    const variantName = window.prompt("Variant description (optional)", "");
    if (variantName === null) return;
    const barcode = window.prompt("Barcode (optional)", "");
    if (barcode === null) return;
    const size = window.prompt("Package size (optional)", "");
    if (size === null) return;
    const unit = size ? window.prompt("Package unit", product.stock_unit) : null;
    if (size && !unit) return;
    await this.mutate("variant/create", {
      product_id: product.id,
      brand_name: brand || undefined,
      variant_name: variantName || undefined,
      barcode: barcode || undefined,
      package_size: size ? Number(size) : undefined,
      package_unit: size ? unit : undefined,
    }, "Variant added.");
    await this.openProduct(product.id);
  }

  private async stockAction(product: Product, variant: Variant | undefined, action: "add" | "use"): Promise<void> {
    const raw = window.prompt(`${action === "add" ? "Add" : "Use"} quantity in ${product.stock_unit}`, "1");
    if (raw === null || !Number.isFinite(Number(raw)) || Number(raw) <= 0) return;
    try {
      if (action === "add") {
        let variantId = variant?.id;
        if (!variantId && product.variants.length === 1) variantId = product.variants[0].id;
        if (!variantId && product.variants.length > 1) {
          const index = Number(window.prompt(`Variant number: ${product.variants.map((item, i) => `${i + 1}. ${item.brand_name ?? "Unbranded"} ${item.variant_name ?? ""}`).join("\n")}`, "1"));
          variantId = product.variants[index - 1]?.id;
        }
        if (!variantId) throw new Error("Add a product variant before adding stock.");
        const selectedLocation = this.selectLocation(product.default_location_id ?? undefined, "Storage location for this stock addition");
        if (selectedLocation === undefined) return;
        const bestBefore = window.prompt("Best-before date (YYYY-MM-DD, optional)", "") || undefined;
        const useBy = window.prompt("Use-by date (YYYY-MM-DD, optional)", "") || undefined;
        await this.request("stock/add", {
          variant_id: variantId, quantity: Number(raw), location_id: selectedLocation ?? undefined,
          best_before_date: bestBefore, use_by_date: useBy,
        });
      } else {
        await this.request("stock/use", { product_id: product.id, variant_id: variant?.id, quantity: Number(raw) });
      }
      await this.reload();
      this.notice = `${action === "add" ? "Added" : "Used"} ${raw} ${product.stock_unit}.`;
      if (this.selectedProduct?.id === product.id) await this.openProduct(product.id);
    } catch (error) { this.error = this.message(error); }
  }

  private async correctBatch(batchId: string, quantity: number): Promise<void> {
    const raw = window.prompt("Correct batch quantity", String(quantity));
    if (raw === null || !Number.isFinite(Number(raw)) || Number(raw) < 0) return;
    await this.mutate("stock/correct", { batch_id: batchId, quantity: Number(raw), reason: "Manual correction" }, "Stock corrected.");
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
    const name = window.prompt("Recipe name");
    if (!name?.trim()) return;
    await this.mutate("recipe/create", { name: name.trim() }, "Recipe created.");
  }

  private async editRecipe(recipe: Recipe): Promise<void> {
    const name = window.prompt("Recipe name", recipe.name);
    if (!name?.trim()) return;
    const effort = window.prompt("Effort: low, medium, high or leave blank", recipe.effort ?? "");
    if (effort === null) return;
    const weekdays = window.prompt("Eligible weekdays as Monday=0 through Sunday=6, comma-separated", recipe.weekdays.join(","));
    if (weekdays === null) return;
    const parsedDays = weekdays.split(",").map((value) => Number(value.trim()));
    if (parsedDays.some((value) => !Number.isInteger(value) || value < 0 || value > 6)) {
      this.error = "Use weekday numbers from Monday 0 through Sunday 6.";
      return;
    }
    const preparation = window.prompt("Preparation time in minutes (optional)", recipe.preparation_minutes === null ? "" : String(recipe.preparation_minutes));
    if (preparation === null) return;
    const cooking = window.prompt("Cooking time in minutes (optional)", recipe.cooking_minutes === null ? "" : String(recipe.cooking_minutes));
    if (cooking === null) return;
    const description = window.prompt("Description (optional)", recipe.description ?? "");
    if (description === null) return;
    const instructions = window.prompt("Cooking instructions (optional)", recipe.instructions ?? "");
    if (instructions === null) return;
    let ingredients = recipe.ingredients.map(({ product_id, required_variant_id, quantity, unit, notes }) => ({ product_id, required_variant_id, quantity, unit, notes }));
    if (window.confirm("Edit this recipe's ingredient list?")) {
      const products = this.snapshot!.inventory;
      const choices = ["0. Clear ingredients", ...products.map((item, index) => `${index + 1}. ${item.name} (${item.stock_unit})`)].join("\n");
      const selected = window.prompt(`Select a generic product number for each optional ingredient. Enter 0 to clear, or Cancel to keep the current list.\n${choices}`);
      if (selected !== null) {
        const productIndex = Number(selected);
        if (!Number.isInteger(productIndex) || productIndex < 0 || productIndex > products.length) {
          this.error = "Choose one of the displayed product numbers.";
          return;
        }
        ingredients = [];
        if (productIndex > 0) {
          const product = products[productIndex - 1];
          const quantity = window.prompt(`Required quantity in ${product.stock_unit}; leave blank for unspecified`, "");
          if (quantity === null) return;
          const unit = quantity ? window.prompt("Ingredient unit", product.stock_unit) : null;
          if (quantity && !unit) return;
          const variants = product.variants;
          let requiredVariantId: string | null = null;
          if (variants.length) {
            const variant = window.prompt(`Require an exact variant? Enter its number or leave blank:\n${variants.map((item, index) => `${index + 1}. ${item.brand_name ?? "Unbranded"} ${item.variant_name ?? ""}`).join("\n")}`);
            if (variant === null) return;
            if (variant.trim()) requiredVariantId = variants[Number(variant) - 1]?.id ?? null;
            if (variant.trim() && !requiredVariantId) { this.error = "Select an existing variant number."; return; }
          }
          ingredients = [{
            product_id: product.id, required_variant_id: requiredVariantId,
            quantity: quantity ? Number(quantity) : null, unit: quantity ? unit : null, notes: null,
          }];
        }
      }
    }
    const preparationMinutes = preparation.trim() ? Number(preparation) : null;
    const cookingMinutes = cooking.trim() ? Number(cooking) : null;
    if ([preparationMinutes, cookingMinutes].some((value) => value !== null && (!Number.isInteger(value) || value < 0))) {
      this.error = "Preparation and cooking time must be non-negative whole minutes.";
      return;
    }
    await this.mutate("recipe/update", {
      recipe_id: recipe.id, name: name.trim(), effort: effort || null, weekdays: parsedDays,
      description: description || null, preparation_minutes: preparationMinutes,
      cooking_minutes: cookingMinutes,
      instructions: instructions || null,
      ingredients,
    }, "Recipe updated.");
    if (window.confirm("Duplicate this recipe?")) {
      const duplicateName = window.prompt("Name for the duplicate", `${name.trim()} (copy)`);
      if (duplicateName?.trim()) await this.mutate("recipe/duplicate", { recipe_id: recipe.id, name: duplicateName.trim() }, "Recipe duplicated.");
    }
    if (window.confirm(`Archive "${name.trim()}"?`)) await this.archiveRecipe({ ...recipe, name: name.trim() });
  }

  private async archiveRecipe(recipe: Recipe): Promise<void> {
    if (!window.confirm(`Archive "${recipe.name}"? Existing history will remain.`)) return;
    await this.mutate("recipe/archive", { recipe_id: recipe.id }, "Recipe archived.");
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
    const name = window.prompt("Product name or custom shopping item");
    if (!name?.trim()) return;
    const product = this.snapshot!.inventory.find((item) => item.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    const quantity = window.prompt("Quantity (leave blank for unspecified)", "");
    if (quantity === null) return;
    const amount = quantity ? Number(quantity) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) { this.error = "Shopping quantity must be greater than zero."; return; }
    const unit = amount ? window.prompt("Unit", product?.stock_unit ?? "item") : undefined;
    if (amount && !unit) return;
    await this.mutate("shopping/add", product ? { product_id: product.id, quantity: amount, unit } : { custom_name: name.trim(), quantity: amount, unit }, "Shopping item added.");
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
    const variantIndex = Number(window.prompt(
      `Add purchased stock to which variant?\n${product.variants.map((variant, index) => `${index + 1}. ${variant.brand_name ?? "Unbranded"} ${variant.variant_name ?? ""}`).join("\n")}`,
      "1",
    ));
    const variant = product.variants[variantIndex - 1];
    if (!variant) return;
    const suggestedQuantity = item.unit === product.stock_unit ? item.quantity : 1;
    const quantity = Number(window.prompt(`Quantity in ${product.stock_unit}`, String(suggestedQuantity ?? 1)));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    const location = this.selectLocation(product.default_location_id ?? undefined, "Purchased stock location");
    if (location === undefined) return;
    const expiry = window.prompt("Best-before date (YYYY-MM-DD, optional)", "") || undefined;
    await this.mutate("shopping/complete", {
      item_id: item.id, variant_id: variant.id, quantity, location_id: location ?? undefined,
      best_before_date: expiry, request_key: `purchase-${item.id}-${Date.now()}`,
    }, "Purchase added to inventory and marked complete.");
  }

  private async deleteShoppingItem(item: ShoppingItem): Promise<void> {
    if (!window.confirm(`Delete "${item.product_name ?? item.custom_name}" from the list?`)) return;
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
      <section class="section"><h2>About</h2><p>Dan's Kitchen v0.1.0 · Local SQLite database · <a href="https://github.com/dan-lindley/dans-kitchen" target="_blank" rel="noreferrer">GitHub repository</a></p></section>`;
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
    const name = window.prompt("Location name");
    if (!name?.trim()) return;
    await this.mutate("location/create", { name: name.trim() }, "Storage location added.");
  }

  private async renameLocation(location: Location): Promise<void> {
    const name = window.prompt("Location name", location.name);
    if (!name?.trim()) return;
    await this.mutate("location/update", { location_id: location.id, name: name.trim() }, "Storage location renamed.");
  }

  private async reorderLocation(location: Location, offset: number): Promise<void> {
    await this.mutate("location/update", { location_id: location.id, sort_order: location.sort_order + offset }, "Storage locations reordered.");
  }

  private async deleteLocation(location: Location): Promise<void> {
    if (!window.confirm(`Delete location "${location.name}"? It must not be referenced by stock or products.`)) return;
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
    if (!window.confirm(`Restore ${filename}? Current data will be replaced after integrity and schema validation.`)) return;
    await this.mutate("data/restore", { filename }, "Validated database backup restored.");
    this.backupFiles = [];
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
        <div class="section-heading"><h2>Unknown barcode</h2><button class="secondary" @click=${() => { this.unknownBarcode = undefined; }}>Close</button></div>
        <p>Barcode <strong>${String(this.unknownBarcode.barcode)}</strong> was not found locally. Review the lookup and choose a generic product; similar names are suggestions only.</p>
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
    const recipeId = day.recipe_id || window.prompt("Recipe ID to repeat");
    if (!recipeId) return;
    const interval = Number(window.prompt("Repeat every 1, 2 or 4 weeks", "1"));
    if (![1, 2, 4].includes(interval)) return;
    await this.mutate("recurrence/set", {
      recipe_id: recipeId, weekday: day.weekday, anchor_date: day.date, interval_weeks: interval,
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
      const result = await this.request<{ matched: boolean; variant?: Variant; product?: Record<string, unknown>; source: string }>("barcode/lookup", { barcode: code });
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
      this.unknownBarcode = { barcode: code, ...(result.product ?? {}) };
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
