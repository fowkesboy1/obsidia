"""SQLite schema + connection helpers for Obsidia."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from . import config


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    email           TEXT UNIQUE NOT NULL,
    salt            TEXT NOT NULL,
    auth_hash       TEXT NOT NULL,
    storage_used    INTEGER NOT NULL DEFAULT 0,
    plan            TEXT NOT NULL DEFAULT 'free',
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS folders (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    parent_id       TEXT,
    encrypted_name  TEXT NOT NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,
    user_id         INTEGER NOT NULL,
    folder_id       TEXT,
    encrypted_name  TEXT NOT NULL,
    size            INTEGER NOT NULL,
    starred         INTEGER NOT NULL DEFAULT 0,
    trashed_at      TIMESTAMP,
    created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    modified_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

"""

# Indexes are created AFTER _migrate() has had a chance to add any
# missing columns on an existing database. If we put the trashed_at
# index inside SCHEMA, it would fire against an old `files` table that
# still lacks that column, and SQLite would raise.
INDEXES = """
CREATE INDEX IF NOT EXISTS idx_files_user_folder   ON files(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_files_user_trash    ON files(user_id, trashed_at);
CREATE INDEX IF NOT EXISTS idx_files_user_starred  ON files(user_id, starred);
CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_id);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Add new columns to existing databases that pre-date them."""
    def has_col(table: str, col: str) -> bool:
        return any(r[1] == col for r in conn.execute(f"PRAGMA table_info({table})"))
    if not has_col('files', 'starred'):
        conn.execute("ALTER TABLE files ADD COLUMN starred INTEGER NOT NULL DEFAULT 0")
    if not has_col('files', 'trashed_at'):
        conn.execute("ALTER TABLE files ADD COLUMN trashed_at TIMESTAMP")


def init_db() -> None:
    """Create tables on first run; migrate existing DBs that pre-date new columns."""
    config.ensure_dirs()
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.executescript(INDEXES)
        conn.commit()


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Context-managed SQLite connection with row factory + FK enforcement."""
    conn = sqlite3.connect(
        config.DB_PATH,
        detect_types=sqlite3.PARSE_DECLTYPES,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


# --- User helpers -----------------------------------------------------

def create_user(email: str, salt: str, auth_hash: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, salt, auth_hash) VALUES (?, ?, ?)",
            (email, salt, auth_hash),
        )
        conn.commit()
        return cur.lastrowid


def get_user_by_email(email: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE email = ?", (email,)
        ).fetchone()


def get_user_by_id(user_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM users WHERE id = ?", (user_id,)
        ).fetchone()


def set_user_plan(user_id: int, plan: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE users SET plan = ? WHERE id = ?", (plan, user_id))
        conn.commit()


def bump_storage_used(user_id: int, delta_bytes: int) -> None:
    """Adjust storage_used by delta_bytes (positive on upload, negative on delete)."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id = ?",
            (delta_bytes, user_id),
        )
        conn.commit()


# --- Folder helpers ---------------------------------------------------

def create_folder(folder_id: str, user_id: int, parent_id: str | None,
                  encrypted_name: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO folders (id, user_id, parent_id, encrypted_name) "
            "VALUES (?, ?, ?, ?)",
            (folder_id, user_id, parent_id, encrypted_name),
        )
        conn.commit()


def list_folders(user_id: int, parent_id: str | None) -> list[sqlite3.Row]:
    with get_conn() as conn:
        if parent_id is None:
            return conn.execute(
                "SELECT * FROM folders WHERE user_id = ? AND parent_id IS NULL "
                "ORDER BY created_at DESC",
                (user_id,),
            ).fetchall()
        return conn.execute(
            "SELECT * FROM folders WHERE user_id = ? AND parent_id = ? "
            "ORDER BY created_at DESC",
            (user_id, parent_id),
        ).fetchall()


def delete_folder(folder_id: str, user_id: int) -> None:
    """Delete a folder owned by the user. Does NOT cascade files
    (we delete those explicitly so we can also remove their blobs)."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM folders WHERE id = ? AND user_id = ?",
            (folder_id, user_id),
        )
        conn.commit()


# --- File helpers -----------------------------------------------------

def create_file_row(file_id: str, user_id: int, folder_id: str | None,
                    encrypted_name: str, size: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO files (id, user_id, folder_id, encrypted_name, size) "
            "VALUES (?, ?, ?, ?, ?)",
            (file_id, user_id, folder_id, encrypted_name, size),
        )
        conn.commit()


def get_file(file_id: str, user_id: int) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM files WHERE id = ? AND user_id = ?",
            (file_id, user_id),
        ).fetchone()


def list_files(user_id: int, folder_id: str | None) -> list[sqlite3.Row]:
    """Live files only (not trashed) in the given folder."""
    with get_conn() as conn:
        if folder_id is None:
            return conn.execute(
                "SELECT * FROM files WHERE user_id = ? AND folder_id IS NULL "
                "AND trashed_at IS NULL ORDER BY modified_at DESC",
                (user_id,),
            ).fetchall()
        return conn.execute(
            "SELECT * FROM files WHERE user_id = ? AND folder_id = ? "
            "AND trashed_at IS NULL ORDER BY modified_at DESC",
            (user_id, folder_id),
        ).fetchall()


def list_starred_files(user_id: int) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM files WHERE user_id = ? AND starred = 1 "
            "AND trashed_at IS NULL ORDER BY modified_at DESC",
            (user_id,),
        ).fetchall()


def list_trashed_files(user_id: int) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM files WHERE user_id = ? AND trashed_at IS NOT NULL "
            "ORDER BY trashed_at DESC",
            (user_id,),
        ).fetchall()


def set_file_starred(file_id: str, user_id: int, starred: bool) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET starred = ? WHERE id = ? AND user_id = ?",
            (1 if starred else 0, file_id, user_id),
        )
        conn.commit()


def trash_file(file_id: str, user_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET trashed_at = CURRENT_TIMESTAMP "
            "WHERE id = ? AND user_id = ?",
            (file_id, user_id),
        )
        conn.commit()


def restore_file(file_id: str, user_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE files SET trashed_at = NULL WHERE id = ? AND user_id = ?",
            (file_id, user_id),
        )
        conn.commit()


def delete_file_row(file_id: str, user_id: int) -> None:
    """Hard delete the metadata row. Caller is responsible for the blob."""
    with get_conn() as conn:
        conn.execute(
            "DELETE FROM files WHERE id = ? AND user_id = ?",
            (file_id, user_id),
        )
        conn.commit()


def count_files(user_id: int) -> int:
    """Live files only (excludes trash)."""
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND trashed_at IS NULL",
            (user_id,),
        ).fetchone()["n"]


def count_starred(user_id: int) -> int:
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND starred = 1 "
            "AND trashed_at IS NULL",
            (user_id,),
        ).fetchone()["n"]


def count_trashed(user_id: int) -> int:
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND trashed_at IS NOT NULL",
            (user_id,),
        ).fetchone()["n"]


def count_folders(user_id: int) -> int:
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM folders WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]
