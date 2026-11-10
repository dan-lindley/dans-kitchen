CREATE TABLE storage_locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    stock_unit TEXT NOT NULL,
    reorder_level REAL NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
    default_location_id TEXT REFERENCES storage_locations(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_active_name ON products(active, name);

CREATE TABLE product_variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    brand_name TEXT,
    variant_name TEXT,
    barcode TEXT,
    package_size REAL CHECK (package_size IS NULL OR package_size > 0),
    package_unit TEXT,
    image_url TEXT,
    external_source TEXT,
    external_source_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((package_size IS NULL) = (package_unit IS NULL))
);
CREATE UNIQUE INDEX idx_product_variants_barcode ON product_variants(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_variants_product ON product_variants(product_id);

CREATE TABLE inventory_batches (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity REAL NOT NULL CHECK (quantity >= 0),
    location_id TEXT REFERENCES storage_locations(id) ON DELETE SET NULL,
    best_before_date TEXT,
    use_by_date TEXT,
    acquired_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (best_before_date IS NULL OR date(best_before_date) IS NOT NULL),
    CHECK (use_by_date IS NULL OR date(use_by_date) IS NOT NULL)
);
CREATE INDEX idx_batches_variant_location ON inventory_batches(variant_id, location_id);
CREATE INDEX idx_batches_expiry ON inventory_batches(use_by_date, best_before_date);

CREATE TABLE stock_transactions (
    id TEXT PRIMARY KEY,
    batch_id TEXT REFERENCES inventory_batches(id) ON DELETE RESTRICT,
    variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('add','use','correct','discard','transfer_in','transfer_out')),
    quantity_change REAL NOT NULL,
    quantity_before REAL NOT NULL CHECK (quantity_before >= 0),
    quantity_after REAL NOT NULL CHECK (quantity_after >= 0),
    reason TEXT,
    timestamp TEXT NOT NULL,
    request_key TEXT UNIQUE,
    CHECK (abs((quantity_after - quantity_before) - quantity_change) < 0.0000001)
);
CREATE INDEX idx_transactions_variant_time ON stock_transactions(variant_id, timestamp DESC);
CREATE INDEX idx_transactions_batch_time ON stock_transactions(batch_id, timestamp DESC);

CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT,
    effort TEXT CHECK (effort IS NULL OR effort IN ('low','medium','high')),
    preparation_minutes INTEGER CHECK (preparation_minutes IS NULL OR preparation_minutes >= 0),
    cooking_minutes INTEGER CHECK (cooking_minutes IS NULL OR cooking_minutes >= 0),
    instructions TEXT,
    image_path TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_recipes_active_name ON recipes(active, name);

CREATE TABLE recipe_ingredients (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    required_variant_id TEXT REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity REAL CHECK (quantity IS NULL OR quantity > 0),
    unit TEXT,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CHECK ((quantity IS NULL) = (unit IS NULL))
);
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id, sort_order);
CREATE INDEX idx_recipe_ingredients_product ON recipe_ingredients(product_id);

CREATE TABLE recipe_weekdays (
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    PRIMARY KEY (recipe_id, weekday)
);

CREATE TABLE meal_recurrence_rules (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
    anchor_date TEXT NOT NULL,
    interval_weeks INTEGER NOT NULL CHECK (interval_weeks IN (1, 2, 4)),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (date(anchor_date) IS NOT NULL)
);
CREATE UNIQUE INDEX idx_active_recurrence_weekday ON meal_recurrence_rules(weekday)
    WHERE active = 1;

CREATE TABLE meal_plan_entries (
    id TEXT PRIMARY KEY,
    plan_date TEXT NOT NULL UNIQUE,
    recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
    assignment_type TEXT NOT NULL CHECK (assignment_type IN ('fixed','random','recurring','override','unplanned')),
    recurrence_rule_id TEXT REFERENCES meal_recurrence_rules(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_plan_date ON meal_plan_entries(plan_date);

CREATE TABLE recurrence_exceptions (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL REFERENCES meal_recurrence_rules(id) ON DELETE CASCADE,
    occurrence_date TEXT NOT NULL,
    exception_type TEXT NOT NULL CHECK (exception_type IN ('override','skip')),
    replacement_recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (rule_id, occurrence_date),
    CHECK ((exception_type = 'override' AND replacement_recipe_id IS NOT NULL) OR
           (exception_type = 'skip' AND replacement_recipe_id IS NULL))
);

CREATE TABLE shopping_items (
    id TEXT PRIMARY KEY,
    product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
    requested_variant_id TEXT REFERENCES product_variants(id) ON DELETE SET NULL,
    custom_name TEXT,
    quantity REAL CHECK (quantity IS NULL OR quantity > 0),
    unit TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual','low_stock','recipe')),
    status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','purchased','dismissed')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((product_id IS NOT NULL) OR (custom_name IS NOT NULL)),
    CHECK (requested_variant_id IS NULL OR product_id IS NOT NULL),
    CHECK ((quantity IS NULL) = (unit IS NULL))
);
CREATE UNIQUE INDEX idx_shopping_low_stock_needed ON shopping_items(product_id)
    WHERE source = 'low_stock' AND status = 'needed' AND product_id IS NOT NULL;
CREATE INDEX idx_shopping_status ON shopping_items(status, source, created_at);

CREATE TABLE app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE barcode_lookup_cache (
    barcode TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);

CREATE TABLE unit_conversions (
    from_unit TEXT NOT NULL COLLATE NOCASE,
    to_unit TEXT NOT NULL COLLATE NOCASE,
    multiplier REAL NOT NULL CHECK (multiplier > 0),
    PRIMARY KEY (from_unit, to_unit),
    CHECK (from_unit <> to_unit)
);

CREATE TABLE idempotency_requests (
    request_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
);
