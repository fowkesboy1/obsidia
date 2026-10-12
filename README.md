# Obsidia

Zero-knowledge cloud storage prototype. Files are encrypted in the browser
with AES-256-GCM before upload; the server never sees plaintext or your
passphrase.

This is a **localhost demo** — intended for development, screen-share
pitches, and poking around. Not hardened for production.

## Stack

- **Backend:** Python 3.11+ / FastAPI / SQLite
- **Frontend:** Vanilla HTML / CSS / JS (WebCrypto for all crypto work)
- **Storage:** local filesystem (`./storage/` by default)
- **Payments:** mocked (the "Upgrade to Plus" button just flips a flag)

## Prerequisites (Windows)

1. **Python 3.11 or newer** — https://www.python.org/downloads/
   Make sure "Add Python to PATH" is checked during install.
2. (Optional) **Git** if you want to version it.

Check it's working:

    py --version

You should see something like `Python 3.11.9` or higher.

## First-time setup

Open PowerShell (or Command Prompt) in the project folder, then:

    py -m venv venv
    venv\Scripts\activate
    pip install -r requirements.txt

That creates an isolated Python environment and installs FastAPI, Uvicorn,
bcrypt, PyJWT, and friends.

## Run it

With the venv activated:

    uvicorn backend.main:app --reload --port 8000

Then open http://localhost:8000 in your browser.

The first time it runs, it creates:

- `data/obsidia.db` — SQLite database (users + file metadata)
- `storage/` — encrypted file blobs

Both are ignored by git.

## What works

- **Sign up / log in** — your passphrase is hashed and derived in your
  browser; only an auth hash is sent to the server
- **Encrypted upload** — files encrypted with AES-256-GCM before leaving
  your device
- **Encrypted download** — ciphertext fetched, decrypted in browser,
  presented as the original file
- **Folders** — create, list, navigate
- **Delete** — removes both the DB row and the on-disk blob
- **Quota** — tracked server-side in bytes stored
- **Mock upgrade** — "Upgrade to Plus" button flips your plan to `plus`
  and bumps your quota to 1 TB (replace with real PayPal webhooks later)

## What's mocked / deferred

- **PayPal integration** — the Upgrade button is fake. When you're ready
  for real subscriptions, we swap in the PayPal Subscriptions API and a
  webhook handler.
- **Email verification** — you can sign up with any email string
- **Share links** — not in this prototype; next phase
- **Argon2id key derivation** — using PBKDF2-SHA256 (100k iters) for
  simplicity in v1. Both are solid; Argon2id is just better. Easy swap.
- **Recoverable encryption mode** — v1 is zero-knowledge only. The
  toggle shows up in Settings but is wired to a `"not yet available"`
  message.
- **File previews, version history, multi-device sync** — later phases
- **Rate limiting, abuse protection, backups** — pre-production work

## Project layout

    obsidia/
      backend/
        main.py            FastAPI app, routes
        config.py          Settings (storage path, secret key)
        db.py              SQLite schema + helpers
        auth.py            Signup/login/JWT
        files.py           Upload/download/metadata routes
      frontend/
        index.html         Landing page
        pricing.html       Pricing page
        signup.html        Create account
        login.html         Sign in
        dashboard.html     File browser
        static/
          css/app.css      Shared Obsidia styles
          js/
            crypto.js      WebCrypto helpers
            api.js         Fetch client
            auth.js        Signup/login logic
            dashboard.js   File upload/download/list
      storage/             Encrypted file blobs (gitignored)
      data/                SQLite database (gitignored)

## Security notes (be honest with investors)

- **Zero-knowledge** means: the server never sees your passphrase,
  never sees plaintext file content, and cannot decrypt your files.
  It CAN see: your email, your file *sizes* (ciphertext), creation
  timestamps, and folder counts.
- **If you lose your passphrase, your files are unrecoverable.**
  That's the trade-off. Recoverable mode (coming later) escrows a
  key copy for users who want password resets.
- Browser `localStorage` holds your session token and derived key
  while you're logged in. Clear it or close the tab and you're
  logged out.
- This prototype has no rate limiting. Do not expose it to the
  public internet as-is.

## Config

`backend/config.py` has three things worth changing:

- `STORAGE_PATH` — where encrypted blobs live. Default: `./storage/`.
  Point it at your 1 TB drive by setting an absolute path like
  `D:\\ObsidiaStorage` (double-escape backslashes on Windows).
- `SECRET_KEY` — used to sign JWTs. The default is a dev value. If
  you expose this anywhere beyond localhost, generate a real one:

      py -c "import secrets; print(secrets.token_urlsafe(64))"

- `FREE_QUOTA_BYTES` / `PLUS_QUOTA_BYTES` — defaults to 20 GB / 1 TB.

## License

Your code, your call. No license file shipped by default.
