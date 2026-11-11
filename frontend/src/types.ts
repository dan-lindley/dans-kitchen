export type KitchenCommand = {
  type: "dans_kitchen/command";
  command: string;
  data?: Record<string, unknown>;
};

export type HomeAssistantLike = {
  callWS<T>(command: KitchenCommand): Promise<T>;
  states?: Record<string, unknown>;
};

export type Product = {
  id: string;
  name: string;
  stock_unit: string;
  stock_quantity: number;
  reorder_level: number;
  default_location_id: string | null;
  default_location_name: string | null;
  nearest_expiry: string | null;
  low_stock: boolean;
  variants: Variant[];
};

export type Variant = {
  id: string;
  product_id: string;
  product_name?: string;
  brand_name: string | null;
  variant_name: string | null;
  barcode: string | null;
  package_size: number | null;
  package_unit: string | null;
  stock_quantity: number;
  nearest_expiry: string | null;
  location_ids?: string | null;
  default_location_id?: string | null;
  batches?: Batch[];
};

export type Batch = {
  id: string;
  quantity: number;
  location_id: string | null;
  location_name: string | null;
  best_before_date: string | null;
  use_by_date: string | null;
};

export type Recipe = {
  id: string;
  name: string;
  description: string | null;
  effort: "low" | "medium" | "high" | null;
  preparation_minutes: number | null;
  cooking_minutes: number | null;
  instructions: string | null;
  active: number;
  weekdays: number[];
  ingredients: RecipeIngredient[];
  availability: {
    status: string;
    missing_count: number;
    ingredients: Array<{ product_name: string; available: boolean }>;
  };
};

export type RecipeIngredient = {
  id?: string;
  product_id: string | null;
  ingredient_name: string | null;
  product_name?: string;
  required_variant_id: string | null;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
};

export type PlannerDay = {
  date: string;
  weekday: number;
  recipe_id: string | null;
  recipe_name: string | null;
  assignment_type: "fixed" | "random" | "recurring" | "override" | "unplanned";
  recurrence_rule_id: string | null;
  recurring_recipe_id: string | null;
};

export type PlannerWeek = {
  start_date: string;
  days: PlannerDay[];
};

export type Location = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
};

export type ShoppingItem = {
  id: string;
  product_id: string | null;
  product_name: string | null;
  custom_name: string | null;
  quantity: number | null;
  unit: string | null;
  source: "manual" | "low_stock" | "recipe";
  status: "needed" | "purchased" | "dismissed";
};

export type KitchenSnapshot = {
  inventory: Product[];
  recipes: Recipe[];
  planner: { weeks: PlannerWeek[]; start_date: string };
  shopping: ShoppingItem[];
  locations: Location[];
  recurrences: Array<Record<string, unknown>>;
  settings: Record<string, unknown>;
  database: Record<string, unknown>;
  dashboard: {
    today: Record<string, unknown>;
    low_stock: Array<Record<string, unknown>>;
    shopping: Array<Record<string, unknown>>;
    expiring: Array<Record<string, unknown>>;
    inventory_product_count: number;
    planner?: { weeks: Array<{ days: Array<Record<string, unknown>> }> };
  };
};
