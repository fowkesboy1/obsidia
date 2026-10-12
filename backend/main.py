"""Obsidia FastAPI app entry point.

Run with:
    uvicorn backend.main:app --reload --port 8000

Then open http://localhost:8000
"""

from fastapi import APIRouter, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import auth, config, db, files


app = FastAPI(title="Obsidia", version="0.1.0")

# One-time setup on import.
db.init_db()


# --- Auth routes (bundled here so main.py imports them explicitly) ----

auth_router = APIRouter(prefix="/api/auth", tags=["auth"])


@auth_router.post("/signup", response_model=auth.AuthResponse)
def signup(body: auth.SignupRequest):
    return auth.do_signup(body)


@auth_router.post("/salt", response_model=auth.SaltResponse)
def salt(body: auth.SaltRequest):
    return auth.do_salt_lookup(body)


@auth_router.post("/login", response_model=auth.AuthResponse)
def login(body: auth.LoginRequest):
    return auth.do_login(body)


app.include_router(auth_router)
app.include_router(files.router)


# --- Static frontend --------------------------------------------------

# Serve the shared static assets at /static/
app.mount(
    "/static",
    StaticFiles(directory=config.FRONTEND_PATH / "static"),
    name="static",
)


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "obsidia"}


# Route each page explicitly so URLs stay clean (/, /pricing, /signup,
# /login, /dashboard). FastAPI serves the matching HTML file.

def _page(name: str) -> FileResponse:
    return FileResponse(config.FRONTEND_PATH / name)


@app.get("/")
def index():
    return _page("index.html")


@app.get("/pricing")
def pricing():
    return _page("pricing.html")


@app.get("/signup")
def signup_page():
    return _page("signup.html")


@app.get("/login")
def login_page():
    return _page("login.html")


@app.get("/dashboard")
def dashboard_page():
    return _page("dashboard.html")
