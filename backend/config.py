"""Obsidia configuration.

Edit these to change where files live, how much free users get,
and the JWT signing key.
"""

from pathlib import Path

# Where encrypted file blobs are stored on disk.
# Default: ./storage/ relative to the project root.
# For production or if you want to point at a different drive:
#   STORAGE_PATH = Path(r"D:\ObsidiaStorage")
STORAGE_PATH = Path(__file__).resolve().parent.parent / "storage"

# Where the SQLite database file lives.
DATA_PATH = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_PATH / "obsidia.db"

# Static frontend files.
FRONTEND_PATH = Path(__file__).resolve().parent.parent / "frontend"

# JWT signing secret. Change for anything beyond localhost!
# Generate a real one with:
#   py -c "import secrets; print(secrets.token_urlsafe(64))"
SECRET_KEY = "dev-only-change-me-for-anything-public-aa7f2d93c1b840e5"
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 7

# Quotas in bytes.
FREE_QUOTA_BYTES = 20 * 1024 * 1024 * 1024          # 20 GB
PLUS_QUOTA_BYTES = 1024 * 1024 * 1024 * 1024        # 1 TB

# Is the Plus tier accepting upgrades right now? Flip to True once your
# infrastructure (storage, backups, PayPal) is actually ready to serve
# the 1 TB promise. Until then, the Upgrade button is disabled in the
# UI and the API refuses direct upgrade calls.
PLUS_AVAILABLE = False

# Max ciphertext size per upload (bytes). 2 GB on free, 50 GB on plus.
FREE_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
PLUS_MAX_FILE_BYTES = 50 * 1024 * 1024 * 1024

# Password-derivation iterations the SERVER expects the client to have
# used (for the auth key). Must match the client's PBKDF2 iterations.
# The client also derives a SEPARATE encryption key with the same iters.
PBKDF2_ITERS = 100_000
PBKDF2_SALT_BYTES = 16


def ensure_dirs() -> None:
    """Make sure runtime directories exist on first run."""
    STORAGE_PATH.mkdir(parents=True, exist_ok=True)
    DATA_PATH.mkdir(parents=True, exist_ok=True)
