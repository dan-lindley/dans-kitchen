"""Integration constants."""

from pathlib import Path

DOMAIN = "dans_kitchen"
NAME = "Dan's Kitchen"
VERSION = "0.2.5"
DATABASE_FILENAME = "dans_kitchen.sqlite3"
DATABASE_SCHEMA_VERSION = 2
FRONTEND_DIR = Path(__file__).parent / "frontend" / "dist"
DEFAULT_EXPIRY_WARNING_DAYS = 5
DEFAULT_PLAN_DAYS = 28
STOCK_TRANSACTION_TYPES = {
    "add",
    "use",
    "correct",
    "discard",
    "transfer_in",
    "transfer_out",
}
