// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { KitchenSnapshot } from "./types";
import "./panel";

const emptySnapshot: KitchenSnapshot = {
  inventory: [{
    id: "green-lentils",
    name: "Green lentils",
    stock_unit: "tin",
    stock_quantity: 0,
    reorder_level: 0,
    default_location_id: null,
    default_location_name: null,
    nearest_expiry: null,
    low_stock: false,
    variants: [],
  }],
  recipes: [],
  planner: { weeks: [], start_date: "2026-11-09" },
  shopping: [],
  locations: [{ id: "cupboard", name: "Cupboard", description: null, sort_order: 0 }],
  recurrences: [],
  settings: {},
  database: {},
  dashboard: {
    today: {},
    low_stock: [],
    shopping: [],
    expiring: [],
    inventory_product_count: 0,
  },
};

async function openPanel(tab: "kitchen" | "meals") {
  const panel = document.createElement("dans-kitchen-panel") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  const internal = panel as unknown as { snapshot: KitchenSnapshot; tab: string };
  internal.snapshot = emptySnapshot;
  internal.tab = tab;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function spyOnNativeDialogs() {
  const prompt = vi.fn(() => null);
  const alert = vi.fn(() => undefined);
  const confirm = vi.fn(() => false);
  Object.defineProperties(window, {
    prompt: { value: prompt, configurable: true },
    alert: { value: alert, configurable: true },
    confirm: { value: confirm, configurable: true },
  });
  return [prompt, alert, confirm];
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("application forms", () => {
  it("opens a complete Add Product form without native browser dialogues", async () => {
    const nativeDialogs = spyOnNativeDialogs();
    const panel = await openPanel("kitchen");
    const addButton = [...panel.shadowRoot!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add product");
    expect(addButton).toBeDefined();
    addButton!.click();
    await panel.updateComplete;

    const form = panel.shadowRoot!.querySelector('dialog[aria-label="Add product"] form');
    expect(form).not.toBeNull();
    for (const field of ["name", "stock_unit", "reorder_level", "default_location_id"]) {
      expect(form!.querySelector(`[name="${field}"]`)).not.toBeNull();
    }
    expect(form!.querySelector('[name="name"]')).toHaveProperty("required", true);
    expect(form!.querySelector('[name="stock_unit"]')).toHaveProperty("required", true);
    expect(form!.textContent).toContain("Save");
    expect(form!.textContent).toContain("Cancel");
    form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await panel.updateComplete;
    expect(form!.querySelector('[role="alert"]')?.textContent).toContain("required");
    expect(nativeDialogs.every((dialog) => dialog.mock.calls.length === 0)).toBe(true);
  });

  it("opens a complete Add Recipe form with every weekday on and no native dialogues", async () => {
    const nativeDialogs = spyOnNativeDialogs();
    const panel = await openPanel("meals");
    const addButton = [...panel.shadowRoot!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add recipe");
    expect(addButton).toBeDefined();
    addButton!.click();
    await panel.updateComplete;

    const form = panel.shadowRoot!.querySelector('dialog[aria-label="Add recipe"] form');
    expect(form).not.toBeNull();
    const footer = form!.querySelector(".recipe-footer");
    const content = form!.querySelector(".recipe-content");
    expect(footer).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.contains(footer)).toBe(false);
    expect(footer!.textContent).toContain("Save recipe");
    expect(footer!.textContent).toContain("Cancel");
    expect(form!.textContent).toContain("Recipe name");
    expect(form!.textContent).toContain("Effort");
    expect(form!.textContent).toContain("Cooking time");
    expect(form!.textContent).toContain("Cooking instructions (optional)");
    expect(form!.querySelector('input[type="text"][required]')).not.toBeNull();
    expect(form!.querySelector("select[required]")).not.toBeNull();
    expect(form!.querySelector('input[type="number"][required]')).not.toBeNull();
    const weekdays = [...form!.querySelectorAll<HTMLInputElement>(".weekday-toggle input")];
    expect(weekdays).toHaveLength(7);
    expect(weekdays.every((weekday) => weekday.checked)).toBe(true);
    expect([...form!.querySelectorAll(".weekday-toggle small")].map((item) => item.textContent))
      .toEqual(Array(7).fill("On"));
    const ingredientSearch = form!.querySelector<HTMLInputElement>('input[type="search"]');
    expect(ingredientSearch?.placeholder).toContain("product name");
    ingredientSearch!.value = "lentils";
    ingredientSearch!.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    const addIngredient = [...form!.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Add");
    expect(addIngredient).toBeDefined();
    addIngredient!.click();
    await panel.updateComplete;
    expect(form!.textContent).toContain("Green lentils");
    expect(form!.textContent).toContain("Added ingredients");
    const name = form!.querySelector<HTMLInputElement>('input[type="text"][required]')!;
    name.value = "Soup";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const effort = form!.querySelector<HTMLSelectElement>("select[required]")!;
    effort.value = "low";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    const cookingTime = form!.querySelector<HTMLInputElement>('input[type="number"][required]')!;
    cookingTime.value = "20";
    cookingTime.dispatchEvent(new Event("input", { bubbles: true }));
    weekdays.forEach((weekday) => weekday.click());
    await panel.updateComplete;
    form!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await panel.updateComplete;
    expect(form!.querySelector('[role="alert"]')?.textContent).toContain("at least one eligible weekday");
    expect(nativeDialogs.every((dialog) => dialog.mock.calls.length === 0)).toBe(true);
  });
});
