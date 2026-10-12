"""File + folder routes for Obsidia.

The server deals in CIPHERTEXT ONLY. The client must have already:
 1. Encrypted the filename with the user's enc_key -> `encrypted_name`
 2. Encrypted the file bytes with the user's enc_key -> the uploaded blob

The server stores the blob at STORAGE_PATH/<user_id>/<file_id>.enc and a
metadata row in SQLite.
"""

import shutil
import uuid
from pathlib import Path

from fastapi import (APIRouter, Depends, File, Form, HTTPException,
                     UploadFile)
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, db
from .auth import current_user


router = APIRouter(prefix="/api", tags=["files"])


# --- Request/response models ------------------------------------------

class FolderCreate(BaseModel):
    encrypted_name: str = Field(min_length=1, max_length=2048)
    parent_id: str | None = None


class FolderOut(BaseModel):
    id: str
    encrypted_name: str
    parent_id: str | None
    created_at: str


class FileOut(BaseModel):
    id: str
    encrypted_name: str
    folder_id: str | None
    size: int
    starred: bool = False
    trashed_at: str | None = None
    created_at: str
    modified_at: str


class ListingOut(BaseModel):
    folders: list[FolderOut]
    files: list[FileOut]


class UploadOut(BaseModel):
    file_id: str
    size: int


class MeOut(BaseModel):
    email: str
    plan: str
    storage_used: int
    storage_quota: int
    file_count: int
    folder_count: int
    starred_count: int = 0
    trashed_count: int = 0
    plus_available: bool = False


class UpgradeOut(BaseModel):
    plan: str
    storage_quota: int


# --- Helpers ----------------------------------------------------------

def user_quota(user) -> int:
    return (config.PLUS_QUOTA_BYTES if user["plan"] == "plus"
            else config.FREE_QUOTA_BYTES)


def user_max_file(user) -> int:
    return (config.PLUS_MAX_FILE_BYTES if user["plan"] == "plus"
            else config.FREE_MAX_FILE_BYTES)


def blob_path(user_id: int, file_id: str) -> Path:
    """Where on disk this user's encrypted blob lives."""
    folder = config.STORAGE_PATH / str(user_id)
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{file_id}.enc"


def _folder_row(row) -> FolderOut:
    return FolderOut(
        id=row["id"],
        encrypted_name=row["encrypted_name"],
        parent_id=row["parent_id"],
        created_at=str(row["created_at"]),
    )


def _file_row(row) -> FileOut:
    return FileOut(
        id=row["id"],
        encrypted_name=row["encrypted_name"],
        folder_id=row["folder_id"],
        size=row["size"],
        starred=bool(row["starred"]) if "starred" in row.keys() else False,
        trashed_at=(str(row["trashed_at"]) if ("trashed_at" in row.keys()
                     and row["trashed_at"] is not None) else None),
        created_at=str(row["created_at"]),
        modified_at=str(row["modified_at"]),
    )


# --- Account routes ---------------------------------------------------

@router.get("/user/me", response_model=MeOut)
def me(user=Depends(current_user)):
    return MeOut(
        email=user["email"],
        plan=user["plan"],
        storage_used=user["storage_used"],
        storage_quota=user_quota(user),
        file_count=db.count_files(user["id"]),
        folder_count=db.count_folders(user["id"]),
        starred_count=db.count_starred(user["id"]),
        trashed_count=db.count_trashed(user["id"]),
        plus_available=config.PLUS_AVAILABLE,
    )


@router.post("/user/upgrade", response_model=UpgradeOut)
def mock_upgrade(user=Depends(current_user)):
    """MOCK: flip the user to the Plus plan. Replace with a real PayPal
    webhook when the Business account is live.

    Gated by config.PLUS_AVAILABLE so no one can claim 1 TB before the
    infrastructure is ready to serve it."""
    if not config.PLUS_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Obsidia Plus isn't accepting signups yet. "
                   "Join the waitlist on the pricing page and we'll "
                   "email you the moment it launches.",
        )
    db.set_user_plan(user["id"], "plus")
    return UpgradeOut(plan="plus", storage_quota=config.PLUS_QUOTA_BYTES)


@router.post("/user/cancel", response_model=UpgradeOut)
def mock_cancel(user=Depends(current_user)):
    """MOCK: cancel the user's Plus subscription and revert to Free.
    Existing files stay put; the user just can't upload new ones until
    they're back under the free quota. Replace with a real PayPal
    subscription-cancellation webhook when the Business account is live."""
    db.set_user_plan(user["id"], "free")
    return UpgradeOut(plan="free", storage_quota=config.FREE_QUOTA_BYTES)


@router.delete("/user")
def delete_account(user=Depends(current_user)):
    """Permanently delete the account: all encrypted blobs, all metadata,
    and the user row itself. Irreversible."""
    # 1) Wipe the user's blob folder on disk.
    user_folder = config.STORAGE_PATH / str(user["id"])
    try:
        if user_folder.exists():
            shutil.rmtree(user_folder)
    except Exception:
        pass  # Push on to the DB wipe regardless.

    # 2) Wipe all metadata.
    with db.get_conn() as conn:
        conn.execute("DELETE FROM files   WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM folders WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM users   WHERE id = ?",      (user["id"],))
        conn.commit()
    return {"ok": True}


