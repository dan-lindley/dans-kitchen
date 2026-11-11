"""Domain operations for products, stock, recipes, planning, and shopping."""

from __future__ import annotations

import json
import random
import sqlite3
import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any

from ..const import DEFAULT_EXPIRY_WARNING_DAYS, DEFAULT_PLAN_DAYS
from ..database import Database


class DomainError(ValueError):
    """Raised when a user request violates a household data rule."""


def _id() -> str:
    return str(uuid.uuid4())


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _text(value: Any, label: str, *, maximum: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise DomainError(f"Enter a {label} of at most {maximum} characters.")
    return value.strip()


def _positive(value: Any, label: str, *, allow_zero: bool = False) -> float:
    if isinstance(value, bool):
        raise DomainError(f"{label} must be a number.")
    try:
        number = float(value)
    except (TypeError, ValueError) as err:
        raise DomainError(f"{label} must be a number.") from err
    invalid = number < 0 if allow_zero else number <= 0
    if invalid:
        qualifier = "zero or more" if allow_zero else "greater than zero"
        raise DomainError(f"{label} must be {qualifier}.")
    return number


def _date(value: Any, label: str, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise DomainError(f"{label} must be an ISO date.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as err:
        raise DomainError(f"{label} must be an ISO date.") from err
    if parsed.isoformat() != value:
        raise DomainError(f"{label} must be an ISO date.")
    return value


def _idempotent_result(
    connection: sqlite3.Connection, request_key: str | None
) -> dict[str, Any] | None:
    if not request_key:
        return None
    row = connection.execute(
        "SELECT response_json FROM idempotency_requests WHERE request_key = ?",
        (request_key,),
    ).fetchone()
    return json.loads(row["response_json"]) if row else None


def _save_idempotent_result(
    connection: sqlite3.Connection,
    request_key: str | None,
    result: dict[str, Any],
) -> None:
    if request_key:
        connection.execute(
            "INSERT INTO idempotency_requests(request_key,response_json,created_at) VALUES (?,?,?)",
            (request_key, json.dumps(result), _now()),
        )


class KitchenService:
    """Business rules shared by UI, Home Assistant actions, and dashboard cards."""

    def __init__(self, database: Database) -> None:
        self.db = database

    async def async_create_location(
        self, name: str, description: str | None = None
    ) -> dict[str, Any]:
        location_name = _text(name, "location name", maximum=100)
        now = _now()
        identifier = _id()
        try:
            await self.db.async_execute(
                "INSERT INTO storage_locations(id,name,description,sort_order,created_at,updated_at) "
                "VALUES (?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM storage_locations),0),?,?)",
                (identifier, location_name, description, now, now),
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A location with that name already exists.") from err
        return await self.async_location(identifier)

    async def async_location(self, location_id: str) -> dict[str, Any]:
        item = await self.db.async_fetch_one(
            "SELECT * FROM storage_locations WHERE id = ?", (location_id,)
        )
        if item is None:
            raise DomainError("That storage location no longer exists.")
        return item

    async def async_list_locations(self) -> list[dict[str, Any]]:
        return await self.db.async_fetch_all(
            "SELECT * FROM storage_locations WHERE active = 1 ORDER BY sort_order,name"
        )

    async def async_update_location(
        self,
        location_id: str,
        *,
        name: str | None = None,
        description: str | None = None,
        sort_order: int | None = None,
    ) -> dict[str, Any]:
        fields: list[str] = []
        values: list[Any] = []
        if name is not None:
            fields.append("name = ?")
            values.append(_text(name, "location name", maximum=100))
        if description is not None:
            fields.append("description = ?")
            values.append(description.strip() or None)
        if sort_order is not None:
            if isinstance(sort_order, bool) or not isinstance(sort_order, int):
                raise DomainError("Sort order must be a whole number.")
            fields.append("sort_order = ?")
            values.append(sort_order)
        if not fields:
            return await self.async_location(location_id)
        fields.append("updated_at = ?")
        values.append(_now())
        values.append(location_id)
        try:
            changed = await self.db.async_execute(
                f"UPDATE storage_locations SET {', '.join(fields)} WHERE id = ? AND active = 1",
                values,
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A location with that name already exists.") from err
        if not changed:
            raise DomainError("That storage location no longer exists.")
        return await self.async_location(location_id)

    async def async_delete_location(self, location_id: str) -> None:
        references = await self.db.async_fetch_one(
            "SELECT (SELECT COUNT(*) FROM products WHERE default_location_id=?) + "
            "(SELECT COUNT(*) FROM inventory_batches WHERE location_id=?) AS total",
            (location_id, location_id),
        )
        if not references or references["total"]:
            raise DomainError("Reassign products and stock before deleting this location.")
        if not await self.db.async_execute(
            "DELETE FROM storage_locations WHERE id = ?", (location_id,)
        ):
            raise DomainError("That storage location no longer exists.")

    async def async_reorder_location(self, location_id: str, direction: int) -> None:
        if direction not in (-1, 1):
            raise DomainError("Move a storage location one position up or down.")

        def reorder(connection: sqlite3.Connection) -> None:
            items = connection.execute(
                "SELECT id,sort_order FROM storage_locations WHERE active=1 "
                "ORDER BY sort_order,name"
            ).fetchall()
            index = next(
                (position for position, row in enumerate(items) if row["id"] == location_id),
                None,
            )
            if index is None:
                raise DomainError("That storage location no longer exists.")
            neighbor = index + direction
            if not 0 <= neighbor < len(items):
                return
            reordered = list(items)
            reordered[index], reordered[neighbor] = reordered[neighbor], reordered[index]
            for position, row in enumerate(reordered):
                connection.execute(
                    "UPDATE storage_locations SET sort_order=?,updated_at=? WHERE id=?",
                    (position * 10, _now(), row["id"]),
                )

        await self.db.async_transaction(reorder)

    async def async_product_detail(self, product_id: str) -> dict[str, Any]:
        product = await self.async_product(product_id)
        variants = await self.async_list_variants(product_id)
        for variant in variants:
            variant["batches"] = await self.db.async_fetch_all(
                "SELECT b.*,l.name AS location_name FROM inventory_batches b "
                "LEFT JOIN storage_locations l ON l.id=b.location_id WHERE b.variant_id=? "
                "ORDER BY COALESCE(b.use_by_date,b.best_before_date,'9999-12-31'),b.acquired_at",
                (variant["id"],),
            )
        return {
            "product": {**product, "variants": variants},
            "history": await self.async_transactions(product_id=product_id, limit=50),
        }

    async def async_create_product(
        self,
        *,
        name: str,
        stock_unit: str,
        description: str | None = None,
        reorder_level: float = 0,
        default_location_id: str | None = None,
    ) -> dict[str, Any]:
        product_name = _text(name, "product name")
        unit = _text(stock_unit, "stock unit", maximum=40)
        threshold = _positive(reorder_level, "Reorder level", allow_zero=True)
        if default_location_id and not await self.db.async_fetch_one(
            "SELECT id FROM storage_locations WHERE id=? AND active=1",
            (default_location_id,),
        ):
            raise DomainError("Choose an active storage location.")
        identifier, now = _id(), _now()
        try:
            await self.db.async_execute(
                "INSERT INTO products(id,name,description,stock_unit,reorder_level,default_location_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    identifier,
                    product_name,
                    description.strip() if description else None,
                    unit,
                    threshold,
                    default_location_id,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A product with that name already exists.") from err
        return await self.async_product(identifier)

    async def async_update_product(self, product_id: str, **fields: Any) -> dict[str, Any]:
        existing = await self.async_product(product_id)
        updates: dict[str, Any] = {}
        if "name" in fields and fields["name"] is not None:
            updates["name"] = _text(fields["name"], "product name")
        if "stock_unit" in fields and fields["stock_unit"] is not None:
            updates["stock_unit"] = _text(fields["stock_unit"], "stock unit", maximum=40)
        if "description" in fields:
            updates["description"] = fields["description"].strip() or None
        if "reorder_level" in fields and fields["reorder_level"] is not None:
            updates["reorder_level"] = _positive(
                fields["reorder_level"], "Reorder level", allow_zero=True
            )
        if "default_location_id" in fields:
            location_id = fields["default_location_id"]
            if location_id and not await self.db.async_fetch_one(
                "SELECT id FROM storage_locations WHERE id=? AND active=1",
                (location_id,),
            ):
                raise DomainError("Choose an active storage location.")
            updates["default_location_id"] = location_id
        if "active" in fields:
            updates["active"] = int(bool(fields["active"]))
        if not updates:
            return existing
        updates["updated_at"] = _now()
        try:
            await self.db.async_execute(
                "UPDATE products SET " + ", ".join(f"{key}=?" for key in updates) + " WHERE id=?",
                [*updates.values(), product_id],
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A product with that name already exists.") from err
        return await self.async_product(product_id)

    async def async_product(self, product_id: str) -> dict[str, Any]:
        product = await self.db.async_fetch_one(
            "SELECT p.*, l.name AS default_location_name FROM products p "
            "LEFT JOIN storage_locations l ON l.id=p.default_location_id WHERE p.id=?",
            (product_id,),
        )
        if product is None:
            raise DomainError("That product no longer exists.")
        product["stock"] = await self.async_product_stock(product_id)
        return product

    async def async_product_stock(self, product_id: str) -> dict[str, Any]:
        row = await self.db.async_fetch_one(
            "SELECT COALESCE(SUM(b.quantity),0) AS quantity, p.stock_unit, "
            "MIN(COALESCE(b.use_by_date,b.best_before_date)) AS nearest_expiry "
            "FROM products p LEFT JOIN product_variants v ON v.product_id=p.id "
            "LEFT JOIN inventory_batches b ON b.variant_id=v.id "
            "WHERE p.id=?",
            (product_id,),
        )
        return {
            "quantity": row["quantity"] if row else 0,
            "unit": row["stock_unit"] if row else None,
            "nearest_expiry": row["nearest_expiry"] if row else None,
        }

    async def async_list_inventory(
        self, *, search: str = "", location_id: str | None = None, low_stock: bool = False
    ) -> list[dict[str, Any]]:
        query = """
            SELECT p.id, p.name, p.description, p.stock_unit, p.reorder_level,
                   p.default_location_id, dl.name AS default_location_name, p.active,
                   COALESCE(SUM(b.quantity),0) AS stock_quantity,
                   MIN(COALESCE(b.use_by_date,b.best_before_date)) AS nearest_expiry
            FROM products p
            LEFT JOIN storage_locations dl ON dl.id=p.default_location_id
            LEFT JOIN product_variants v ON v.product_id=p.id
            LEFT JOIN inventory_batches b ON b.variant_id=v.id
            WHERE p.active=1
        """
        params: list[Any] = []
        if search.strip():
            like = f"%{search.strip()}%"
            query += " AND (p.name LIKE ? COLLATE NOCASE OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id=p.id AND (sv.barcode LIKE ? OR sv.brand_name LIKE ? COLLATE NOCASE OR sv.variant_name LIKE ? COLLATE NOCASE)))"
            params.extend((like, like, like, like))
        if location_id:
            query += " AND EXISTS (SELECT 1 FROM product_variants lv JOIN inventory_batches lb ON lb.variant_id=lv.id WHERE lv.product_id=p.id AND lb.location_id=?)"
            params.append(location_id)
        query += " GROUP BY p.id"
        if low_stock:
            query += " HAVING p.reorder_level > 0 AND stock_quantity <= p.reorder_level"
        query += " ORDER BY p.name COLLATE NOCASE"
        products = await self.db.async_fetch_all(query, params)
        for product in products:
            product["low_stock"] = (
                product["reorder_level"] > 0
                and product["stock_quantity"] <= product["reorder_level"]
            )
            product["variants"] = await self.async_list_variants(product["id"])
        return products

    async def async_create_variant(
        self,
        product_id: str,
        *,
        brand_name: str | None = None,
        variant_name: str | None = None,
        barcode: str | None = None,
        package_size: float | None = None,
        package_unit: str | None = None,
        image_url: str | None = None,
        external_source: str | None = None,
        external_source_id: str | None = None,
    ) -> dict[str, Any]:
        await self.async_product(product_id)
        if barcode is not None:
            barcode = _text(barcode, "barcode", maximum=80)
            if not barcode.isdecimal():
                raise DomainError("Barcode must contain digits only.")
        if (package_size is None) != (package_unit is None):
            raise DomainError("Enter both package size and package unit.")
        size = _positive(package_size, "Package size") if package_size is not None else None
        now, identifier = _now(), _id()
        try:
            await self.db.async_execute(
                "INSERT INTO product_variants(id,product_id,brand_name,variant_name,barcode,package_size,package_unit,image_url,external_source,external_source_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    identifier,
                    product_id,
                    brand_name.strip() if brand_name else None,
                    variant_name.strip() if variant_name else None,
                    barcode,
                    size,
                    package_unit.strip() if package_unit else None,
                    image_url,
                    external_source,
                    external_source_id,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("That barcode is already assigned to a product variant.") from err
        return await self.async_variant(identifier)

    async def async_update_variant(self, variant_id: str, **fields: Any) -> dict[str, Any]:
        await self.async_variant(variant_id)
        allowed = {
            "brand_name",
            "variant_name",
            "barcode",
            "package_size",
            "package_unit",
            "image_url",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if "barcode" in updates and updates["barcode"] is not None:
            barcode = _text(updates["barcode"], "barcode", maximum=80)
            if not barcode.isdecimal():
                raise DomainError("Barcode must contain digits only.")
            updates["barcode"] = barcode
        if ("package_size" in updates) != ("package_unit" in updates):
            raise DomainError("Enter both package size and package unit when changing pack size.")
        if updates.get("package_size") is not None:
            updates["package_size"] = _positive(updates["package_size"], "Package size")
        updates["updated_at"] = _now()
        try:
            await self.db.async_execute(
                "UPDATE product_variants SET "
                + ", ".join(f"{key}=?" for key in updates)
                + " WHERE id=?",
                [*updates.values(), variant_id],
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("That barcode is already assigned to a product variant.") from err
        return await self.async_variant(variant_id)

    async def async_variant(self, variant_id: str) -> dict[str, Any]:
        variant = await self.db.async_fetch_one(
            "SELECT v.*,p.name AS product_name,p.stock_unit FROM product_variants v "
            "JOIN products p ON p.id=v.product_id WHERE v.id=?",
            (variant_id,),
        )
        if variant is None:
            raise DomainError("That product variant no longer exists.")
        variant["batches"] = await self.db.async_fetch_all(
            "SELECT b.*,l.name AS location_name FROM inventory_batches b "
            "LEFT JOIN storage_locations l ON l.id=b.location_id WHERE b.variant_id=? "
            "ORDER BY COALESCE(b.use_by_date,b.best_before_date,'9999-12-31'),b.acquired_at",
            (variant_id,),
        )
        return variant

    async def async_list_variants(self, product_id: str) -> list[dict[str, Any]]:
        return await self.db.async_fetch_all(
            "SELECT v.*, COALESCE(SUM(b.quantity),0) AS stock_quantity, "
            "GROUP_CONCAT(DISTINCT b.location_id) AS location_ids, "
            "MIN(COALESCE(b.use_by_date,b.best_before_date)) AS nearest_expiry "
            "FROM product_variants v LEFT JOIN inventory_batches b ON b.variant_id=v.id "
            "WHERE v.product_id=? GROUP BY v.id ORDER BY v.brand_name,v.variant_name",
            (product_id,),
        )

    async def async_find_barcode(self, barcode: str) -> dict[str, Any] | None:
        code = _text(barcode, "barcode", maximum=80)
        if not code.isdecimal():
            raise DomainError("Barcode must contain digits only.")
        variant = await self.db.async_fetch_one(
            "SELECT v.*,p.name AS product_name,p.stock_unit,p.default_location_id "
            "FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.barcode=?",
            (code,),
        )
        return variant

    async def async_register_barcode_product(
        self,
        *,
        barcode: str,
        quantity: float = 1,
        product_id: str | None = None,
        product_name: str | None = None,
        stock_unit: str = "item",
        description: str | None = None,
        brand_name: str | None = None,
        variant_name: str | None = None,
        package_size: float | None = None,
        package_unit: str | None = None,
        image_url: str | None = None,
        external_source: str | None = None,
        external_source_id: str | None = None,
        default_location_id: str | None = None,
        location_id: str | None = None,
        best_before_date: str | None = None,
        use_by_date: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a barcode variant and first stock batch in one transaction."""
        code = _text(barcode, "barcode", maximum=80)
        if not code.isdecimal():
            raise DomainError("Barcode must contain digits only.")
        amount = _positive(quantity, "Quantity")
        name = _text(product_name, "product name") if not product_id else None
        unit = _text(stock_unit, "stock unit", maximum=40) if not product_id else None
        size = _positive(package_size, "Package size") if package_size is not None else None
        if (size is None) != (package_unit is None):
            raise DomainError("Enter both package size and package unit.")
        best_before = _date(best_before_date, "Best-before date", optional=True)
        use_by = _date(use_by_date, "Use-by date", optional=True)
        now = _now()

        def register(connection: sqlite3.Connection) -> dict[str, str]:
            prior = _idempotent_result(connection, request_key)
            if prior:
                return prior
            if product_id:
                product = connection.execute(
                    "SELECT id,default_location_id FROM products WHERE id=? AND active=1",
                    (product_id,),
                ).fetchone()
                if not product:
                    raise DomainError("Choose an active generic product.")
                chosen_product_id = product["id"]
                preferred_location = product["default_location_id"]
            else:
                chosen_product_id = _id()
                connection.execute(
                    "INSERT INTO products(id,name,description,stock_unit,reorder_level,default_location_id,created_at,updated_at) "
                    "VALUES (?,?,?,?,0,?,?,?)",
                    (
                        chosen_product_id,
                        name,
                        description.strip() if description else None,
                        unit,
                        default_location_id,
                        now,
                        now,
                    ),
                )
                preferred_location = default_location_id
            for selected_location in (default_location_id, location_id, preferred_location):
                if (
                    selected_location
                    and not connection.execute(
                        "SELECT id FROM storage_locations WHERE id=? AND active=1",
                        (selected_location,),
                    ).fetchone()
                ):
                    raise DomainError("Choose an active storage location.")
            chosen_location = location_id or preferred_location or default_location_id
            variant_id, batch_id, transaction_id = _id(), _id(), _id()
            connection.execute(
                "INSERT INTO product_variants(id,product_id,brand_name,variant_name,barcode,package_size,package_unit,image_url,external_source,external_source_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    variant_id,
                    chosen_product_id,
                    brand_name.strip() if brand_name else None,
                    variant_name.strip() if variant_name else None,
                    code,
                    size,
                    package_unit.strip() if package_unit else None,
                    image_url,
                    external_source,
                    external_source_id,
                    now,
                    now,
                ),
            )
            connection.execute(
                "INSERT INTO inventory_batches(id,variant_id,quantity,location_id,best_before_date,use_by_date,acquired_at,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (batch_id, variant_id, amount, chosen_location, best_before, use_by, now, now, now),
            )
            connection.execute(
                "INSERT INTO stock_transactions(id,batch_id,variant_id,transaction_type,quantity_change,quantity_before,quantity_after,reason,timestamp) "
                "VALUES (?,?,?,'add',?,0,?,?,?)",
                (transaction_id, batch_id, variant_id, amount, amount, "Barcode scan", now),
            )
            result = {
                "product_id": chosen_product_id,
                "variant_id": variant_id,
                "batch_id": batch_id,
                "transaction_id": transaction_id,
            }
            _save_idempotent_result(connection, request_key, result)
            return result

        try:
            ids = await self.db.async_transaction(register)
        except sqlite3.IntegrityError as err:
            if "barcode" in str(err).lower():
                raise DomainError("That barcode is already assigned to a product variant.") from err
            if "products.name" in str(err).lower():
                raise DomainError("A generic product with that name already exists.") from err
            raise
        return {
            "product": await self.async_product(ids["product_id"]),
            "variant": await self.async_variant(ids["variant_id"]),
            "batch_id": ids["batch_id"],
            "transaction_id": ids["transaction_id"],
            "quantity_added": amount,
        }

    async def async_add_stock(
        self,
        variant_id: str,
        quantity: float,
        *,
        location_id: str | None = None,
        best_before_date: str | None = None,
        use_by_date: str | None = None,
        reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        amount = _positive(quantity, "Quantity")
        best_before = _date(best_before_date, "Best-before date", optional=True)
        use_by = _date(use_by_date, "Use-by date", optional=True)
        variant = await self.async_variant(variant_id)
        chosen_location = location_id
        if chosen_location is None:
            chosen_location = (
                await self.db.async_fetch_one(
                    "SELECT default_location_id FROM products WHERE id=?",
                    (variant["product_id"],),
                )
            )["default_location_id"]
        if chosen_location and not await self.db.async_fetch_one(
            "SELECT id FROM storage_locations WHERE id=? AND active=1",
            (chosen_location,),
        ):
            raise DomainError("Choose an active storage location.")

        def add(connection: sqlite3.Connection) -> dict[str, Any]:
            prior = _idempotent_result(connection, request_key)
            if prior:
                return prior
            now, batch_id, transaction_id = _now(), _id(), _id()
            connection.execute(
                "INSERT INTO inventory_batches(id,variant_id,quantity,location_id,best_before_date,use_by_date,acquired_at,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (batch_id, variant_id, amount, chosen_location, best_before, use_by, now, now, now),
            )
            connection.execute(
                "INSERT INTO stock_transactions(id,batch_id,variant_id,transaction_type,quantity_change,quantity_before,quantity_after,reason,timestamp) "
                "VALUES (?,?,?,'add',?,0,?,?,?)",
                (transaction_id, batch_id, variant_id, amount, amount, reason, now),
            )
            result = {
                "batch_id": batch_id,
                "transaction_id": transaction_id,
                "variant_id": variant_id,
                "quantity_added": amount,
                "stock_unit": variant["stock_unit"],
            }
            _save_idempotent_result(connection, request_key, result)
            return result

        return await self.db.async_transaction(add)

    async def async_use_stock(
        self,
        product_id: str,
        quantity: float,
        *,
        variant_id: str | None = None,
        batch_id: str | None = None,
        reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        requested = _positive(quantity, "Quantity")
        await self.async_product(product_id)
        if variant_id:
            variant = await self.async_variant(variant_id)
            if variant["product_id"] != product_id:
                raise DomainError("The chosen variant does not belong to this product.")
        if batch_id:
            valid_batch = await self.db.async_fetch_one(
                "SELECT b.id FROM inventory_batches b JOIN product_variants v ON v.id=b.variant_id "
                "WHERE b.id=? AND v.product_id=? AND (? IS NULL OR v.id=?)",
                (batch_id, product_id, variant_id, variant_id),
            )
            if not valid_batch:
                raise DomainError("The selected batch is not part of this product.")
        prefer_expiry = (await self.async_get_settings())["prefer_expiring_stock"]
        batch_order = (
            "COALESCE(b.use_by_date,b.best_before_date,'9999-12-31'),b.acquired_at,b.id"
            if prefer_expiry
            else "b.acquired_at,b.id"
        )

        def consume(connection: sqlite3.Connection) -> dict[str, Any]:
            prior = _idempotent_result(connection, request_key)
            if prior:
                return prior
            remaining = requested
            clauses = ["v.product_id=?", "b.quantity > 0"]
            params: list[Any] = [product_id]
            if variant_id:
                clauses.append("v.id=?")
                params.append(variant_id)
            if batch_id:
                clauses.append("b.id=?")
                params.append(batch_id)
            batches = connection.execute(
                "SELECT b.*,v.product_id FROM inventory_batches b "
                "JOIN product_variants v ON v.id=b.variant_id WHERE "
                + " AND ".join(clauses)
                + f" ORDER BY {batch_order}",
                params,
            ).fetchall()
            if sum(batch["quantity"] for batch in batches) + 1e-9 < remaining:
                raise DomainError("There is not enough stock to complete this operation.")
            affected: list[dict[str, Any]] = []
            now = _now()
            for batch in batches:
                if remaining <= 1e-9:
                    break
                used = min(remaining, batch["quantity"])
                after = batch["quantity"] - used
                connection.execute(
                    "UPDATE inventory_batches SET quantity=?,updated_at=? WHERE id=?",
                    (after, now, batch["id"]),
                )
                transaction_type = "discard" if reason == "discard" else "use"
                transaction_id = _id()
                connection.execute(
                    "INSERT INTO stock_transactions(id,batch_id,variant_id,transaction_type,quantity_change,quantity_before,quantity_after,reason,timestamp) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        transaction_id,
                        batch["id"],
                        batch["variant_id"],
                        transaction_type,
                        -used,
                        batch["quantity"],
                        after,
                        reason,
                        now,
                    ),
                )
                affected.append(
                    {"batch_id": batch["id"], "variant_id": batch["variant_id"], "used": used}
                )
                remaining -= used
            result = {"quantity_used": requested, "batches": affected}
            _save_idempotent_result(connection, request_key, result)
            return result

        return await self.db.async_transaction(consume)

    async def async_correct_stock(
        self,
        batch_id: str,
        quantity: float,
        *,
        reason: str | None = None,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        desired = _positive(quantity, "Corrected quantity", allow_zero=True)

        def correct(connection: sqlite3.Connection) -> dict[str, Any]:
            prior = _idempotent_result(connection, request_key)
            if prior:
                return prior
            batch = connection.execute(
                "SELECT * FROM inventory_batches WHERE id=?", (batch_id,)
            ).fetchone()
            if not batch:
                raise DomainError("That inventory batch no longer exists.")
            change = desired - batch["quantity"]
            now = _now()
            connection.execute(
                "UPDATE inventory_batches SET quantity=?,updated_at=? WHERE id=?",
                (desired, now, batch_id),
            )
            transaction_id = _id()
            connection.execute(
                "INSERT INTO stock_transactions(id,batch_id,variant_id,transaction_type,quantity_change,quantity_before,quantity_after,reason,timestamp) "
                "VALUES (?,?,?,'correct',?,?,?,?,?)",
                (
                    transaction_id,
                    batch_id,
                    batch["variant_id"],
                    change,
                    batch["quantity"],
                    desired,
                    reason,
                    now,
                ),
            )
            result = {
                "batch_id": batch_id,
                "transaction_id": transaction_id,
                "quantity_before": batch["quantity"],
                "quantity_after": desired,
            }
            _save_idempotent_result(connection, request_key, result)
            return result

        return await self.db.async_transaction(correct)

    async def async_transfer_stock(
        self,
        batch_id: str,
        quantity: float,
        target_location_id: str,
        *,
        request_key: str | None = None,
    ) -> dict[str, Any]:
        amount = _positive(quantity, "Transfer quantity")
        if not await self.db.async_fetch_one(
            "SELECT id FROM storage_locations WHERE id=? AND active=1",
            (target_location_id,),
        ):
            raise DomainError("Choose an active destination location.")

        def transfer(connection: sqlite3.Connection) -> dict[str, Any]:
            prior = _idempotent_result(connection, request_key)
            if prior:
                return prior
            batch = connection.execute(
                "SELECT * FROM inventory_batches WHERE id=?", (batch_id,)
            ).fetchone()
            if not batch or batch["quantity"] < amount:
                raise DomainError("The selected batch does not contain enough stock.")
            if batch["location_id"] == target_location_id:
                raise DomainError("Choose a different destination location.")
            now = _now()
            target = connection.execute(
                "SELECT id,quantity FROM inventory_batches WHERE variant_id=? AND location_id IS ? "
                "AND best_before_date IS ? AND use_by_date IS ? ORDER BY created_at LIMIT 1",
                (
                    batch["variant_id"],
                    target_location_id,
                    batch["best_before_date"],
                    batch["use_by_date"],
                ),
            ).fetchone()
            if target:
                connection.execute(
                    "UPDATE inventory_batches SET quantity=quantity+?,updated_at=? WHERE id=?",
                    (amount, now, target["id"]),
                )
                target_id, after = target["id"], target["quantity"] + amount
                target_before = target["quantity"]
            else:
                target_id, after = _id(), amount
                target_before = 0
                connection.execute(
                    "INSERT INTO inventory_batches(id,variant_id,quantity,location_id,best_before_date,use_by_date,acquired_at,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        target_id,
                        batch["variant_id"],
                        amount,
                        target_location_id,
                        batch["best_before_date"],
                        batch["use_by_date"],
                        batch["acquired_at"],
                        now,
                        now,
                    ),
                )
            source_after = batch["quantity"] - amount
            connection.execute(
                "UPDATE inventory_batches SET quantity=?,updated_at=? WHERE id=?",
                (source_after, now, batch_id),
            )
            for kind, delta, before, after_quantity, source_batch in (
                ("transfer_out", -amount, batch["quantity"], source_after, batch_id),
                ("transfer_in", amount, target_before, after, target_id),
            ):
                connection.execute(
                    "INSERT INTO stock_transactions(id,batch_id,variant_id,transaction_type,quantity_change,quantity_before,quantity_after,reason,timestamp) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        _id(),
                        source_batch,
                        batch["variant_id"],
                        kind,
                        delta,
                        before,
                        after_quantity,
                        f"Transfer to {target_location_id}",
                        now,
                    ),
                )
            result = {"source_batch_id": batch_id, "target_batch_id": target_id, "quantity": amount}
            _save_idempotent_result(connection, request_key, result)
            return result

        return await self.db.async_transaction(transfer)

    async def async_transactions(
        self, *, product_id: str | None = None, limit: int = 100
    ) -> list[dict[str, Any]]:
        if not 1 <= limit <= 500:
            raise DomainError("History page size must be from 1 to 500.")
        clauses = ""
        params: list[Any] = []
        if product_id:
            clauses = "WHERE p.id=?"
            params.append(product_id)
        params.append(limit)
        return await self.db.async_fetch_all(
            "SELECT t.*,p.name AS product_name,v.brand_name,v.variant_name "
            "FROM stock_transactions t JOIN product_variants v ON v.id=t.variant_id "
            "JOIN products p ON p.id=v.product_id "
            + clauses
            + " ORDER BY t.timestamp DESC LIMIT ?",
            params,
        )

    async def async_convert_quantity(
        self, quantity: float, from_unit: str, to_unit: str
    ) -> float | None:
        amount = _positive(quantity, "Quantity", allow_zero=True)
        if from_unit.casefold() == to_unit.casefold():
            return amount
        conversion = await self.db.async_fetch_one(
            "SELECT multiplier FROM unit_conversions WHERE from_unit=? COLLATE NOCASE AND to_unit=? COLLATE NOCASE",
            (from_unit, to_unit),
        )
        if conversion:
            return amount * conversion["multiplier"]
        inverse = await self.db.async_fetch_one(
            "SELECT multiplier FROM unit_conversions WHERE from_unit=? COLLATE NOCASE AND to_unit=? COLLATE NOCASE",
            (to_unit, from_unit),
        )
        return amount / inverse["multiplier"] if inverse else None

    async def async_set_unit_conversion(
        self, from_unit: str, to_unit: str, multiplier: float
    ) -> None:
        source = _text(from_unit, "source unit", maximum=40)
        target = _text(to_unit, "target unit", maximum=40)
        if source.casefold() == target.casefold():
            raise DomainError("Choose two different units.")
        factor = _positive(multiplier, "Conversion multiplier")
        await self.db.async_execute(
            "INSERT INTO unit_conversions(from_unit,to_unit,multiplier) VALUES (?,?,?) "
            "ON CONFLICT(from_unit,to_unit) DO UPDATE SET multiplier=excluded.multiplier",
            (source, target, factor),
        )

    async def async_create_recipe(
        self,
        *,
        name: str,
        weekdays: list[int] | None = None,
        description: str | None = None,
        effort: str | None = None,
        preparation_minutes: int | None = None,
        cooking_minutes: int | None = None,
        instructions: str | None = None,
        ingredients: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        name = _text(name, "recipe name")
        selected_weekdays = list(range(7)) if weekdays is None else weekdays
        self._validate_weekdays(selected_weekdays)
        self._validate_recipe_fields(effort, preparation_minutes, cooking_minutes)
        recipe_id, now = _id(), _now()
        try:
            await self.db.async_transaction(
                lambda connection: self._write_recipe(
                    connection,
                    recipe_id,
                    name,
                    selected_weekdays,
                    {
                        "description": description.strip() if description else None,
                        "effort": effort,
                        "preparation_minutes": preparation_minutes,
                        "cooking_minutes": cooking_minutes,
                        "instructions": instructions.strip() if instructions else None,
                        "image_path": None,
                        "active": 1,
                    },
                    ingredients or [],
                    now,
                    create=True,
                )
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A recipe with that name already exists.") from err
        return await self.async_recipe(recipe_id)

    @staticmethod
    def _validate_weekdays(weekdays: Any) -> None:
        if (
            not isinstance(weekdays, list)
            or not weekdays
            or any(
                isinstance(day, bool) or not isinstance(day, int) or day not in range(7)
                for day in weekdays
            )
            or len(set(weekdays)) != len(weekdays)
        ):
            raise DomainError("Choose one or more unique weekdays (Monday=0 through Sunday=6).")

    @staticmethod
    def _validate_recipe_fields(
        effort: Any,
        preparation_minutes: Any,
        cooking_minutes: Any,
    ) -> None:
        if effort not in ("low", "medium", "high"):
            raise DomainError("Effort must be low, medium, or high.")
        if cooking_minutes is None:
            raise DomainError("Cooking time is required.")
        for label, amount in (
            ("Preparation time", preparation_minutes),
            ("Cooking time", cooking_minutes),
        ):
            if amount is not None and (
                isinstance(amount, bool) or not isinstance(amount, int) or amount < 0
            ):
                raise DomainError(f"{label} must be a non-negative whole number.")

    def _write_recipe(
        self,
        connection: sqlite3.Connection,
        recipe_id: str,
        name: str,
        weekdays: list[int],
        fields: dict[str, Any],
        ingredients: list[dict[str, Any]],
        now: str,
        *,
        create: bool,
    ) -> None:
        for ingredient in ingredients:
            if not isinstance(ingredient, dict):
                raise DomainError("Each ingredient must be an object.")
            product_id = ingredient.get("product_id")
            product = connection.execute(
                "SELECT id FROM products WHERE id=? AND active=1", (product_id,)
            ).fetchone()
            if not product:
                raise DomainError("Every recipe ingredient must reference an active product.")
            variant_id = ingredient.get("required_variant_id")
            if (
                variant_id
                and not connection.execute(
                    "SELECT id FROM product_variants WHERE id=? AND product_id=?",
                    (variant_id, product_id),
                ).fetchone()
            ):
                raise DomainError("An exact recipe variant must belong to its selected product.")
            quantity, unit = ingredient.get("quantity"), ingredient.get("unit")
            if (quantity is None) != (unit is None):
                raise DomainError("Provide both an ingredient quantity and its unit.")
            if quantity is not None:
                _positive(quantity, "Ingredient quantity")
                _text(unit, "ingredient unit", maximum=40)
        if create:
            connection.execute(
                "INSERT INTO recipes(id,name,description,effort,preparation_minutes,cooking_minutes,instructions,image_path,active,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    recipe_id,
                    name,
                    fields["description"],
                    fields["effort"],
                    fields["preparation_minutes"],
                    fields["cooking_minutes"],
                    fields["instructions"],
                    fields["image_path"],
                    fields["active"],
                    now,
                    now,
                ),
            )
        else:
            connection.execute(
                "UPDATE recipes SET name=?,description=?,effort=?,preparation_minutes=?,"
                "cooking_minutes=?,instructions=?,active=?,updated_at=? WHERE id=?",
                (
                    name,
                    fields["description"],
                    fields["effort"],
                    fields["preparation_minutes"],
                    fields["cooking_minutes"],
                    fields["instructions"],
                    fields["active"],
                    now,
                    recipe_id,
                ),
            )
            connection.execute("DELETE FROM recipe_ingredients WHERE recipe_id=?", (recipe_id,))
            connection.execute("DELETE FROM recipe_weekdays WHERE recipe_id=?", (recipe_id,))
        connection.executemany(
            "INSERT INTO recipe_weekdays(recipe_id,weekday) VALUES (?,?)",
            [(recipe_id, weekday) for weekday in weekdays],
        )
        for sort_order, ingredient in enumerate(ingredients):
            connection.execute(
                "INSERT INTO recipe_ingredients(id,recipe_id,product_id,required_variant_id,quantity,unit,notes,sort_order) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (
                    _id(),
                    recipe_id,
                    ingredient["product_id"],
                    ingredient.get("required_variant_id"),
                    ingredient.get("quantity"),
                    ingredient.get("unit"),
                    ingredient.get("notes"),
                    sort_order,
                ),
            )

    async def async_update_recipe(self, recipe_id: str, **fields: Any) -> dict[str, Any]:
        existing = await self.async_recipe(recipe_id)
        name = _text(fields.get("name", existing["name"]), "recipe name")
        weekdays = fields.get("weekdays", existing["weekdays"])
        self._validate_weekdays(weekdays)
        effort = fields.get("effort", existing["effort"])
        prep = fields.get("preparation_minutes", existing["preparation_minutes"])
        cook = fields.get("cooking_minutes", existing["cooking_minutes"])
        self._validate_recipe_fields(effort, prep, cook)
        recipe_fields = {
            "description": fields.get("description", existing["description"]),
            "effort": effort,
            "preparation_minutes": prep,
            "cooking_minutes": cook,
            "instructions": fields.get("instructions", existing["instructions"]),
            "active": int(fields.get("active", existing["active"])),
        }
        try:
            await self.db.async_transaction(
                lambda connection: self._write_recipe(
                    connection,
                    recipe_id,
                    name,
                    weekdays,
                    recipe_fields,
                    fields.get("ingredients", existing["ingredients"]),
                    _now(),
                    create=False,
                )
            )
        except sqlite3.IntegrityError as err:
            raise DomainError("A recipe with that name already exists.") from err
        return await self.async_recipe(recipe_id)

    async def async_archive_recipe(self, recipe_id: str) -> None:
        changed = await self.db.async_execute(
            "UPDATE recipes SET active=0,updated_at=? WHERE id=? AND active=1",
            (_now(), recipe_id),
        )
        if not changed:
            raise DomainError("That active recipe no longer exists.")
        await self.db.async_execute(
            "UPDATE meal_plan_entries SET recipe_id=NULL,assignment_type='unplanned',updated_at=? "
            "WHERE recipe_id=? AND assignment_type='random'",
            (_now(), recipe_id),
        )
        await self.db.async_execute(
            "UPDATE meal_recurrence_rules SET active=0,updated_at=? WHERE recipe_id=? AND active=1",
            (_now(), recipe_id),
        )

    async def async_duplicate_recipe(
        self, recipe_id: str, name: str | None = None
    ) -> dict[str, Any]:
        recipe = await self.async_recipe(recipe_id)
        return await self.async_create_recipe(
            name=name or f"{recipe['name']} (copy)",
            weekdays=recipe["weekdays"],
            description=recipe["description"],
            effort=recipe["effort"],
            preparation_minutes=recipe["preparation_minutes"],
            cooking_minutes=recipe["cooking_minutes"],
            instructions=recipe["instructions"],
            ingredients=recipe["ingredients"],
        )

    async def async_recipe(self, recipe_id: str) -> dict[str, Any]:
        recipe = await self.db.async_fetch_one("SELECT * FROM recipes WHERE id=?", (recipe_id,))
        if not recipe:
            raise DomainError("That recipe no longer exists.")
        recipe["weekdays"] = [
            row["weekday"]
            for row in await self.db.async_fetch_all(
                "SELECT weekday FROM recipe_weekdays WHERE recipe_id=? ORDER BY weekday",
                (recipe_id,),
            )
        ]
        recipe["ingredients"] = await self.db.async_fetch_all(
            "SELECT i.*,p.name AS product_name,p.stock_unit,v.brand_name,v.variant_name "
            "FROM recipe_ingredients i JOIN products p ON p.id=i.product_id "
            "LEFT JOIN product_variants v ON v.id=i.required_variant_id "
            "WHERE i.recipe_id=? ORDER BY i.sort_order",
            (recipe_id,),
        )
        return recipe

    async def async_list_recipes(
        self, *, search: str = "", include_archived: bool = False
    ) -> list[dict[str, Any]]:
        rows = await self.db.async_fetch_all(
            "SELECT id FROM recipes WHERE (? OR active=1) AND (?='' OR name LIKE ? COLLATE NOCASE) "
            "ORDER BY name COLLATE NOCASE",
            (include_archived, search.strip(), f"%{search.strip()}%"),
        )
        results = []
        for row in rows:
            recipe = await self.async_recipe(row["id"])
            recipe["availability"] = await self.async_recipe_availability(row["id"])
            results.append(recipe)
        return results

    async def async_recipe_availability(self, recipe_id: str) -> dict[str, Any]:
        recipe = await self.async_recipe(recipe_id)
        if not recipe["ingredients"]:
            return {"status": "no_ingredients", "missing_count": 0, "ingredients": []}
        results = []
        missing = 0
        for ingredient in recipe["ingredients"]:
            query = (
                "SELECT COALESCE(SUM(b.quantity),0) AS quantity FROM inventory_batches b "
                "JOIN product_variants v ON v.id=b.variant_id WHERE v.product_id=?"
            )
            params: list[Any] = [ingredient["product_id"]]
            if ingredient["required_variant_id"]:
                query += " AND v.id=?"
                params.append(ingredient["required_variant_id"])
            stock = await self.db.async_fetch_one(query, params)
            available_quantity = stock["quantity"] if stock else 0
            required = ingredient["quantity"]
            comparable = True
            if required is not None:
                converted = await self.async_convert_quantity(
                    required, ingredient["unit"], ingredient["stock_unit"]
                )
                if converted is None:
                    comparable = False
                else:
                    required = converted
            is_available = (
                available_quantity > 0
                if ingredient["quantity"] is None
                else comparable and available_quantity + 1e-9 >= required
            )
            if not is_available:
                missing += 1
            results.append(
                {
                    "product_id": ingredient["product_id"],
                    "product_name": ingredient["product_name"],
                    "required_variant_id": ingredient["required_variant_id"],
                    "available_quantity": available_quantity,
                    "stock_unit": ingredient["stock_unit"],
                    "required_quantity": ingredient["quantity"],
                    "required_unit": ingredient["unit"],
                    "available": is_available,
                    "unit_comparable": comparable,
                }
            )
        return {
            "status": "available" if missing == 0 else "missing",
            "missing_count": missing,
            "ingredients": results,
        }

    async def async_get_settings(self) -> dict[str, Any]:
        rows = await self.db.async_fetch_all("SELECT key,value FROM app_settings ORDER BY key")
        values = {row["key"]: json.loads(row["value"]) for row in rows}
        defaults = {
            "expiry_warning_days": DEFAULT_EXPIRY_WARNING_DAYS,
            "planner_max_effort": None,
            "planner_max_cooking_minutes": None,
            "repetition_window_days": 7,
            "external_lookup_enabled": True,
            "prefer_expiring_stock": True,
        }
        return {**defaults, **values}

    async def async_set_setting(self, key: str, value: Any) -> dict[str, Any]:
        validators = {
            "expiry_warning_days": lambda item: self._setting_integer(item, 0, 365),
            "planner_max_effort": lambda item: self._setting_choice(
                item, {"low", "medium", "high"}, allow_none=True
            ),
            "planner_max_cooking_minutes": lambda item: self._setting_integer(
                item, 0, 1440, allow_none=True
            ),
            "repetition_window_days": lambda item: self._setting_integer(item, 0, 28),
            "external_lookup_enabled": lambda item: self._setting_boolean(item),
            "prefer_expiring_stock": lambda item: self._setting_boolean(item),
        }
        if key not in validators:
            raise DomainError("That application setting is not supported.")
        clean_value = validators[key](value)
        await self.db.async_execute(
            "INSERT INTO app_settings(key,value,updated_at) VALUES (?,?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            (key, json.dumps(clean_value), _now()),
        )
        return {key: clean_value}

    @staticmethod
    def _setting_integer(
        value: Any, minimum: int, maximum: int, *, allow_none: bool = False
    ) -> int | None:
        if value is None and allow_none:
            return None
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise DomainError(f"Enter a whole number from {minimum} to {maximum}.")
        return value

    @staticmethod
    def _setting_choice(value: Any, choices: set[str], *, allow_none: bool = False) -> str | None:
        if value is None and allow_none:
            return None
        if value not in choices:
            raise DomainError("Choose one of the supported setting values.")
        return value

    @staticmethod
    def _setting_boolean(value: Any) -> bool:
        if not isinstance(value, bool):
            raise DomainError("This setting must be enabled or disabled.")
        return value

    @staticmethod
    def _recurrence_for_date(day: date, rules: list[dict[str, Any]]) -> dict[str, Any] | None:
        for rule in rules:
            anchor = date.fromisoformat(rule["anchor_date"])
            if day.weekday() != rule["weekday"] or day < anchor:
                continue
            weeks = (day - anchor).days // 7
            if weeks % rule["interval_weeks"] == 0:
                return rule
        return None

    async def async_set_recurrence(
        self,
        recipe_id: str,
        *,
        weekday: int,
        anchor_date: str,
        interval_weeks: int,
    ) -> dict[str, Any]:
        recipe = await self.async_recipe(recipe_id)
        anchor = _date(anchor_date, "Recurrence anchor date")
        if isinstance(weekday, bool) or not isinstance(weekday, int) or weekday not in range(7):
            raise DomainError("Choose a weekday from Monday=0 through Sunday=6.")
        if date.fromisoformat(anchor).weekday() != weekday:
            raise DomainError("The recurrence anchor must be on its selected weekday.")
        if weekday not in recipe["weekdays"]:
            raise DomainError("The recurrence weekday must be enabled for this recipe.")
        self._validate_recipe_fields(
            recipe["effort"],
            recipe["preparation_minutes"],
            recipe["cooking_minutes"],
        )
        if isinstance(interval_weeks, bool) or interval_weeks not in (1, 2, 4):
            raise DomainError("Recurrence interval must be 1, 2, or 4 weeks.")
        existing = await self.db.async_fetch_one(
            "SELECT id FROM meal_recurrence_rules WHERE recipe_id=? AND active=1",
            (recipe_id,),
        )
        now = _now()
        try:
            if existing:
                await self.db.async_execute(
                    "UPDATE meal_recurrence_rules SET weekday=?,anchor_date=?,interval_weeks=?,updated_at=? "
                    "WHERE id=?",
                    (weekday, anchor, interval_weeks, now, existing["id"]),
                )
                rule_id = existing["id"]
            else:
                rule_id = _id()
                await self.db.async_execute(
                    "INSERT INTO meal_recurrence_rules(id,recipe_id,weekday,anchor_date,interval_weeks,active,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,1,?,?)",
                    (rule_id, recipe_id, weekday, anchor, interval_weeks, now, now),
                )
        except sqlite3.IntegrityError as err:
            raise DomainError("Another active recurrence already uses that weekday.") from err
        return await self.db.async_fetch_one(
            "SELECT * FROM meal_recurrence_rules WHERE id=?", (rule_id,)
        )

    async def async_remove_recurrence(self, rule_id: str) -> None:
        if not await self.db.async_execute(
            "UPDATE meal_recurrence_rules SET active=0,updated_at=? WHERE id=? AND active=1",
            (_now(), rule_id),
        ):
            raise DomainError("That active recurrence no longer exists.")

    async def async_list_recurrences(self) -> list[dict[str, Any]]:
        return await self.db.async_fetch_all(
            "SELECT r.*,m.name AS recipe_name FROM meal_recurrence_rules r "
            "JOIN recipes m ON m.id=r.recipe_id WHERE r.active=1 "
            "ORDER BY r.weekday,r.anchor_date"
        )

    async def async_plan_meal(
        self,
        day_value: str,
        recipe_id: str | None,
        *,
        allow_ineligible: bool = False,
    ) -> dict[str, Any]:
        day = date.fromisoformat(_date(day_value, "Planner date"))
        if recipe_id:
            recipe = await self.async_recipe(recipe_id)
            self._validate_recipe_fields(
                recipe["effort"],
                recipe["preparation_minutes"],
                recipe["cooking_minutes"],
            )
            if not allow_ineligible and day.weekday() not in recipe["weekdays"]:
                raise DomainError("This recipe is not eligible on the selected weekday.")
        rules = await self.async_list_recurrences()
        rule = self._recurrence_for_date(day, rules)
        now = _now()

        def assign(connection: sqlite3.Connection) -> None:
            if rule:
                exception_type = "override" if recipe_id else "skip"
                connection.execute(
                    "INSERT INTO recurrence_exceptions(id,rule_id,occurrence_date,exception_type,replacement_recipe_id,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?) ON CONFLICT(rule_id,occurrence_date) DO UPDATE SET "
                    "exception_type=excluded.exception_type,replacement_recipe_id=excluded.replacement_recipe_id,updated_at=excluded.updated_at",
                    (_id(), rule["id"], day_value, exception_type, recipe_id, now, now),
                )
            assignment = "unplanned" if recipe_id is None else ("override" if rule else "fixed")
            connection.execute(
                "INSERT INTO meal_plan_entries(id,plan_date,recipe_id,assignment_type,recurrence_rule_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?) ON CONFLICT(plan_date) DO UPDATE SET recipe_id=excluded.recipe_id,"
                "assignment_type=excluded.assignment_type,recurrence_rule_id=excluded.recurrence_rule_id,updated_at=excluded.updated_at",
                (_id(), day_value, recipe_id, assignment, rule["id"] if rule else None, now, now),
            )

        await self.db.async_transaction(assign)
        return await self.async_planner_day(day)

    async def async_restore_recurrence(self, day_value: str) -> dict[str, Any]:
        day = date.fromisoformat(_date(day_value, "Planner date"))
        rules = await self.async_list_recurrences()
        rule = self._recurrence_for_date(day, rules)
        if not rule:
            raise DomainError("No recurring meal is configured for this date.")

        def restore(connection: sqlite3.Connection) -> None:
            connection.execute(
                "DELETE FROM recurrence_exceptions WHERE rule_id=? AND occurrence_date=?",
                (rule["id"], day_value),
            )
            connection.execute(
                "DELETE FROM meal_plan_entries WHERE plan_date=?",
                (day_value,),
            )

        await self.db.async_transaction(restore)
        return await self.async_planner_day(day)

    async def async_planner_day(self, day: date) -> dict[str, Any]:
        day_key = day.isoformat()
        entry = await self.db.async_fetch_one(
            "SELECT e.*,r.recipe_id AS recurrence_recipe_id,r.id AS active_rule_id "
            "FROM meal_plan_entries e LEFT JOIN meal_recurrence_rules r ON r.id=e.recurrence_rule_id "
            "WHERE e.plan_date=?",
            (day_key,),
        )
        rules = await self.async_list_recurrences()
        rule = self._recurrence_for_date(day, rules)
        exception = (
            await self.db.async_fetch_one(
                "SELECT * FROM recurrence_exceptions WHERE rule_id=? AND occurrence_date=?",
                (rule["id"], day_key),
            )
            if rule
            else None
        )
        if exception:
            recipe_id = exception["replacement_recipe_id"]
            assignment = "override" if recipe_id else "unplanned"
        elif rule:
            recipe_id, assignment = rule["recipe_id"], "recurring"
        elif entry:
            recipe_id, assignment = entry["recipe_id"], entry["assignment_type"]
        else:
            recipe_id, assignment = None, "unplanned"
        recipe = (
            await self.db.async_fetch_one(
                "SELECT id,name,effort,preparation_minutes,cooking_minutes FROM recipes WHERE id=?",
                (recipe_id,),
            )
            if recipe_id
            else None
        )
        availability = await self.async_recipe_availability(recipe_id) if recipe_id else None
        return {
            "date": day_key,
            "weekday": day.weekday(),
            "recipe_id": recipe_id,
            "recipe_name": recipe["name"] if recipe else None,
            "assignment_type": assignment,
            "recurrence_rule_id": rule["id"] if rule else None,
            "recurring_recipe_id": rule["recipe_id"] if rule else None,
            "recipe": recipe,
            "availability": availability,
        }

    async def async_get_planner(
        self, *, today: date | None = None, weeks: int = 4
    ) -> dict[str, Any]:
        current = today or date.today()
        if not 1 <= weeks <= 12:
            raise DomainError("Planner view must include from 1 to 12 weeks.")
        start = current - timedelta(days=current.weekday())
        plan_weeks = []
        for week_index in range(weeks):
            week_start = start + timedelta(days=7 * week_index)
            days = [
                await self.async_planner_day(week_start + timedelta(days=offset))
                for offset in range(7)
            ]
            plan_weeks.append({"start_date": week_start.isoformat(), "days": days})
        return {
            "start_date": start.isoformat(),
            "weeks": plan_weeks,
            "weekdays": list(range(7)),
        }

    async def async_eligible_recipes(
        self, day: date, *, automatic: bool = True
    ) -> list[dict[str, Any]]:
        settings = await self.async_get_settings() if automatic else {}
        rows = await self.db.async_fetch_all(
            "SELECT m.* FROM recipes m JOIN recipe_weekdays w ON w.recipe_id=m.id "
            "WHERE m.active=1 AND w.weekday=? ORDER BY m.name COLLATE NOCASE",
            (day.weekday(),),
        )
        result = []
        effort_order = {"low": 0, "medium": 1, "high": 2}
        for recipe in rows:
            if recipe["effort"] not in effort_order or recipe["cooking_minutes"] is None:
                continue
            max_effort = settings.get("planner_max_effort")
            if max_effort and (
                effort_order[recipe["effort"]] > effort_order[max_effort]
            ):
                continue
            max_minutes = settings.get("planner_max_cooking_minutes")
            total_minutes = (recipe["preparation_minutes"] or 0) + (recipe["cooking_minutes"] or 0)
            if max_minutes is not None and total_minutes > max_minutes:
                continue
            result.append(recipe)
        return result

    async def async_suggest_meals(
        self, *, today: date | None = None, seed: int | None = None
    ) -> dict[str, Any]:
        """Regenerate random entries and fill unplanned future dates."""
        current = today or date.today()
        first = current - timedelta(days=current.weekday())
        rng = random.Random(seed)
        changed_dates: list[str] = []
        unavailable_dates: list[str] = []
        unchanged_random_count = 0
        preserved_fixed_count = 0
        preserved_recurring_count = 0
        settings = await self.async_get_settings()
        window = settings["repetition_window_days"]
        usage: defaultdict[str, int] = defaultdict(int)
        assignments: dict[str, str] = {}
        for offset in range(DEFAULT_PLAN_DAYS):
            day = first + timedelta(days=offset)
            if day >= current:
                continue
            prior_day = await self.async_planner_day(day)
            if prior_day["recipe_id"]:
                assignments[day.isoformat()] = prior_day["recipe_id"]
        for offset in range(DEFAULT_PLAN_DAYS):
            day = first + timedelta(days=offset)
            if day < current:
                continue
            planned = await self.async_planner_day(day)
            if (
                planned["assignment_type"] in ("fixed", "override", "recurring")
                and planned["recipe_id"]
            ):
                assignments[day.isoformat()] = planned["recipe_id"]
                usage[planned["recipe_id"]] += 1
        for offset in range(DEFAULT_PLAN_DAYS):
            day = first + timedelta(days=offset)
            if day < current:
                continue
            entry = await self.db.async_fetch_one(
                "SELECT * FROM meal_plan_entries WHERE plan_date=?",
                (day.isoformat(),),
            )
            resolved = await self.async_planner_day(day)
            if resolved["assignment_type"] in ("fixed", "override"):
                preserved_fixed_count += 1
                if resolved["recipe_id"]:
                    assignments[day.isoformat()] = resolved["recipe_id"]
                continue
            if resolved["assignment_type"] == "recurring":
                preserved_recurring_count += 1
                assignments[day.isoformat()] = resolved["recipe_id"]
                continue
            # Explicitly skipped recurrence occurrences are unplanned but must
            # not be filled by the suggestion engine.
            if resolved["recurrence_rule_id"] and entry and entry["assignment_type"] == "unplanned":
                continue
            previous_id = (
                entry["recipe_id"] if entry and entry["assignment_type"] == "random" else None
            )
            candidates = await self.async_eligible_recipes(day)
            if not candidates:
                unavailable_dates.append(day.isoformat())
                if previous_id:
                    await self.db.async_execute(
                        "DELETE FROM meal_plan_entries WHERE plan_date=? AND assignment_type='random'",
                        (day.isoformat(),),
                    )
                continue
            recent = {
                recipe_id
                for old_day, recipe_id in assignments.items()
                if (day - date.fromisoformat(old_day)).days <= window
                and (day - date.fromisoformat(old_day)).days >= 0
            }
            candidates_outside_history = [
                candidate for candidate in candidates if candidate["id"] not in recent
            ]
            pool = candidates_outside_history or candidates
            previous_day_id = assignments.get((day - timedelta(days=1)).isoformat())
            if previous_day_id and len(pool) > 1:
                alternatives = [
                    candidate for candidate in pool if candidate["id"] != previous_day_id
                ]
                if alternatives:
                    pool = alternatives
            least_used = min(usage[candidate["id"]] for candidate in pool)
            pool = [candidate for candidate in pool if usage[candidate["id"]] == least_used]
            if previous_id and len(pool) > 1:
                other = [candidate for candidate in pool if candidate["id"] != previous_id]
                if other:
                    pool = other
            selected = rng.choice(pool)
            if previous_id == selected["id"]:
                unchanged_random_count += 1
                usage[selected["id"]] += 1
                assignments[day.isoformat()] = selected["id"]
                continue
            now = _now()
            await self.db.async_execute(
                "INSERT INTO meal_plan_entries(id,plan_date,recipe_id,assignment_type,created_at,updated_at) "
                "VALUES (?,?,?,'random',?,?) ON CONFLICT(plan_date) DO UPDATE SET recipe_id=excluded.recipe_id,"
                "assignment_type='random',recurrence_rule_id=NULL,updated_at=excluded.updated_at",
                (_id(), day.isoformat(), selected["id"], now, now),
            )
            changed_dates.append(day.isoformat())
            assignments[day.isoformat()] = selected["id"]
            usage[selected["id"]] += 1
        return {
            **(await self.async_get_planner(today=current)),
            "changed_dates": changed_dates,
            "unavailable_dates": unavailable_dates,
            "unchanged_random_count": unchanged_random_count,
            "preserved_fixed_count": preserved_fixed_count,
            "preserved_recurring_count": preserved_recurring_count,
            "changed": bool(changed_dates),
        }

    async def async_shuffle_meal(
        self, day_value: str, *, seed: int | None = None
    ) -> dict[str, Any]:
        day = date.fromisoformat(_date(day_value, "Planner date"))
        resolved = await self.async_planner_day(day)
        if resolved["recurrence_rule_id"]:
            raise DomainError("Select a meal manually to override this recurring occurrence.")
        candidates = await self.async_eligible_recipes(day)
        if not candidates:
            raise DomainError("There are no eligible meals for that date.")
        alternatives = [item for item in candidates if item["id"] != resolved["recipe_id"]]
        selected = random.Random(seed).choice(alternatives or candidates)
        now = _now()
        await self.db.async_execute(
            "INSERT INTO meal_plan_entries(id,plan_date,recipe_id,assignment_type,created_at,updated_at) "
            "VALUES (?,?,?,'random',?,?) ON CONFLICT(plan_date) DO UPDATE SET recipe_id=excluded.recipe_id,"
            "assignment_type='random',recurrence_rule_id=NULL,updated_at=excluded.updated_at",
            (_id(), day_value, selected["id"], now, now),
        )
        return await self.async_planner_day(day)

    async def async_add_shopping_item(
        self,
        *,
        product_id: str | None = None,
        requested_variant_id: str | None = None,
        custom_name: str | None = None,
        quantity: float | None = None,
        unit: str | None = None,
        source: str = "manual",
    ) -> dict[str, Any]:
        if source not in ("manual", "low_stock", "recipe"):
            raise DomainError("Choose a supported shopping item source.")
        if product_id:
            await self.async_product(product_id)
        if requested_variant_id:
            variant = await self.async_variant(requested_variant_id)
            if variant["product_id"] != product_id:
                raise DomainError("The requested variant must belong to the selected product.")
        if not product_id and not custom_name:
            raise DomainError("Choose a product or enter a custom item name.")
        amount = _positive(quantity, "Shopping quantity") if quantity is not None else None
        clean_unit = _text(unit, "shopping unit", maximum=40) if unit else None
        if (amount is None) != (clean_unit is None):
            raise DomainError("Enter both a shopping quantity and unit.")
        identifier, now = _id(), _now()
        try:
            await self.db.async_execute(
                "INSERT INTO shopping_items(id,product_id,requested_variant_id,custom_name,quantity,unit,source,status,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,'needed',?,?)",
                (
                    identifier,
                    product_id,
                    requested_variant_id,
                    _text(custom_name, "item name") if custom_name else None,
                    amount,
                    clean_unit,
                    source,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as err:
            raise DomainError(
                "An active low-stock suggestion already exists for that product."
            ) from err
        return await self.async_shopping_item(identifier)

    async def async_shopping_item(self, item_id: str) -> dict[str, Any]:
        item = await self.db.async_fetch_one(
            "SELECT s.*,p.name AS product_name,v.brand_name,v.variant_name "
            "FROM shopping_items s LEFT JOIN products p ON p.id=s.product_id "
            "LEFT JOIN product_variants v ON v.id=s.requested_variant_id WHERE s.id=?",
            (item_id,),
        )
        if not item:
            raise DomainError("That shopping item no longer exists.")
        return item

    async def async_list_shopping(
        self, *, status: str | None = None, search: str = ""
    ) -> list[dict[str, Any]]:
        if status and status not in ("needed", "purchased", "dismissed"):
            raise DomainError("Choose a valid shopping status.")
        query = (
            "SELECT s.*,p.name AS product_name,v.brand_name,v.variant_name "
            "FROM shopping_items s LEFT JOIN products p ON p.id=s.product_id "
            "LEFT JOIN product_variants v ON v.id=s.requested_variant_id WHERE 1=1"
        )
        params: list[Any] = []
        if status:
            query += " AND s.status=?"
            params.append(status)
        if search.strip():
            like = f"%{search.strip()}%"
            query += " AND (p.name LIKE ? COLLATE NOCASE OR s.custom_name LIKE ? COLLATE NOCASE OR v.brand_name LIKE ? COLLATE NOCASE)"
            params.extend((like, like, like))
        query += " ORDER BY CASE s.status WHEN 'needed' THEN 0 WHEN 'purchased' THEN 1 ELSE 2 END,s.created_at DESC"
        return await self.db.async_fetch_all(query, params)

    async def async_update_shopping_status(self, item_id: str, status: str) -> dict[str, Any]:
        if status not in ("needed", "purchased", "dismissed"):
            raise DomainError("Choose a valid shopping status.")
        changed = await self.db.async_execute(
            "UPDATE shopping_items SET status=?,updated_at=? WHERE id=?",
            (status, _now(), item_id),
        )
        if not changed:
            raise DomainError("That shopping item no longer exists.")
        return await self.async_shopping_item(item_id)

    async def async_delete_shopping_item(self, item_id: str) -> None:
        if not await self.db.async_execute("DELETE FROM shopping_items WHERE id=?", (item_id,)):
            raise DomainError("That shopping item no longer exists.")

    async def async_refresh_low_stock_suggestions(self) -> dict[str, Any]:
        products = await self.db.async_fetch_all(
            "SELECT p.id,p.reorder_level,COALESCE(SUM(b.quantity),0) AS stock "
            "FROM products p LEFT JOIN product_variants v ON v.product_id=p.id "
            "LEFT JOIN inventory_batches b ON b.variant_id=v.id "
            "WHERE p.active=1 AND p.reorder_level>0 GROUP BY p.id"
        )
        added = 0
        removed = 0
        for product in products:
            if product["stock"] <= product["reorder_level"]:
                now = _now()
                added += await self.db.async_execute(
                    "INSERT OR IGNORE INTO shopping_items(id,product_id,custom_name,source,status,created_at,updated_at) "
                    "VALUES (?,?,NULL,'low_stock','needed',?,?)",
                    (_id(), product["id"], now, now),
                )
            else:
                removed += await self.db.async_execute(
                    "UPDATE shopping_items SET status='dismissed',updated_at=? "
                    "WHERE product_id=? AND source='low_stock' AND status='needed'",
                    (_now(), product["id"]),
                )
        return {"added": added, "dismissed": removed}

    async def async_add_recipe_shopping_items(self, recipe_id: str) -> dict[str, Any]:
        availability = await self.async_recipe_availability(recipe_id)
        added: list[dict[str, Any]] = []
        for ingredient in availability["ingredients"]:
            if ingredient["available"]:
                continue
            existing = await self.db.async_fetch_one(
                "SELECT id FROM shopping_items WHERE product_id=? AND status='needed' AND source='recipe' "
                "AND requested_variant_id IS ?",
                (ingredient["product_id"], ingredient["required_variant_id"]),
            )
            if existing:
                continue
            added.append(
                await self.async_add_shopping_item(
                    product_id=ingredient["product_id"],
                    requested_variant_id=ingredient["required_variant_id"],
                    quantity=ingredient["required_quantity"],
                    unit=ingredient["required_unit"],
                    source="recipe",
                )
            )
        return {"added": added}

    async def async_dashboard_data(self, *, today: date | None = None) -> dict[str, Any]:
        current = today or date.today()
        today_meal = await self.async_planner_day(current)
        tomorrow_meal = await self.async_planner_day(current + timedelta(days=1))
        available: list[dict[str, Any]] = []
        for recipe in await self.async_list_recipes():
            if recipe["availability"]["status"] == "available":
                available.append(
                    {
                        "id": recipe["id"],
                        "name": recipe["name"],
                        "effort": recipe["effort"],
                        "preparation_minutes": recipe["preparation_minutes"],
                        "cooking_minutes": recipe["cooking_minutes"],
                    }
                )
        low_stock = await self.db.async_fetch_all(
            "SELECT p.id,p.name,p.reorder_level,p.stock_unit,COALESCE(SUM(b.quantity),0) AS quantity "
            "FROM products p LEFT JOIN product_variants v ON v.product_id=p.id "
            "LEFT JOIN inventory_batches b ON b.variant_id=v.id "
            "WHERE p.active=1 AND p.reorder_level>0 GROUP BY p.id "
            "HAVING quantity<=p.reorder_level ORDER BY p.name COLLATE NOCASE"
        )
        settings = await self.async_get_settings()
        expiry_until = (current + timedelta(days=settings["expiry_warning_days"])).isoformat()
        expiring = await self.db.async_fetch_all(
            "SELECT b.id,b.variant_id,p.id AS product_id,p.name AS product_name,v.brand_name,"
            "b.quantity,p.stock_unit,b.location_id,l.name AS location_name,b.best_before_date,b.use_by_date "
            "FROM inventory_batches b JOIN product_variants v ON v.id=b.variant_id "
            "JOIN products p ON p.id=v.product_id LEFT JOIN storage_locations l ON l.id=b.location_id "
            "WHERE b.quantity>0 AND COALESCE(b.use_by_date,b.best_before_date) IS NOT NULL "
            "AND COALESCE(b.use_by_date,b.best_before_date)<=? ORDER BY COALESCE(b.use_by_date,b.best_before_date)",
            (expiry_until,),
        )
        needed = await self.db.async_fetch_all(
            "SELECT * FROM shopping_items WHERE status='needed' ORDER BY created_at"
        )
        products = await self.db.async_fetch_one(
            "SELECT COUNT(*) AS count FROM products WHERE active=1"
        )
        planner = await self.async_get_planner(today=current)
        assigned_count = sum(
            day["recipe_id"] is not None for week in planner["weeks"] for day in week["days"]
        )
        return {
            "today": today_meal,
            "tomorrow": tomorrow_meal,
            "available_recipes": available,
            "low_stock": low_stock,
            "shopping": needed,
            "expiring": expiring,
            "inventory_product_count": products["count"],
            "planned_meal_count": assigned_count,
            "schema_version": await self.db.async_status(),
        }

    async def async_barcode_cache_get(
        self, barcode: str, *, max_age_days: int = 30
    ) -> dict[str, Any] | None:
        code = _text(barcode, "barcode", maximum=80)
        if not code.isdecimal():
            raise DomainError("Barcode must contain digits only.")
        row = await self.db.async_fetch_one(
            "SELECT response_json,fetched_at FROM barcode_lookup_cache WHERE barcode=?",
            (code,),
        )
        if not row:
            return None
        fetched_at = datetime.fromisoformat(row["fetched_at"])
        if datetime.now(UTC) - fetched_at > timedelta(days=max_age_days):
            return None
        return json.loads(row["response_json"])

    async def async_barcode_cache_set(self, barcode: str, details: dict[str, Any]) -> None:
        code = _text(barcode, "barcode", maximum=80)
        if not code.isdecimal():
            raise DomainError("Barcode must contain digits only.")
        await self.db.async_execute(
            "INSERT INTO barcode_lookup_cache(barcode,response_json,fetched_at) VALUES (?,?,?) "
            "ON CONFLICT(barcode) DO UPDATE SET response_json=excluded.response_json,fetched_at=excluded.fetched_at",
            (code, json.dumps(details), _now()),
        )
