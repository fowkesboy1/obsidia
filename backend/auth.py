"""Zero-knowledge auth for Obsidia.

Flow:

  SIGNUP
    1. Browser derives TWO keys from (passphrase, random salt) via PBKDF2:
         - auth_key: sent to server as proof-of-passphrase
         - enc_key:  NEVER sent; held in memory to decrypt the user's files
    2. Server stores: email, salt, bcrypt(auth_key)
    3. Server issues a JWT; client stores it + the derived enc_key in
       sessionStorage until the tab closes.

  LOGIN
    1. Browser POSTs {email} -> server returns {salt}
    2. Browser derives auth_key + enc_key from (passphrase, salt)
    3. Browser POSTs {email, auth_key} -> server bcrypt-verifies and
       issues a JWT

The server never sees the passphrase or the encryption key. If the user
forgets the passphrase, their files are gone -- that's the trade-off.
"""

import base64
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field

from . import config, db


bearer_scheme = HTTPBearer(auto_error=False)


# --- Pydantic request/response models ---------------------------------

class SignupRequest(BaseModel):
    email: EmailStr
    # Client-generated salt (base64, 16 bytes raw). Required: the client
    # had to pick the salt BEFORE deriving the auth key.
    salt: str = Field(min_length=20, max_length=60)
    # Base64 of the raw PBKDF2-derived auth key, 32 bytes.
    auth_key: str = Field(min_length=40, max_length=100)


class SaltRequest(BaseModel):
    email: EmailStr


class SaltResponse(BaseModel):
    # Base64 of the per-user salt the client should feed into PBKDF2.
    salt: str


class LoginRequest(BaseModel):
    email: EmailStr
    auth_key: str = Field(min_length=40, max_length=100)


class AuthResponse(BaseModel):
    token: str
    user_id: int
    email: str
    plan: str
    salt: str


# --- Password / key handling ------------------------------------------

def new_salt() -> str:
    """Generate a fresh per-user salt as base64."""
    return base64.b64encode(secrets.token_bytes(config.PBKDF2_SALT_BYTES)).decode()


def hash_auth_key(auth_key_b64: str) -> str:
    """bcrypt the client-supplied auth key. bcrypt handles its own salt."""
    # bcrypt input must be bytes and <= 72 bytes.
    # A 32-byte key encoded as base64 is 44 chars = 44 bytes. Fits.
    key_bytes = auth_key_b64.encode("utf-8")
    return bcrypt.hashpw(key_bytes, bcrypt.gensalt()).decode("utf-8")


def verify_auth_key(auth_key_b64: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(auth_key_b64.encode("utf-8"),
                              stored_hash.encode("utf-8"))
    except Exception:
        return False


# --- JWT --------------------------------------------------------------

def issue_token(user_id: int, email: str) -> str:
    payload = {
        "sub": str(user_id),
        "email": email,
        "iat": datetime.now(tz=timezone.utc),
        "exp": datetime.now(tz=timezone.utc)
             + timedelta(days=config.JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, config.SECRET_KEY, algorithm=config.JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, config.SECRET_KEY,
                          algorithms=[config.JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Session expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# --- Dependency for protected routes ----------------------------------

def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    """FastAPI dependency: returns the authenticated user row or 401s."""
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token")
    payload = decode_token(creds.credentials)
    user = db.get_user_by_id(int(payload["sub"]))
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# --- Route handlers ---------------------------------------------------

def do_signup(req: SignupRequest) -> AuthResponse:
    if db.get_user_by_email(req.email) is not None:
        raise HTTPException(status_code=409,
                            detail="An account with that email already exists")

    # Sanity-check the salt looks like base64 of 16+ bytes.
    try:
        if len(base64.b64decode(req.salt, validate=True)) < 16:
            raise ValueError
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid salt")

    auth_hash = hash_auth_key(req.auth_key)
    user_id = db.create_user(req.email, req.salt, auth_hash)
    token = issue_token(user_id, req.email)
    return AuthResponse(token=token, user_id=user_id, email=req.email,
                        plan="free", salt=req.salt)


def do_salt_lookup(req: SaltRequest) -> SaltResponse:
    user = db.get_user_by_email(req.email)
    # Reveal salt even if the user doesn't exist? Returning 404 would
    # leak which emails are registered. We return a per-email
    # deterministic fake salt so an attacker can't tell.
    if user is None:
        # Deterministic HMAC of email with the server secret, truncated.
        import hmac, hashlib
        fake = hmac.new(config.SECRET_KEY.encode(),
                        req.email.lower().encode(), hashlib.sha256).digest()
        return SaltResponse(salt=base64.b64encode(fake[:16]).decode())
    return SaltResponse(salt=user["salt"])


def do_login(req: LoginRequest) -> AuthResponse:
    user = db.get_user_by_email(req.email)
    if user is None or not verify_auth_key(req.auth_key, user["auth_hash"]):
        # Keep errors uniform.
        raise HTTPException(status_code=401,
                            detail="Invalid email or passphrase")
    token = issue_token(user["id"], user["email"])
    return AuthResponse(token=token, user_id=user["id"], email=user["email"],
                        plan=user["plan"], salt=user["salt"])
