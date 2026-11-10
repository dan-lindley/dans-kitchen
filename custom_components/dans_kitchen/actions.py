"""Home Assistant actions backed by the same domain service as the panel."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .services import DomainError

_NUMBER = vol.All(vol.Coerce(float), vol.Range(min=0))


def async_register_actions(hass: HomeAssistant) -> None:
    """Register documented automation actions once per Home Assistant."""
    registry = hass.data.setdefault(DOMAIN, {})
    if registry.get("actions_registered"):
        return
    registry["actions_registered"] = True

    schemas: dict[str, vol.Schema] = {
        "add_product": vol.Schema(
            {
                vol.Required("name"): cv.string,
                vol.Required("stock_unit"): cv.string,
                vol.Optional("description"): cv.string,
                vol.Optional("reorder_level", default=0): _NUMBER,
                vol.Optional("default_location_id"): cv.string,
            }
        ),
        "add_stock": vol.Schema(
            {
                vol.Required("variant_id"): cv.string,
                vol.Required("quantity"): vol.All(_NUMBER, vol.Range(min=0.0000001)),
                vol.Optional("location_id"): cv.string,
                vol.Optional("best_before_date"): cv.string,
                vol.Optional("use_by_date"): cv.string,
                vol.Optional("reason"): cv.string,
                vol.Optional("request_key"): cv.string,
            }
        ),
        "use_stock": vol.Schema(
            {
                vol.Required("product_id"): cv.string,
                vol.Required("quantity"): vol.All(_NUMBER, vol.Range(min=0.0000001)),
                vol.Optional("variant_id"): cv.string,
                vol.Optional("batch_id"): cv.string,
                vol.Optional("reason"): cv.string,
                vol.Optional("request_key"): cv.string,
            }
        ),
        "correct_stock": vol.Schema(
            {
                vol.Required("batch_id"): cv.string,
                vol.Required("quantity"): _NUMBER,
                vol.Optional("reason"): cv.string,
                vol.Optional("request_key"): cv.string,
            }
        ),
        "add_shopping_item": vol.Schema(
            {
                vol.Optional("product_id"): cv.string,
                vol.Optional("requested_variant_id"): cv.string,
                vol.Optional("custom_name"): cv.string,
                vol.Optional("quantity"): _NUMBER,
                vol.Optional("unit"): cv.string,
            }
        ),
        "complete_shopping_item": vol.Schema(
            {
                vol.Required("item_id"): cv.string,
                vol.Optional("variant_id"): cv.string,
                vol.Optional("quantity"): _NUMBER,
                vol.Optional("location_id"): cv.string,
                vol.Optional("best_before_date"): cv.string,
            }
        ),
        "plan_meal": vol.Schema(
            {
                vol.Required("plan_date"): cv.string,
                vol.Optional("recipe_id"): cv.string,
                vol.Optional("allow_ineligible", default=False): cv.boolean,
            }
        ),
        "shuffle_meal": vol.Schema({vol.Required("plan_date"): cv.date}),
        "suggest_meals": vol.Schema({}),
    }

    for action, schema in schemas.items():
        hass.services.async_register(
            DOMAIN,
            action,
            _make_handler(action),
            schema=schema,
            supports_response=SupportsResponse.ONLY,
        )


def _make_handler(
    action: str,
) -> Callable[[ServiceCall], Coroutine[Any, Any, dict[str, Any]]]:
    async def handle(call: ServiceCall) -> dict[str, Any]:
        runtime = call.hass.data.get(DOMAIN, {}).get("runtime")
        if runtime is None:
            raise ServiceValidationError("Dan's Kitchen is not loaded.")
        values = dict(call.data)
        try:
            if action == "add_product":
                result = await runtime.service.async_create_product(**values)
            elif action == "add_stock":
                result = await runtime.service.async_add_stock(**values)
            elif action == "use_stock":
                result = await runtime.service.async_use_stock(**values)
            elif action == "correct_stock":
                result = await runtime.service.async_correct_stock(**values)
            elif action == "add_shopping_item":
                result = await runtime.service.async_add_shopping_item(**values)
            elif action == "complete_shopping_item":
                result = await _complete_shopping(runtime.service, values)
            elif action == "plan_meal":
                plan_date = values.pop("plan_date")
                result = await runtime.service.async_plan_meal(
                    plan_date,
                    values.pop("recipe_id", None),
                    **values,
                )
            elif action == "shuffle_meal":
                result = await runtime.service.async_shuffle_meal(values["plan_date"].isoformat())
            else:
                result = await runtime.service.async_suggest_meals()
            await runtime.coordinator.async_request_refresh()
            return result
        except DomainError as err:
            raise ServiceValidationError(str(err)) from err

    return handle


async def _complete_shopping(service: Any, values: dict[str, Any]) -> dict[str, Any]:
    item = await service.async_shopping_item(values["item_id"])
    if values.get("variant_id") and values.get("quantity"):
        await service.async_add_stock(
            values["variant_id"],
            values["quantity"],
            location_id=values.get("location_id"),
            best_before_date=values.get("best_before_date"),
            reason="Purchased from shopping list",
        )
    return await service.async_update_shopping_status(item["id"], "purchased")
