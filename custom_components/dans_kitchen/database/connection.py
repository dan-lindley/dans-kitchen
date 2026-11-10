"""Asynchronous SQLite access, schema migrations, and safe backup operations."""

from __future__ import annotations

import asyncio
import csv
import os
import sqlite3
import uuid
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path
from typing import Any, TypeVar

from ..const import DATABASE_SCHEMA_VERSION

_Result = TypeVar("_Result")
_Operation = Callable[[sqlite3.Connection], _Result]


class DatabaseError(RuntimeError):
    """Raised when the database cannot safely perform an operation."""


class Database:
    """Owns the authoritative household database and serializes transactions."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._lock = asyncio.Lock()
        self._ready = False

    async def async_initialize(self) -> None:
        """Create or migrate the database without blocking Home Assistant."""
        async with self._lock:
            await asyncio.to_thread(self._initialize_sync)

    def _connect(self, path: Path | None = None) -> sqlite3.Connection:
        connection = sqlite3.connect(path or self.path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 30000")
        connection.execute("PRAGMA synchronous = FULL")
        return connection

    def _initialize_sync(self, path: Path | None = None) -> None:
        target = path or self.path
        target.parent.mkdir(parents=True, exist_ok=True)
        connection = self._connect(target)
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            current_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if current_version > DATABASE_SCHEMA_VERSION:
                raise DatabaseError(
                    f"Database schema {current_version} is newer than supported "
                    f"schema {DATABASE_SCHEMA_VERSION}."
                )
            migration_dir = Path(__file__).parent / "migrations"
            for version in range(current_version + 1, DATABASE_SCHEMA_VERSION + 1):
                migration_file = migration_dir / f"{version:03d}_initial.sql"
                if not migration_file.is_file():
                    migration_file = migration_dir / f"{version:03d}_*.sql"
                    matches = list(migration_dir.glob(migration_file.name))
                    if len(matches) != 1:
                        raise DatabaseError(f"Migration {version} is missing.")
                    migration_file = matches[0]
                statements = migration_file.read_text(encoding="utf-8").split(";")
                now = datetime.now(UTC).isoformat()
                connection.execute("BEGIN IMMEDIATE")
                try:
                    for statement in statements:
                        if statement.strip():
                            connection.execute(statement)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                        (version, now),
                    )
                    connection.execute(f"PRAGMA user_version = {version}")
                    connection.commit()
                except Exception:
                    connection.rollback()
                    raise
            now = datetime.now(UTC).isoformat()
            connection.execute("BEGIN IMMEDIATE")
            for name in ("Cupboard", "Fridge", "Freezer", "Pantry"):
                connection.execute(
                    "INSERT OR IGNORE INTO storage_locations(id,name,created_at,updated_at) "
                    "VALUES (?,?,?,?)",
                    (name.casefold(), name, now, now),
                )
            connection.commit()
        finally:
            connection.close()
        self._ready = path is None

    async def async_fetch_all(
        self, sql: str, parameters: Iterable[Any] = ()
    ) -> list[dict[str, Any]]:
        return await self._execute(
            lambda connection: [dict(row) for row in connection.execute(sql, tuple(parameters))]
        )

    async def async_fetch_one(
        self, sql: str, parameters: Iterable[Any] = ()
    ) -> dict[str, Any] | None:
        def fetch(connection: sqlite3.Connection) -> dict[str, Any] | None:
            row = connection.execute(sql, tuple(parameters)).fetchone()
            return dict(row) if row is not None else None

        return await self._execute(fetch)

    async def async_execute(self, sql: str, parameters: Iterable[Any] = ()) -> int:
        """Execute one statement and return its affected-row count."""

        def execute(connection: sqlite3.Connection) -> int:
            return connection.execute(sql, tuple(parameters)).rowcount

        return await self.async_transaction(execute)

    async def async_transaction(self, operation: _Operation[_Result]) -> _Result:
        """Run a callback atomically; the callback must not perform async work."""
        if not self._ready:
            raise DatabaseError("The database has not been initialized.")
        async with self._lock:
            return await asyncio.to_thread(self._transaction_sync, operation)

    async def _execute(self, operation: _Operation[_Result]) -> _Result:
        if not self._ready:
            raise DatabaseError("The database has not been initialized.")
        async with self._lock:
            return await asyncio.to_thread(self._transaction_sync, operation)

    def _transaction_sync(self, operation: _Operation[_Result]) -> _Result:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            result = operation(connection)
            connection.commit()
            return result
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    async def async_status(self) -> dict[str, Any]:
        """Return safe database health and schema details."""

        def inspect(connection: sqlite3.Connection) -> dict[str, Any]:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            integrity = connection.execute("PRAGMA quick_check").fetchone()[0]
            return {
                "schema_version": version,
                "integrity": integrity,
                "path": str(self.path),
                "size_bytes": self.path.stat().st_size if self.path.exists() else 0,
            }

        return await self._execute(inspect)

    async def async_backup(self, destination: str | Path) -> Path:
        """Create a consistent SQLite backup including committed WAL data."""
        target = Path(destination)
        async with self._lock:
            await asyncio.to_thread(self._backup_sync, target)
        return target

    def _backup_sync(self, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        source = self._connect()
        output = sqlite3.connect(destination)
        try:
            source.backup(output)
            integrity = output.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise DatabaseError(f"Backup integrity check failed: {integrity}")
        finally:
            output.close()
            source.close()

    async def async_restore(self, source_path: str | Path) -> None:
        """Validate a staged database before atomically installing it."""
        source = Path(source_path)
        if not source.is_file():
            raise DatabaseError("The selected backup file does not exist.")
        async with self._lock:
            await asyncio.to_thread(self._restore_sync, source)

    def _restore_sync(self, source: Path) -> None:
        candidate = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True)
        try:
            candidate.execute("PRAGMA foreign_keys = ON")
            integrity = candidate.execute("PRAGMA integrity_check").fetchone()[0]
            violations = candidate.execute("PRAGMA foreign_key_check").fetchall()
            version = candidate.execute("PRAGMA user_version").fetchone()[0]
            tables = {
                row[0]
                for row in candidate.execute("SELECT name FROM sqlite_master WHERE type='table'")
            }
        except sqlite3.DatabaseError as err:
            raise DatabaseError("The selected backup is not a valid SQLite database.") from err
        finally:
            candidate.close()
        required_tables = {"products", "product_variants", "inventory_batches"}
        if integrity != "ok" or violations or not required_tables.issubset(tables):
            raise DatabaseError("The backup failed integrity, relationship, or schema validation.")
        if version > DATABASE_SCHEMA_VERSION:
            raise DatabaseError("The backup was created by a newer Dan's Kitchen version.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stage = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.restore")
        try:
            staged_db = Database(stage)
            staged_db._initialize_sync()
            staged_connection = sqlite3.connect(stage)
            source_connection = sqlite3.connect(source)
            try:
                source_connection.backup(staged_connection)
            finally:
                source_connection.close()
                staged_connection.close()
            if self.path.exists():
                self._connect().execute("PRAGMA wal_checkpoint(TRUNCATE)").connection.close()
            os.replace(stage, self.path)
            for suffix in ("-wal", "-shm"):
                sidecar = Path(f"{self.path}{suffix}")
                if sidecar.exists():
                    sidecar.unlink()
            self._initialize_sync()
        finally:
            for suffix in ("", "-wal", "-shm"):
                staged_path = Path(f"{stage}{suffix}")
                if staged_path.exists():
                    staged_path.unlink()

    async def async_export_json(self) -> dict[str, list[dict[str, Any]]]:
        """Export all application tables as JSON-compatible records."""

        def export(connection: sqlite3.Connection) -> dict[str, list[dict[str, Any]]]:
            table_names = [
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
            return {
                name: [dict(row) for row in connection.execute(f'SELECT * FROM "{name}"')]
                for name in table_names
            }

        return await self._execute(export)

    async def async_export_csv(self, table_name: str) -> str:
        """Export one approved application table as CSV."""
        allowed_tables = {
            "storage_locations",
            "products",
            "product_variants",
            "inventory_batches",
            "stock_transactions",
            "recipes",
            "recipe_ingredients",
            "recipe_weekdays",
            "meal_plan_entries",
            "meal_recurrence_rules",
            "recurrence_exceptions",
            "shopping_items",
            "app_settings",
        }
        if table_name not in allowed_tables:
            raise DatabaseError("CSV export is not available for that table.")

        def export(connection: sqlite3.Connection) -> str:
            rows = connection.execute(f'SELECT * FROM "{table_name}"')
            output = StringIO()
            writer = csv.writer(output)
            writer.writerow([column[0] for column in rows.description])
            writer.writerows(rows.fetchall())
            return output.getvalue()

        return await self._execute(export)
