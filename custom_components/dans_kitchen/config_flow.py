"""UI configuration and options flows."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN, NAME


class DansKitchenConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Create the single local Dan's Kitchen instance."""

    VERSION = 1

    async def async_step_user(self, _user_input: dict[str, Any] | None = None) -> FlowResult:
        self._async_abort_entries_match({})
        return self.async_create_entry(title=NAME, data={})

    @staticmethod
    def async_get_options_flow(config_entry: config_entries.ConfigEntry) -> DansKitchenOptionsFlow:
        return DansKitchenOptionsFlow(config_entry)


class DansKitchenOptionsFlow(config_entries.OptionsFlow):
    """Configure preferences applied to the live local database."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        schema = vol.Schema(
            {
                vol.Required(
                    "expiry_warning_days",
                    default=self._entry.options.get("expiry_warning_days", 5),
                ): vol.All(vol.Coerce(int), vol.Range(min=0, max=365)),
                vol.Required(
                    "external_lookup_enabled",
                    default=self._entry.options.get("external_lookup_enabled", True),
                ): bool,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)


async def async_migrate_entry(_hass: HomeAssistant, entry: config_entries.ConfigEntry) -> bool:
    """Accept the initial configuration schema without data loss."""
    if entry.version > 1:
        return False
    if entry.version < 1:
        entry.version = 1
    return True
