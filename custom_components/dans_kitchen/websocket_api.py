"""Authenticated Home Assistant WebSocket API for the household panel."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import quote

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN
from .services import DomainError

_BARCODE = re.compile(r"^[0-9]{8,14}$")


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register one versioned command endpoint for panel interactions."""

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/command",
            vol.Required("command"): cv.string,
            vol.Optional("data", default={}): dict,
        }
    )
    @websocket_api.async_response
    async def handle_command(
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg: dict[str, Any],
    ) -> None:
        runtime = hass.data.get(DOMAIN, {}).get("runtime")
        if runtime is None:
            connection.send_error(msg["id"], "not_loaded", "Dan's Kitchen is not loaded.")
            return
        command = msg["command"]
        data = msg["data"]
        try:
            result = await _dispatch(hass, runtime, command, data)
            if command in _MUTATING_COMMANDS:
                await runtime.coordinator.async_request_refresh()
            connection.send_result(msg["id"], result)
        except DomainError as err:
            connection.send_error(msg["id"], "invalid_request", str(err))
        except (ValueError, KeyError) as err:
            connection.send_error(msg["id"], "invalid_request", str(err))
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "operation_failed", str(err))

    websocket_api.async_register_command(hass, handle_command)


_MUTATING_COMMANDS = {
    "location/create",
    "location/update",
    "location/move",
    "location/delete",
    "product/create",
    "product/update",
    "variant/create",
    "variant/update",
    "stock/add",
    "stock/use",
    "stock/correct",
    "stock/transfer",
    "recipe/create",
    "recipe/update",
    "recipe/archive",
    "recipe/duplicate",
    "planner/plan",
    "planner/suggest",
    "planner/shuffle",
    "planner/restore_recurrence",
    "recurrence/set",
    "recurrence/delete",
    "shopping/add",
    "shopping/status",
    "shopping/complete",
    "shopping/delete",
    "shopping/refresh_low_stock",
    "shopping/add_recipe",
    "settings/set",
    "barcode/register",
    "data/restore",
}


