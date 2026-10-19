"""Local-only web dashboard for stored AI evaluation runs."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from evaluation import database
from evaluation.database import EvaluationDatabaseError


_WEB_ROOT = Path(__file__).resolve().parent / "web"

app = FastAPI(
    title="Aimira AI Evaluations",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.mount("/assets", StaticFiles(directory=_WEB_ROOT), name="evaluation-assets")


@app.exception_handler(EvaluationDatabaseError)
async def evaluation_database_error(
    _: Request,
    exc: EvaluationDatabaseError,
) -> JSONResponse:
    status = 404 if "was not found" in str(exc) else 503
    return JSONResponse(status_code=status, content={"detail": str(exc)})


@app.get("/", include_in_schema=False)
def dashboard_page() -> FileResponse:
    return FileResponse(
        _WEB_ROOT / "index.html",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/targets")
def dashboard_targets() -> dict:
    return {"targets": database.list_dashboard_targets()}


@app.get("/api/targets/{target_id}")
def dashboard_target(target_id: int) -> dict:
    return database.get_target_dashboard(target_id)
