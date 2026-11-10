"""Allow testing the standalone domain service without Home Assistant installed."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

if importlib.util.find_spec("homeassistant") is None:
    package_name = "custom_components.dans_kitchen"
    package = types.ModuleType(package_name)
    package.__path__ = [str(Path(__file__).parents[1] / "custom_components" / "dans_kitchen")]
    sys.modules[package_name] = package
