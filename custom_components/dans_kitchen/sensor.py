"""Compact summary sensors for Dan's Kitchen."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import (
    SensorEntity,
    SensorEntityDescription,
    SensorStateClass,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import KitchenConfigEntry, RuntimeData
from .const import DOMAIN, NAME


@dataclass(frozen=True, kw_only=True)
class KitchenSensorDescription(SensorEntityDescription):
    """Map a dashboard sensor to a bounded coordinator summary."""

    value_key: str
    attribute_key: str | None = None


SENSORS: tuple[KitchenSensorDescription, ...] = (
    KitchenSensorDescription(
        key="todays_meal",
        name="Today's Meal",
        icon="mdi:silverware-fork-knife",
        value_key="today",
        attribute_key="today",
    ),
    KitchenSensorDescription(
        key="tomorrows_meal",
        name="Tomorrow's Meal",
        icon="mdi:calendar-arrow-right",
        value_key="tomorrow",
        attribute_key="tomorrow",
    ),
    KitchenSensorDescription(
        key="available_meals",
        name="Available Meals",
        icon="mdi:chef-hat",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="available_recipes",
    ),
    KitchenSensorDescription(
        key="low_stock_products",
        name="Low Stock Products",
        icon="mdi:cart-alert",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="low_stock",
    ),
    KitchenSensorDescription(
        key="shopping_list",
        name="Shopping List",
        icon="mdi:cart",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="shopping",
    ),
    KitchenSensorDescription(
        key="expiring_items",
        name="Expiring Items",
        icon="mdi:calendar-alert",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="expiring",
    ),
    KitchenSensorDescription(
        key="inventory_products",
        name="Inventory Products",
        icon="mdi:package-variant",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="inventory_product_count",
    ),
    KitchenSensorDescription(
        key="meals_planned",
        name="Meals Planned",
        icon="mdi:calendar-check",
        state_class=SensorStateClass.MEASUREMENT,
        value_key="planned_meal_count",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: KitchenConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create the summary entities."""
    runtime = entry.runtime_data
    async_add_entities(KitchenSummarySensor(runtime, entry, description) for description in SENSORS)


class KitchenSummarySensor(CoordinatorEntity[dict[str, Any]], SensorEntity):
    """Expose one summary from the shared database-backed coordinator."""

    entity_description: KitchenSensorDescription

    def __init__(
        self,
        runtime: RuntimeData,
        entry: KitchenConfigEntry,
        description: KitchenSensorDescription,
    ) -> None:
        super().__init__(runtime.coordinator)
        self.entity_description = description
        self._runtime = runtime
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=NAME,
            manufacturer="Dan's Kitchen",
            model="Household food manager",
            sw_version="0.1.0",
        )

    @property
    def native_value(self) -> str | int:
        value: Any = self.coordinator.data[self.entity_description.value_key]
        if self.entity_description.key in ("todays_meal", "tomorrows_meal"):
            return value["recipe_name"] or "Unplanned"
        return len(value) if isinstance(value, list) else value

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        description = self.entity_description
        if description.key == "todays_meal":
            meal = self.coordinator.data["today"]
            return self._meal_attributes(meal)
        if description.key == "tomorrows_meal":
            return self._meal_attributes(self.coordinator.data["tomorrow"])
        if description.key == "available_meals":
            return {
                "recipe_ids": [
                    recipe["id"] for recipe in self.coordinator.data["available_recipes"][:50]
                ],
                "recipes": self.coordinator.data["available_recipes"][:50],
            }
        if description.key == "low_stock_products":
            return {"products": self.coordinator.data["low_stock"][:50]}
        if description.key == "shopping_list":
            return {"items": self.coordinator.data["shopping"][:50]}
        if description.key == "expiring_items":
            return {"batches": self.coordinator.data["expiring"][:50]}
        if description.key == "inventory_products":
            return {"schema_version": self.coordinator.data["schema_version"]["schema_version"]}
        return {}

    @staticmethod
    def _meal_attributes(meal: dict[str, Any]) -> dict[str, Any]:
        recipe = meal.get("recipe") or {}
        return {
            "recipe_id": meal["recipe_id"],
            "effort": recipe.get("effort"),
            "preparation_minutes": recipe.get("preparation_minutes"),
            "cooking_minutes": recipe.get("cooking_minutes"),
            "assignment_type": meal["assignment_type"],
            "missing_ingredient_count": (meal.get("availability") or {}).get("missing_count"),
            "date": meal["date"],
        }
