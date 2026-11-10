"""Dan's Kitchen Home Assistant integration."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .actions import async_register_actions
from .const import DATABASE_FILENAME, DOMAIN, FRONTEND_DIR
from .database import Database
from .panel import async_register_panel, async_remove_panel
from .services import KitchenService
from .websocket_api import async_register_websocket_commands

PLATFORMS = (Platform.SENSOR,)


@dataclass(slots=True)
class RuntimeData:
    """Resources shared by platforms, actions, and the panel."""

    database: Database
    service: KitchenService
    coordinator: DataUpdateCoordinator[dict[str, Any]]


KitchenConfigEntry = ConfigEntry[RuntimeData]


async def async_setup(hass: HomeAssistant, _config: dict[str, Any]) -> bool:
    """Register actions and authenticated WebSocket commands."""
    async_register_actions(hass)
    async_register_websocket_commands(hass)
    hass.data.setdefault(DOMAIN, {})
    return True


async def async_setup_entry(hass: HomeAssistant, entry: KitchenConfigEntry) -> None:
    """Initialize SQL persistence, services, sensors, and the panel."""
    database_path = Path(hass.config.path(DOMAIN, DATABASE_FILENAME))
    database = Database(database_path)
    await database.async_initialize()
    service = KitchenService(database)

    settings = await service.async_get_settings()
    for key, default in (
        (
            "expiry_warning_days",
            entry.options.get("expiry_warning_days", settings["expiry_warning_days"]),
        ),
        (
            "external_lookup_enabled",
            entry.options.get("external_lookup_enabled", settings["external_lookup_enabled"]),
        ),
    ):
        existing = await database.async_fetch_one(
            "SELECT key FROM app_settings WHERE key=?", (key,)
        )
        if existing is None:
            await service.async_set_setting(key, default)

    async def async_update_data() -> dict[str, Any]:
        return await service.async_dashboard_data()

    coordinator = DataUpdateCoordinator(
        hass,
        logger=logging.getLogger(__name__),
        name="Dan's Kitchen",
        update_method=async_update_data,
        update_interval=timedelta(minutes=2),
    )
    await coordinator.async_config_entry_first_refresh()
    runtime = RuntimeData(database, service, coordinator)
    entry.runtime_data = runtime
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = runtime
    hass.data[DOMAIN]["runtime"] = runtime

    await async_register_panel(hass, FRONTEND_DIR)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))


async def _async_options_updated(hass: HomeAssistant, entry: KitchenConfigEntry) -> None:
    runtime = entry.runtime_data
    for setting in ("expiry_warning_days", "external_lookup_enabled"):
        if setting in entry.options:
            await runtime.service.async_set_setting(setting, entry.options[setting])
    await runtime.coordinator.async_request_refresh()


async def async_unload_entry(hass: HomeAssistant, entry: KitchenConfigEntry) -> bool:
    """Unload platforms and unregister the panel."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    hass.data.get(DOMAIN, {}).pop("runtime", None)
    await async_remove_panel(hass)
    return True