# --- Folder routes ----------------------------------------------------

@router.post("/folders", response_model=FolderOut)
def create_folder(body: FolderCreate, user=Depends(current_user)):
    folder_id = str(uuid.uuid4())
    db.create_folder(folder_id, user["id"], body.parent_id, body.encrypted_name)
    row = {
        "id": folder_id,
        "encrypted_name": body.encrypted_name,
        "parent_id": body.parent_id,
        "created_at": "",
    }
    return FolderOut(**row)


@router.delete("/folders/{folder_id}")
def delete_folder(folder_id: str, user=Depends(current_user)):
    # Simple: refuse delete if folder isn't empty.
    if db.list_files(user["id"], folder_id) or \
       db.list_folders(user["id"], folder_id):
        raise HTTPException(status_code=400,
                            detail="Folder is not empty")
    db.delete_folder(folder_id, user["id"])
    return {"ok": True}


# --- File listing + upload + download + delete ------------------------

@router.get("/files", response_model=ListingOut)
def list_items(folder_id: str | None = None, user=Depends(current_user)):
    """List folders + files inside the given folder (None = root)."""
    folders = [_folder_row(r) for r in db.list_folders(user["id"], folder_id)]
    files = [_file_row(r) for r in db.list_files(user["id"], folder_id)]
    return ListingOut(folders=folders, files=files)


@router.post("/files", response_model=UploadOut)
async def upload_file(
    encrypted_name: str = Form(...),
    folder_id: str | None = Form(None),
    blob: UploadFile = File(...),
    user=Depends(current_user),
):
    """Store an already-encrypted file. The server validates size and
    writes the ciphertext straight to disk."""
    if folder_id == "" or folder_id == "null":
        folder_id = None

    file_id = str(uuid.uuid4())
    path = blob_path(user["id"], file_id)
    size = 0
    max_single = user_max_file(user)
    quota = user_quota(user)
    remaining = max(0, quota - user["storage_used"])

    try:
        with open(path, "wb") as out:
            while True:
                chunk = await blob.read(1024 * 1024)   # 1 MB chunks
                if not chunk:
                    break
                size += len(chunk)
                if size > max_single:
                    out.close()
                    path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds per-file limit "
                               f"({max_single // (1024**3)} GB)",
                    )
                if size > remaining:
                    out.close()
                    path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail="Not enough storage left in your plan",
                    )
                out.write(chunk)
    except HTTPException:
        raise
    except Exception as e:
        path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Write failed: {e!s}")

    db.create_file_row(file_id, user["id"], folder_id, encrypted_name, size)
    db.bump_storage_used(user["id"], size)
    return UploadOut(file_id=file_id, size=size)


@router.get("/files/{file_id}/download")
def download_file(file_id: str, user=Depends(current_user)):
    row = db.get_file(file_id, user["id"])
    if row is None:
        raise HTTPException(status_code=404, detail="File not found")
    path = blob_path(user["id"], file_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File blob missing on disk")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"{file_id}.enc",
    )


@router.delete("/files/{file_id}")
def delete_file(file_id: str, user=Depends(current_user)):
    """Soft delete: move the file to Trash. Blob stays on disk, quota is
    unchanged. Caller must POST /files/{id}/permanent to free the space."""
    row = db.get_file(file_id, user["id"])
    if row is None or row["trashed_at"] is not None:
        raise HTTPException(status_code=404, detail="File not found")
    db.trash_file(file_id, user["id"])
    return {"ok": True}


@router.post("/files/{file_id}/restore")
def restore_file(file_id: str, user=Depends(current_user)):
    row = db.get_file(file_id, user["id"])
    if row is None or row["trashed_at"] is None:
        raise HTTPException(status_code=404, detail="Nothing to restore")
    db.restore_file(file_id, user["id"])
    return {"ok": True}


@router.delete("/files/{file_id}/permanent")
def permanent_delete(file_id: str, user=Depends(current_user)):
    """Actually delete: removes the ciphertext blob and frees quota.
    Irreversible."""
    row = db.get_file(file_id, user["id"])
    if row is None:
        raise HTTPException(status_code=404, detail="File not found")

    path = blob_path(user["id"], file_id)
    size = row["size"]
    try:
        path.unlink(missing_ok=True)
    except Exception:
        pass

    db.delete_file_row(file_id, user["id"])
    db.bump_storage_used(user["id"], -size)
    return {"ok": True}


@router.post("/files/{file_id}/star")
def star_file(file_id: str, starred: bool = True, user=Depends(current_user)):
    """Toggle star. Pass ?starred=true/false in the query."""
    row = db.get_file(file_id, user["id"])
    if row is None or row["trashed_at"] is not None:
        raise HTTPException(status_code=404, detail="File not found")
    db.set_file_starred(file_id, user["id"], starred)
    return {"ok": True, "starred": starred}


@router.get("/starred", response_model=ListingOut)
def list_starred(user=Depends(current_user)):
    files = [_file_row(r) for r in db.list_starred_files(user["id"])]
    return ListingOut(folders=[], files=files)


@router.get("/trash", response_model=ListingOut)
def list_trash(user=Depends(current_user)):
    files = [_file_row(r) for r in db.list_trashed_files(user["id"])]
    return ListingOut(folders=[], files=files)