async def _dispatch(hass: HomeAssistant, runtime: Any, command: str, data: dict[str, Any]) -> Any:
    service = runtime.service
    if command == "get_data":
        today = date.today()
        return {
            "inventory": await service.async_list_inventory(),
            "recipes": await service.async_list_recipes(),
            "planner": await service.async_get_planner(today=today),
            "shopping": await service.async_list_shopping(),
            "locations": await service.async_list_locations(),
            "recurrences": await service.async_list_recurrences(),
            "settings": await service.async_get_settings(),
            "dashboard": await service.async_dashboard_data(today=today),
            "database": await runtime.database.async_status(),
        }
    if command == "location/create":
        return await service.async_create_location(**data)
    if command == "location/update":
        location_id = data.pop("location_id")
        return await service.async_update_location(location_id, **data)
    if command == "location/delete":
        await service.async_delete_location(data["location_id"])
        return {"deleted": True}
    if command == "location/move":
        await service.async_reorder_location(data["location_id"], data["direction"])
        return {"moved": True}
    if command == "product/detail":
        return await service.async_product_detail(data["product_id"])
    if command == "product/create":
        return await service.async_create_product(**data)
    if command == "product/update":
        product_id = data.pop("product_id")
        return await service.async_update_product(product_id, **data)
    if command == "variant/create":
        product_id = data.pop("product_id")
        return await service.async_create_variant(product_id, **data)
    if command == "variant/update":
        variant_id = data.pop("variant_id")
        return await service.async_update_variant(variant_id, **data)
    if command == "stock/add":
        variant_id = data.pop("variant_id")
        return await service.async_add_stock(variant_id, **data)
    if command == "stock/use":
        product_id = data.pop("product_id")
        return await service.async_use_stock(product_id, **data)
    if command == "stock/correct":
        batch_id = data.pop("batch_id")
        return await service.async_correct_stock(batch_id, **data)
    if command == "stock/transfer":
        batch_id = data.pop("batch_id")
        return await service.async_transfer_stock(batch_id, **data)
    if command == "stock/history":
        return await service.async_transactions(**data)
    if command == "recipe/create":
        return await service.async_create_recipe(**data)
    if command == "recipe/update":
        recipe_id = data.pop("recipe_id")
        return await service.async_update_recipe(recipe_id, **data)
    if command == "recipe/archive":
        await service.async_archive_recipe(data["recipe_id"])
        return {"archived": True}
    if command == "recipe/duplicate":
        return await service.async_duplicate_recipe(data["recipe_id"], data.get("name"))
    if command == "planner/get":
        return await service.async_get_planner(
            today=date.fromisoformat(data["today"]) if data.get("today") else None,
            weeks=data.get("weeks", 4),
        )
    if command == "planner/eligible":
        day = date.fromisoformat(data["date"])
        return await service.async_eligible_recipes(day, automatic=False)
    if command == "planner/plan":
        return await service.async_plan_meal(
            data["date"],
            data.get("recipe_id"),
            allow_ineligible=data.get("allow_ineligible", False),
        )
    if command == "planner/suggest":
        return await service.async_suggest_meals(seed=data.get("seed"))
    if command == "planner/shuffle":
        return await service.async_shuffle_meal(data["date"], seed=data.get("seed"))
    if command == "planner/restore_recurrence":
        return await service.async_restore_recurrence(data["date"])
    if command == "recurrence/set":
        return await service.async_set_recurrence(
            data["recipe_id"],
            weekday=data["weekday"],
            anchor_date=data["anchor_date"],
            interval_weeks=data["interval_weeks"],
        )
    if command == "recurrence/delete":
        await service.async_remove_recurrence(data["rule_id"])
        return {"deleted": True}
    if command == "shopping/add":
        return await service.async_add_shopping_item(**data)
    if command == "shopping/list":
        return await service.async_list_shopping(**data)
    if command == "shopping/status":
        return await service.async_update_shopping_status(data["item_id"], data["status"])
    if command == "shopping/complete":
        item = await service.async_shopping_item(data["item_id"])
        if data.get("variant_id"):
            variant = await service.async_variant(data["variant_id"])
            if variant["product_id"] != item["product_id"]:
                raise DomainError("Choose a variant belonging to this shopping product.")
            if not data.get("quantity"):
                raise DomainError("Enter the quantity to add to inventory.")
            await service.async_add_stock(
                data["variant_id"],
                data["quantity"],
                location_id=data.get("location_id"),
                best_before_date=data.get("best_before_date"),
                reason="Purchased from shopping list",
                request_key=data.get("request_key"),
            )
        return await service.async_update_shopping_status(data["item_id"], "purchased")
    if command == "shopping/delete":
        await service.async_delete_shopping_item(data["item_id"])
        return {"deleted": True}
    if command == "shopping/refresh_low_stock":
        return await service.async_refresh_low_stock_suggestions()
    if command == "shopping/add_recipe":
        return await service.async_add_recipe_shopping_items(data["recipe_id"])
    if command == "settings/set":
        return await service.async_set_setting(data["key"], data.get("value"))
    if command == "barcode/lookup":
        return await _lookup_barcode(hass, service, data["barcode"])
    if command == "barcode/register":
        return await _register_barcode(service, data)
    if command == "data/export_json":
        return await runtime.database.async_export_json()
    if command == "data/export_csv":
        return {
            "filename": f"{data['table']}.csv",
            "content": await runtime.database.async_export_csv(data["table"]),
        }
    if command == "data/backup":
        backup_dir = Path(hass.config.path(DOMAIN, "backups"))
        filename = f"backup-{date.today().isoformat()}-{uuid.uuid4().hex[:8]}.sqlite3"
        await runtime.database.async_backup(backup_dir / filename)
        return {"filename": filename}
    if command == "data/list_backups":
        backup_dir = Path(hass.config.path(DOMAIN, "backups"))
        return {
            "backups": sorted(
                file.name for file in backup_dir.glob("backup-*.sqlite3") if file.is_file()
            )
        }
    if command == "data/restore":
        filename = data.get("filename")
        if (
            not isinstance(filename, str)
            or Path(filename).name != filename
            or not filename.startswith("backup-")
            or not filename.endswith(".sqlite3")
        ):
            raise DomainError("Select a valid Dan's Kitchen backup.")
        backup = Path(hass.config.path(DOMAIN, "backups")) / filename
        await runtime.database.async_restore(backup)
        return {"restored": True}
    raise DomainError(f"Unknown Dan's Kitchen command: {command}")


