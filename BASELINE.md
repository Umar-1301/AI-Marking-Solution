# Baseline for Azure

This document explains the changes made **since the last commit (`Change 3 —
Migrate backend from SQLite to containerised PostgreSQL`)** and describes the
resulting system as an onboarding reference. The `.env.example` templates are
intentionally **not** committed, so the env-variable tables below are the
authoritative list of what each service needs (names only, never values).

---

## What changed since the last commit

### 1. OCR migrated off the local model onto Azure Document Intelligence
Previously `ai-service` baked a ~5.6 GB vision model (**Chandra**) into a GPU/CUDA
image and ran OCR in-process — slow, expensive cold starts. Now:

- `ai-service` is a **thin FastAPI client** that sends documents to **Azure AI
  Document Intelligence** (`prebuilt-read`) and maps the result back into the same
  `{ text, stages, meta }` response the backend already consumes — **so the backend
  did not change.**
- Removed `torch`, `chandra-ocr`, `transformers`, and the whole ML stack from
  `requirements.txt`; added `azure-ai-documentintelligence` + `azure-identity`.
- No rasterising/flattening/downscaling in `ai-service` — Document Intelligence
  takes the raw PDF/image directly. (Files are still security-processed by the
  **backend** first; that pipeline is unchanged.)

### 2. Dockerfile slimmed
`ai-service/Dockerfile` went from an `nvidia/cuda` base with baked weights to
`python:3.11-slim`. No GPU, no model download — cold starts drop from minutes to
seconds.

### 3. Managed identity for the OCR endpoint
`ai-service` authenticates to Document Intelligence with **managed identity**
(`DefaultAzureCredential`) when no key is set; a resource key is used only for
local dev. In Azure the container's identity needs the **`Cognitive Services
User`** role on the resource. `GET /health` reports `{status, configured, auth}`
where `auth` is `key` or `managed_identity`.

### 4. Removed the `mrkscheme-ai` prototype
A local-only mark-scheme testing service (Azure OpenAI / gpt-5-mini) was deleted —
it was never deployed and stays out of the repo.

### 5. Repository hygiene — no secrets, ever
- `.gitignore` (root) now ignores **all** env files (`**/.env`, `**/.env.*`,
  `**/local.env`, `**/local.env.*` — secrets *and* templates), plus node/Python
  deps, virtualenvs, bytecode, tool caches, build output, logs, and OS files.
- Each service's `.dockerignore` excludes the same (env secrets + templates, deps,
  caches, `.git`) so nothing sensitive is ever baked into an image.
- The previously-tracked `.env.example` templates were **untracked** (removed from
  version control, kept on disk locally).

---

## Resulting architecture

```
browser ──HTTPS──▶ frontend (nginx + React/Vite)  :80   PUBLIC
                        │ proxy /api/* (HTTP/1.1)
                        ▼
                   backend (Node/Express, Postgres) :3001 INTERNAL
                        │ HTTP /ocr, /mark
                        ▼
                   ai-service (FastAPI)             :8000 INTERNAL
                        │ HTTPS (managed identity)
                        ▼
                   Azure AI Document Intelligence (prebuilt-read)
```

---

## Environment variables (names only — never commit values)

**backend**

| Variable | Secret (AKV)? | Notes |
|----------|:---:|-------|
| `DATABASE_URL` | 🔐 | Postgres connection string |
| `JWT_SECRET` | 🔐 | required — throws if missing |
| `PASSWORD_PEPPER` | 🔐 | required |
| `EMAIL_PEPPER` | 🔐 | required |
| `AI_SERVICE_URL` | plain | ai-service internal URL |
| `FRONTEND_URL` | plain | frontend origin, for CORS |
| `NODE_ENV` / `PORT` | plain | baked in the Dockerfile (`production` / `3001`) |

**ai-service**

| Variable | Secret (AKV)? | Notes |
|----------|:---:|-------|
| `AZURE_DOCINTEL_ENDPOINT` | plain | `https://<resource>.cognitiveservices.azure.com/` |
| `AZURE_DOCINTEL_KEY` | — | **omit in prod** → managed identity. Local dev only |

**frontend**

| Variable | Secret (AKV)? | Notes |
|----------|:---:|-------|
| `BACKEND_URL` | plain | backend internal URL for the nginx proxy |

---

## Local development

Each service has a gitignored `local.env` / `.env` you create yourself (no
templates are committed). To run OCR locally:

```bash
cd ai-service
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
# local.env: AZURE_DOCINTEL_ENDPOINT=...  AZURE_DOCINTEL_KEY=...  (key for local dev)
uvicorn main:app --port 8000
```

Backend/frontend run via their `npm` scripts; Postgres via the root
`docker-compose.yml`.

---

## Deployment

Images build for **linux/amd64** and push to ACR
(`klassioregistry-eshuhdbmbdfufjgt.azurecr.io`) as `ai-service`, `backend`,
`frontend`, then run on Azure Container Apps:

- **frontend** — public ingress, target port 80.
- **backend** / **ai-service** — internal ingress, target ports 3001 / 8000.
- Ingress transport **HTTP/1** (nginx proxies with `proxy_http_version 1.1`;
  Azure's Envoy ingress 426s HTTP/1.0).
- Container Apps pulls images via an identity with **`AcrPull`**; secrets come from
  **Azure Key Vault** via managed identity. Images are secret-free.