async def _lookup_barcode(hass: HomeAssistant, service: Any, barcode: str) -> dict[str, Any]:
    code = str(barcode).strip()
    if not _BARCODE.fullmatch(code):
        raise DomainError("Enter a valid EAN/UPC barcode of 8 to 14 digits.")
    local = await service.async_find_barcode(code)
    if local:
        return {"matched": True, "source": "local", "variant": local}
    settings = await service.async_get_settings()
    if not settings["external_lookup_enabled"]:
        return {"matched": False, "source": "disabled", "product": None}
    cached = await service.async_barcode_cache_get(code)
    if cached:
        return {"matched": False, "source": "cache", "product": cached}
    session = async_get_clientsession(hass)
    url = f"https://world.openfoodfacts.org/api/v2/product/{quote(code)}.json?fields=product_name,brands,quantity,image_url"
    try:
        async with asyncio.timeout(10):
            async with session.get(
                url,
                headers={"User-Agent": "DansKitchen/0.1.0 (Home Assistant custom integration)"},
            ) as response:
                if response.status != 200:
                    raise DomainError("Open Food Facts is temporarily unavailable.")
                payload = await response.json(content_type=None)
    except (TimeoutError, OSError, json.JSONDecodeError) as err:
        raise DomainError(
            "Open Food Facts could not be reached. You can still add the product manually."
        ) from err
    if not isinstance(payload, dict) or payload.get("status") != 1:
        return {"matched": False, "source": "open_food_facts", "product": None}
    source = payload.get("product") or {}
    product_name = source.get("product_name")
    if not isinstance(product_name, str) or not product_name.strip():
        return {"matched": False, "source": "open_food_facts", "product": None}
    brand = source.get("brands")
    image_url = source.get("image_url")
    product = {
        "name": product_name.strip()[:200],
        "brand_name": (
            brand.split(",")[0].strip()[:100] if isinstance(brand, str) and brand.strip() else None
        ),
        "barcode": code,
        "package_description": source.get("quantity"),
        "image_url": image_url
        if isinstance(image_url, str) and image_url.startswith("https://")
        else None,
        "external_source": "open_food_facts",
        "external_source_id": code,
    }
    package_description = product["package_description"]
    if isinstance(package_description, str):
        size_match = re.fullmatch(
            r"\s*(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|cl)\s*",
            package_description,
            flags=re.IGNORECASE,
        )
        if size_match:
            product["package_size"] = float(size_match.group(1).replace(",", "."))
            product["package_unit"] = size_match.group(2).lower()
    await service.async_barcode_cache_set(code, product)
    return {"matched": False, "source": "open_food_facts", "product": product}


async def _register_barcode(service: Any, data: dict[str, Any]) -> dict[str, Any]:
    existing = await service.async_find_barcode(data["barcode"])
    if existing:
        stock = await service.async_add_stock(
            existing["id"],
            data.get("quantity", 1),
            location_id=data.get("location_id"),
            best_before_date=data.get("best_before_date"),
            use_by_date=data.get("use_by_date"),
            reason="Barcode scan",
            request_key=data.get("request_key"),
        )
        return {"matched": True, "variant": existing, "stock": stock}
    return await service.async_register_barcode_product(**data)
