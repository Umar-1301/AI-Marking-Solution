# Teacher AI - Secure AI Marking Platform (Work in Progress)

---

## Current State — Baseline (Running in Azure with SQLite)

This branch captures the **baseline**: the full application containerised and running in Azure Container Apps, backed by SQLite, **before** the migration to PostgreSQL begins. Below is a snapshot of the whole system as it stands.

### What it is
AIMIRA is a secure, AI-assisted marking platform for secondary-school English. A teacher signs in, manages classes/students, uploads a mark scheme, and the system OCRs it (with student-work marking to follow), all built to an enterprise security and cloud-deployment standard.

### Architecture — three containerised services
| Service | Tech | Port | Azure ingress | Role |
|---|---|---|---|---|
| **Frontend** | React (Vite build) served by **nginx** | 80 | **External** (public) | Serves the SPA **and** reverse-proxies `/api` to the backend |
| **Backend** | Node/Express | 3001 | **Internal** | Auth, classes/students, lessons, OCR orchestration; embedded **SQLite** DB |
| **AI service** | FastAPI + **Chandra** OCR model | 8000 | **Internal** | OCR on a **GPU** (NVIDIA T4) |

### Request flow
```
Browser ──HTTPS──▶ Frontend (nginx, public)
                     ├─ serves static React
                     └─ /api ──▶ Backend (Express, internal)
                                   └─ AI_SERVICE_URL ──▶ AI service / Chandra (FastAPI, internal, GPU)
```
The browser only ever talks to the frontend's domain; nginx proxies `/api` to the backend server-side, so everything is one origin to the browser (cookies stay same-site) and the backend/AI service are never publicly exposed.

### Authentication
- JWT issued on signup/login ([routes/auth.js](backend/src/routes/auth.js)), delivered as an **httpOnly cookie** (JS can't read it); a non-sensitive user object is kept in `localStorage` for the UI.
- `authenticate.js` middleware verifies the cookie on protected routes (`/classes`, `/lessons`, `/upload`); `/auth` itself is unguarded.
- Passwords: peppered (HMAC-SHA256) then **bcrypt** (cost 12, random salt). Emails: stored as a peppered **HMAC** (deterministic, never plaintext, lookup-able). Brute-force lockout, common-password blacklist, 72-byte guard.

### Data layer
- SQLite via **least-privilege accessors** (`teacherDb` / `lessonDb` / `classDb`) in [db/index.js](backend/src/db/index.js) — the only file that opens the connection or runs SQL. Schema self-initialises on boot ([db/schema.js](backend/src/db/schema.js)).
- ⚠️ **Ephemeral**: container storage resets on restart and isn't shared across replicas, so the backend runs as a **single replica**. **PostgreSQL migration is the next change** to give persistent, multi-replica storage.

### Azure deployment
- Three images in **Azure Container Registry**; deployed as Container Apps.
- Frontend external; backend + AI service internal (reached by internal FQDN).
- Chandra on a **serverless GPU** workload profile (Consumption-GPU-NC8as-T4, 16 GB T4 VRAM), concurrency 1.
- Secrets (`JWT_SECRET`, peppers) from **Key Vault**; nginx tuned for ACA ingress (Host/SNI routing + HTTP/1.1).

### Security controls (summary)
Parameterised SQL + least-privilege DB accessors · httpOnly + secure + sameSite cookies · bcrypt + pepper / HMAC emails · helmet CSP & security headers · file MIME + magic-byte + size validation · input sanitisation & prototype-pollution guards · rate limiting + login lockout · internal-only backend/AI ingress · non-root containers · secrets in Key Vault.

### Known limitations / next steps
- **SQLite is ephemeral** → migrating to Azure PostgreSQL (in progress).
- Private **VNet** networking for the database (planned).
- Student-work marking pipeline (beyond mark-scheme OCR) to be completed.

---

## Local Setup

### 1. Install dependencies

Each service's dependencies are listed in a manifest file (`package.json` for Node, `requirements.txt` for Python) but not committed themselves — install them locally:

```bash
cd backend && npm install
cd frontend && npm install
cd ai-service && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

### 2. Configure environment files

Each of the three services (`backend`, `frontend`, `ai-service`) needs its own local config file, which is gitignored because it contains machine-specific or secret values. An `.env.example` (or `local.env.example` for ai-service) is committed alongside each one — copy it and fill in the values:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp ai-service/local.env.example ai-service/local.env
```

For `backend/.env`, generate your own `JWT_SECRET`:

```bash
openssl rand -hex 32
```

It only needs to exist for your local backend to sign/verify session tokens — it doesn't need to match anyone else's value.

For `ai-service/local.env`, set `TORCH_DEVICE` based on your hardware (`mps` for Apple Silicon, `cuda` for Nvidia GPU, `cpu` otherwise).

### 3. Run

Start each service in its own terminal:

```bash
cd backend && npm run dev
cd frontend && npm run dev
cd ai-service && source .venv/bin/activate && python3 main.py
```

## Overview
Teacher AI is a multi-phase project to design a secure, enterprise-style platform for AI-assisted marking in secondary education. The goal is to support the marking of English responses against a rubric while building the surrounding infrastructure as if it were being delivered to schools as a B2B SaaS offering.

Rather than focusing only on the model itself, this project approaches AI delivery from a consultancy perspective: understanding the business problem, designing a secure target architecture, and building the supporting cloud, identity, networking, and data foundations required to deploy the solution safely.

## Problem
Teachers spend a significant amount of time marking written work, and marking can vary between individuals. This project explores how an AI-based system could reduce workload, improve feedback speed, and increase consistency, while still being deployed in a way that meets real-world security and operational expectations.

## My Focus
My workstream focuses on the infrastructure and security side of the platform. This includes:
- secure cloud architecture in Azure
- data ingestion design
- identity and access control
- secure storage and secret handling
- network design for customer-to-cloud connectivity
- preparing the platform for future enterprise-style deployment

## Architecture Direction
The wider architecture treats the school or customer environment as a separate, secured environment that connects into Azure-based services. This reflects a realistic deployment model where sensitive student data, user access, and model interaction must be protected across both on-premises and cloud components.

The project has therefore been designed around:
- hybrid connectivity between customer environments and Azure
- segmented network design
- identity-led access control
- secure movement of data at rest, in transit, and in use
- separation of training, ingestion, and application-serving concerns

## Work Completed So Far

### 1. Defined the secure AI delivery architecture
I mapped out the core workstreams required to deliver the platform securely, including:
- data engineering and security
- Active Directory and IAM
- network architecture and secure design
- firewall engineering
- cloud-based model training and hosting

This helped position the project not as a simple AI demo, but as a realistic end-to-end solution.

### 2. Designed the data ingestion layer
I planned the ingestion workflow to pull datasets from approved external sources, process them in Azure, and store them for later training use.

The ingestion component is being designed around Azure Container Apps Jobs rather than relying on a traditional always-on VM. This gives a cleaner and more cloud-native pattern for scheduled or event-driven ingestion work.

### 3. Containerised the ingestion workload
I used Docker to package the ingestion code and its dependencies into a portable image, then pushed that image into Azure Container Registry (ACR). This establishes a deployment path that is closer to how modern cloud workloads are delivered in production.

### 4. Built the storage foundation
I set up Azure storage components to support raw data landing and future processing, including Data Lake-style storage structure for datasets and downstream use.

As part of this, I considered both functionality and secure access design, including how ingestion services would upload data and how storage would later support training workflows.

### 5. Explored private networking and secure access paths
I tested a more secure design using private endpoints, private DNS, and a VM inside the virtual network to validate storage access without exposing services publicly.

This was useful for understanding how the production design should operate, even though I later relaxed some access settings temporarily to prioritise build speed and functional testing in the current phase.

### 6. Implemented a stronger identity model
A major design decision was to avoid embedding credentials inside code or configuration. Instead, I moved toward using Azure Managed Identity and Azure Key Vault.

This means the ingestion workload can authenticate to Azure services using platform-issued tokens rather than stored secrets, while external API secrets can be kept in Key Vault and referenced securely at runtime.

### 7. Refined access control and registry permissions
I also worked through Azure Container Registry access considerations, including the difference between ABAC and RBAC in this setup, so that image access and deployment permissions align more closely with a manageable enterprise model.

## Security Principles Applied
This project has been shaped by a few core security principles:
- least privilege access
- removal of hardcoded secrets
- preference for identity-based authentication
- layered network controls
- clear separation between development pragmatism and production-grade design
- secure handling of data at rest, in transit, and during processing

## Consultancy Lens
What makes this project relevant from a consultancy perspective is that it is not just about building a technical solution. It is about translating a business problem into a secure architecture, making design trade-offs between ideal security and delivery practicality, and building with future deployment, maintainability, and customer environments in mind.

This project reflects how I approach technical consulting work:
- start with the operational problem
- identify the systems and trust boundaries involved
- choose secure-by-design patterns where possible
- document trade-offs clearly
- build iteratively while keeping the long-term architecture in view

## Current Status
This project is still in progress. The data ingestion and identity foundations are actively being built, and the wider architecture continues to evolve alongside the model development work.

The current phase has focused on securing how data is collected, authenticated, stored, and prepared in Azure so that later model training and application delivery sit on stronger foundations.

## Technologies
Azure, Azure Container Apps Jobs, Azure Container Registry, Azure Storage, Data Lake concepts, Docker, Managed Identity, Azure Key Vault, RBAC, private endpoints, private DNS, virtual networking, API security, Active Directory, firewall and hybrid architecture concepts

---

## Change 2c — Front and Backend Dockerisation

Containerises the backend (Node/Express) and finalises the frontend image — completing the set of three Azure-ready images (frontend, backend, Chandra). Includes I4: making the SQLite database work at container runtime.

### Backend image (new)

[backend/Dockerfile](backend/Dockerfile) + [backend/.dockerignore](backend/.dockerignore).

- **Multi-stage build** — a build stage carrying the native-addon toolchain (`better-sqlite3`, `bcrypt`, `sharp` are C/C++ modules), and a lean runtime stage that ships no compilers.
- **Non-root** — runs as the `node` user, with `src/data` and `logs` owned by it. Smaller blast radius for a service holding auth and the database.
- **Env-driven, nothing baked** — `PORT`, `FRONTEND_URL`, `AI_SERVICE_URL`, `JWT_SECRET` and the peppers all come from the Container App at deploy; the three secrets fail-fast on startup if missing.
- **`.dockerignore`** excludes the local `.sqlite`, `.env`, `users.json` and `pepper.json` so the image gets a clean DB and no leaked secrets (while keeping `10k-most-common.txt` and `users.js`).

Why the backend needed far less work than the frontend: it was already a portable, env-configured server — `node src/server.js` runs identically in dev and prod. Containerising it was packaging, not re-architecting.

### I4 — SQLite at container runtime

The DB file is gitignored, so a container starts with **no database**. Two fixes:

1. **Directory baked in** — `mkdir -p src/data` so `better-sqlite3` can create a fresh `aimira.sqlite` on first boot, and `schema.js` builds the tables via `CREATE TABLE IF NOT EXISTS`.
2. **Startup ordering bug fixed** — [db/index.js](backend/src/db/index.js) prepared SQL statements at import time (e.g. `SELECT … FROM teachers`), but the tables were only created later by `db/schema.js`. This worked locally **only because a `.sqlite` file already existed** from previous runs; on a fresh container it crashed with `no such table: teachers`. Fixed by turning `schema.js` into an `initSchema(db)` function that [index.js](backend/src/db/index.js) calls **immediately after opening the connection, before any statement is prepared** ([schema.js](backend/src/db/schema.js), [server.js](backend/src/server.js)). The DB layer is now correctly self-initialising whether or not the file pre-exists.

⚠️ Container storage is **ephemeral**: data resets on restart and is not shared across replicas. Deploy the backend as a **single replica** for now; PostgreSQL is the persistent long-term fix.

### Frontend image (finalised)

The Dockerfile and nginx config were built in Change 2a. The change here is **scoping the security headers to the static content**: nginx's `add_header` directives sat at the `server` level, so they were also applied to proxied `/api` responses — which already carry the backend's helmet headers, producing duplicate and conflicting headers (e.g. `X-Frame-Options: DENY` from nginx vs `SAMEORIGIN` from helmet). Moved them into `location /` ([nginx.conf.template](frontend/nginx.conf.template)) so nginx only sets them on the pages it serves, and the backend owns its own response headers.

### Validation

All three images were built for `linux/amd64` and tested locally: the backend boots and self-creates the DB (`aimira.sqlite` + WAL companions); the frontend serves the SPA and proxies `/api` to the backend over a Docker network (mirroring how Azure resolves the internal FQDN), returning the backend's response with no duplicate headers.

### Deploy intent (ingress)

- **Frontend** → external ingress (public — the browser's only entry point).
- **Backend** → internal ingress (only the frontend's nginx reaches it, via `/api`).
- **Chandra** → internal ingress (only the backend reaches it).

---

## Change 2b — Containerising Chandra: I5 + I6

Packages the Chandra OCR model as its own container for Azure Container Apps. It runs as a standalone internal service ([ai-service/Dockerfile](ai-service/Dockerfile)), reached only by the backend.

### I6 — Sizing: measured, not guessed

Instead of assuming a profile, we ran Chandra in a CPU container locally and pushed a real 23-page mark scheme through `/ocr`:

| Metric | Result |
|---|---|
| Idle RAM (model loaded) | 3.68 GiB |
| Peak RAM during OCR | 15.16 GiB |
| Time per page (CPU) | ~5-7 min (23 pages ≈ 2.5 hrs) |

The binding constraint is **compute, not memory** — CPU inference is unusably slow (a single page exceeds nginx's 300s proxy timeout). Conclusion: Chandra needs a **GPU**, not a large CPU box. Target: Azure serverless GPU **NC8as-T4** (NVIDIA T4, 16 GB VRAM) — the bf16 model fits in ~8-10 GB, with the 1280px image cap bounding activation memory.

The test scaffolding isn't in the code, but two production features were kept from it: a `/health` readiness probe ([main.py](ai-service/main.py)) and env-driven thread caps ([ocr.py](ai-service/model/ocr.py)).

### I5 — PyTorch architecture

Local dev uses MPS torch (Mac); Azure GPU nodes are linux/amd64 with NVIDIA CUDA. Fixed by the Dockerfile: an `nvidia/cuda` base built for `--platform linux/amd64`, where pip resolves the CUDA torch build automatically — no separate requirements file needed.

### The image

- **Base:** `nvidia/cuda:13.0.0-cudnn-runtime` (amd64) — GPU runtime for Azure.
- **Weights baked in:** `datalab-to/chandra-ocr-2` (bf16) downloaded at build, so the container starts ready and never re-downloads.
- **Offline at runtime:** `HF_HUB_OFFLINE=1` — no Hugging Face calls on start.
- **Listens on `0.0.0.0:8000`**, serving `/ocr`, `/mark`, `/health`.

### Security

- **Internal ingress only** — reachable solely from the backend over the Container Apps network; never exposed to the browser or public internet.
- **No runtime external dependency** — offline weight loading works behind locked-down egress and can't be stalled by a Hugging Face outage.
- **No host config leak** — `.dockerignore` excludes `local.env` (which holds `TORCH_DEVICE=mps`) and caches from the image.
- **Concurrency 1 per replica** (deploy-time) bounds VRAM — Azure scales replicas rather than stacking jobs.

---

## Change 2a — Migrating to Azure: I1–3 + I7–8

This change prepares the application for deployment to Azure Container Apps. The issues addressed here are the ones that would prevent the containerised build from starting, serving cookies correctly, or routing API calls — everything that must work before the application is even reachable in Azure. Issues I4–I6 (SQLite at runtime, PyTorch architecture, and Chandra model sizing) are deferred to a follow-on change.

---

### I1 — Pepper values moved from `pepper.json` to environment variables

**Problem**

Passwords and emails are pre-hashed with an HMAC pepper before being passed to bcrypt. Previously, the pepper values were read at startup from a hardcoded file path (`src/data/pepper.json`). That file was gitignored, which meant it had to be manually placed on every server. In a container environment there is no persistent filesystem to drop files into — the file would simply not exist at runtime.

**Fix**

`pepper.json` is removed entirely. `PASSWORD_PEPPER` and `EMAIL_PEPPER` are now read from environment variables and validated at startup in `backend/src/config/index.js`, using the same pattern already in place for `JWT_SECRET` (throws immediately on boot if either value is missing). Both variables are documented in `backend/.env.example`.

**Azure path**

When deploying to Azure Container Apps, these values will be pulled from Azure Key Vault and injected as container environment variables, keeping secrets out of the image and out of source control entirely.

---

### I2 — Trust proxy added

**Problem**

Azure Container Apps places an ingress proxy in front of every container. Without `trust proxy`, Express reads `req.ip` as the proxy's internal IP address rather than the real client IP. This causes every user's request to appear to come from the same address, which collapses all users into a single rate-limit bucket — the global 100-requests-per-hour limit would be hit immediately under any real load.

**Fix**

`app.set('trust proxy', 1)` is added to `backend/src/server.js` before any middleware is registered. A trust level of 1 tells Express to read the client IP from the first `X-Forwarded-For` hop, which is set by the Azure ingress, rather than from the raw TCP connection.

---

### I3 — Cross-origin cookie problem resolved via single-origin gateway

**Problem**

The auth cookie is set with `sameSite: lax`. In development, frontend and backend both run under `localhost` so the cookie is treated as same-site and sent on every request. In a container deployment, each service gets its own domain, so the browser considers requests cross-site and the cookie is silently dropped — every authenticated API call fails.

**Fix**

The solution is to route all traffic through a single domain. Nginx (introduced in I8) acts as the gateway: it serves the frontend static files and proxies `/api/*` to the backend container, stripping the `/api` prefix before forwarding. From the browser's perspective, every request — whether loading a page or calling the API — goes to the same origin. The cookie is always same-site.

Two supporting changes flow from this:

- `secure: true` is now hardcoded in the cookie options (previously `process.env.NODE_ENV === 'production'`). Browsers treat `http://localhost` as a secure context, so this works in local dev as well as production HTTPS.
- All frontend `fetch` calls are switched from absolute URLs (`import.meta.env.VITE_API_URL`) to relative paths (`/api/...`). The `VITE_API_URL` environment variable is removed entirely, and `frontend/.env.example` is updated to reflect that no variables are currently needed.

---

### I7 — Vite and Nginx API path clash resolved

**Problem**

Vite embedded `VITE_API_URL` into the built bundle at build time. In production, nginx's CSP treats that absolute URL as a foreign origin and blocks the requests. Even if CSP were relaxed, the URL would be wrong inside a container where services communicate over an internal Docker network, not `localhost`.

**Fix**

All API calls now use the relative path `/api` as a constant, set directly in `frontend/src/services/api.js`, `Login.jsx`, `Signup.jsx`, and `AuthContext.jsx`. This path resolves against whatever origin served the page — it is correct in both dev and production without any build-time substitution.

In development, a Vite dev server proxy is added to `vite.config.js`: requests to `/api/*` are forwarded to `http://localhost:3001` with the `/api` prefix stripped, mirroring exactly what nginx does in production. This means the same relative fetch call works unchanged across both environments.

The CSP `connect-src` directive no longer needs to include an external URL — `'self'` is sufficient in both Vite's dev headers and nginx's production headers.

---

### I8 — Two-stage Docker build and nginx serving for the frontend

**Problem**

Locally the frontend is served by Vite's dev server directly from source files. That is not appropriate for a container image: Vite is a development tool, the source files include unbuilt JSX, and the dev server has no nginx-style request routing. A production container needs a compiled, optimised build served by a proper web server.

**Fix**

Three new files are introduced in `frontend/`:

**`Dockerfile`** — a two-stage build. Stage one uses `node:22-bookworm-slim` to run `npm ci` and `npm run build`, producing the compiled static files in `/app/dist`. Stage two copies only that `/dist` directory into an `nginx:1.27-alpine` image. Vite never runs in the final image. The `BACKEND_URL` environment variable defaults to `http://backend:3001` (correct for local docker-compose) and can be overridden with the Azure Container Apps internal URL at deploy time.

**`nginx.conf.template`** — nginx configuration with two responsibilities. The `location /` block serves static files from `/usr/share/nginx/html` with SPA fallback (`try_files $uri $uri/ /index.html`). The `location /api/` block proxies requests to `${BACKEND_URL}/` with the `/api` prefix stripped, sets `X-Forwarded-For` and `X-Forwarded-Proto` headers, disables response buffering, and allows 300 seconds for long-running OCR streams. Security headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) and a 10 MB body limit are set at the server level. The `${BACKEND_URL}` placeholder is substituted by `envsubst` when the container starts, using the official nginx:alpine entrypoint's template mechanism.

**`.dockerignore`** — excludes `node_modules`, `dist`, and `.env` from the build context so they are never copied into the image.

---

### Summary

| Issue | Root cause | Fix |
|---|---|---|
| I1 | Pepper in a file that can't exist in a container | Moved to env vars, validated at startup |
| I2 | Ingress proxy collapses all client IPs | `trust proxy 1` added to Express |
| I3 | Separate container domains break same-site cookies | Single-origin nginx gateway; all API calls use relative `/api` paths; `secure: true` hardcoded |
| I7 | Absolute `VITE_API_URL` baked into bundle, rejected by CSP | Removed; relative `/api` constant used everywhere; Vite proxy mirrors nginx in dev |
| I8 | Vite dev server not suitable for container deployment | Two-stage Docker build: Node builds, nginx serves; nginx config handles routing and security headers |

---

## Change 1: Application Build — Database, Authentication & Core Features

This change covers the full application build from scratch: a relational database, a secure authentication system, a classes and students management API, a mark scheme OCR pipeline, and the frontend pages that tie everything together. Each section below describes what was built and the security decisions made alongside it.

---

### 1. SQLite Database

**What was built**

Replaced a flat `users.json` file with a proper relational SQLite database using `better-sqlite3`. The schema covers seven tables: `year_groups`, `teachers`, `classes`, `students`, `lessons`, `student_files`, `student_ocr`, `teacher_ocr`, and `marking_results`. Foreign key relationships are enforced at the database level. `year_groups` is seeded with valid years (7–11) and protected by read-only triggers to prevent modification. The schema runs on boot as a side-effect import, and any existing teachers in the legacy JSON file are migrated in automatically on first start.

**Security considerations**

- `journal_mode = WAL` and `foreign_keys = ON` are set per-connection on startup — SQLite defaults both to off for backwards compatibility, so they must be set explicitly.
- All queries throughout the application use prepared statements with parameterised values. There is no string-interpolated SQL anywhere in the codebase, making SQL injection structurally impossible.
- The SQLite file is added to `.gitignore` so it is never committed to version control.
- **Least-privilege database accessors** — rather than giving each route file access to the raw database connection, three scoped accessor objects are exported from `db/index.js`: `teacherDb` (2 prepared statements covering only the teachers table), `lessonDb` (4 statements covering only the lessons and OCR tables), and `classDb` (17 statements covering only the classes, students, and related tables). Each route file imports only the accessor it needs. No route can run arbitrary SQL or touch tables outside its defined scope.

---

### 2. Authentication

**What was built**

A full token-based authentication system: `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh`, and `POST /auth/logout`. Tokens are issued as short-lived JWTs and delivered via an `httpOnly` cookie. The `authenticate` middleware verifies the cookie on all protected routes. A login attempt tracker provides account lockout after repeated failures.

**Security considerations**

- **Password storage** — passwords are pre-hashed with HMAC-SHA256 using a server-side pepper before being passed to bcrypt (cost factor 12). This means even if the bcrypt hashes leak, an attacker without the pepper cannot attempt offline cracking. bcrypt adds a per-record random salt on top.
- **Email storage** — email addresses are never stored in plaintext. They are hashed with HMAC-SHA256 using a separate pepper, making the stored value a deterministic lookup key that cannot be reversed to reveal a teacher's email.
- **JWT delivery** — tokens are set as `httpOnly` cookies, keeping them off the JavaScript heap and inaccessible to any injected script. `secure: true` is enforced in production (HTTPS only). `sameSite: lax` provides CSRF protection while allowing same-site cross-port requests in development.
- **Token expiry** — JWTs expire after 1 hour. A `/auth/refresh` endpoint allows a just-expired token to be exchanged for a fresh one without re-entering credentials, using `ignoreExpiration: true` combined with full signature verification.
- **Brute-force protection** — login attempts are tracked in memory per email address. After 5 failed attempts the account is locked for 15 minutes. The lockout check runs before any bcrypt comparison, preventing the expensive hash operation from being abused as a timing oracle.
- **Password policy** — minimum 10 characters, at least one digit, at least two special characters, maximum 72 bytes (bcrypt silently truncates beyond this), and checked against a 10,000-entry common password blacklist loaded at startup.
- **Email validation** — RFC 5321-compliant regex with a 254-character maximum. Invalid formats are rejected before any database lookup is attempted.
- **Teacher name sanitisation** — the signup name field is passed through `sanitiseString` (unicode normalisation, null-byte removal, control character stripping) before being written to the database, with a 100-character hard limit enforced in the data layer.

---

### 3. Middleware Factory Refactor (File Security & Validation)

**What was built**

The upload route originally validated two file slots (student work + mark scheme) with a single fixed middleware. The lessons route needs to validate one slot (mark scheme only). Rather than duplicate the validation logic, both middlewares were converted to factory functions: `makeFileSecurity(slots)` and `makeValidateFile(slots)`, each taking an array of slot descriptors. The existing upload route continues to use a pre-built default export.

**Security considerations**

- File MIME type is checked against an allowlist (PDF, JPEG, PNG, WEBP) using both the declared content type and a magic-byte inspection of the file buffer. A file with a `.pdf` extension but a JPEG magic byte is rejected.
- File size is capped at 5 MB per slot via multer's `limits` option, enforced before any processing begins.
- The factory pattern ensures that adding a new upload endpoint requires explicitly declaring the slots it accepts — there is no way to accidentally inherit permissive validation from another route.

---

### 4. Input Security Middleware

**What was built**

A new `inputSecurity` middleware sits between `authenticate` and the classes route handler. It runs on every state-changing request to `/classes` and inspects `req.body` before the route handler sees it.

**Security considerations**

- **Prototype pollution prevention** — the request body is recursively scanned for forbidden keys (`__proto__`, `constructor`, `prototype`). A request containing any of these is rejected with a 400 before reaching route logic.
- **Depth limit** — nested objects are rejected beyond 5 levels deep, preventing deeply nested payload attacks.
- **Array truncation** — arrays are silently truncated to 100 entries to prevent oversized bulk submissions.
- **String sanitisation** — all string values are unicode-normalised (NFC), stripped of null bytes and ASCII control characters, and have excess whitespace collapsed. This is applied recursively across the entire body object.
- **Length limit** — any individual string exceeding 500 characters is rejected. Field-specific tighter limits (100 characters for class names and student names) are enforced in the route handlers themselves, matching the database column constraints.
- **Client-side mirror** — `frontend/src/utils/sanitise.js` replicates the same sanitisation logic (`sanitiseInput`, `containsHtml`, `validatePayload`) so that invalid input is caught at the point of entry in the UI, before any API call is made. `maxLength` attributes on all text inputs enforce the same character limits in the browser.

---

### 5. Classes & Students API

**What was built**

A full CRUD API for class and student management: list classes (with student counts), create a class with a batch of students, fetch students in a class, rename a class, add a single student, rename a student, and delete a student. All endpoints sit behind `authenticate`.

**Security considerations**

- **Ownership enforcement** — every route that reads or modifies a class verifies that the class belongs to the authenticated teacher by including `teacher_id = req.user.id` in the lookup query. A teacher cannot read, rename, or delete another teacher's classes or students even if they guess a valid ID.
- **Year group validation** — class names are parsed for a year number (7–11). The extracted year is validated against the `year_groups` table, which is read-only. A class name that does not include a valid year is rejected.
- **Duplicate detection** — student names are checked for duplicates within the class before insert. On conflict the API returns a 409 with the conflicting names so the teacher can resolve them (e.g. "Andy S" vs "Andy 2").
- **Cascading delete** — deleting a student runs a transaction that removes `marking_results`, `student_ocr`, and `student_files` rows before removing the student record, so foreign key constraints are satisfied without disabling them.
- **Structured logging** — `classLogger.js` logs each class operation (start, created, students added, done, failed) to a daily-rotating log file with severity levels. Failed operations log the reason and relevant field values to support audit and debugging.

---

### 6. Lessons Route & Streaming OCR

**What was built**

`POST /lessons` accepts a mark scheme file, runs it through the Python OCR service, and writes the lesson and OCR text to the database in a single transaction. Progress is streamed back to the browser as newline-delimited JSON so the frontend can show a real-time progress bar for each OCR phase.

**Security considerations**

- **Ownership check** — before any OCR work begins, the route verifies that the submitted `classId` belongs to the authenticated teacher. An invalid or unowned class ID returns a 404 with no additional detail.
- **File security first** — the mark scheme passes through `makeFileSecurity` and `makeValidateFile` before reaching the route handler, applying the same MIME type, magic-byte, and size checks as the student work upload.
- **Transactional write** — the lesson insert, OCR text insert, and OCR link update are wrapped in a single SQLite transaction. A failure at any step rolls back all three writes, preventing partial or orphaned records.
- **Error detail scoping** — the `error` event streamed to the frontend contains only a generic message in production. The `detail` and `code` fields are populated from the AI service error shape and contain no internal stack traces or file paths.
- **Lesson title source** — the lesson title is derived server-side from the uploaded filename, not from a user-typed field. There is no free-text input on this route that requires sanitisation.
- **OCR logging** — all OCR operations are logged via `ocrLogger` (start, file info, AI dispatch, file type, dimensions, per-page, done, failed) in the same format as student-work OCR, providing a consistent audit trail across both upload paths.

---

### 7. Frontend Pages

**What was built**

Three new pages: **Home** (class selection, mark scheme upload, NDJSON-driven progress bar, navigation to the marking screen), **Create/Manage Class** (tabbed view — create a class with batch student entry or paste import; manage existing classes with inline rename, add, and delete), and **Student Marking** (lesson context display, student list placeholder). React Router provides protected routes (redirect to `/login` if unauthenticated) and public routes (redirect to `/` if already authenticated).

**Security considerations**

- **XSS** — all user-supplied content displayed in the UI passes through React's JSX rendering, which HTML-escapes values by default. There is no use of `dangerouslySetInnerHTML` anywhere in the application.
- **Client-side input controls (CreateClass)** — all text inputs have `maxLength` attributes matching the backend limits. On submission, `sanitiseInput` is applied to every value, `containsHtml` blocks `<` and `>` characters with an inline error, and `validatePayload` checks the full payload object for prototype pollution before the API call is made. Paste imports are sanitised per-entry and truncated to the 100-student maximum.
- **Token handling** — the JWT is stored in an `httpOnly` cookie managed by the browser; the frontend never reads or stores it. API calls do not manually attach an `Authorization` header — the cookie is sent automatically on same-site requests.
- **Authentication state** — `AuthContext` initialises from a `/auth/refresh` call on mount rather than from `localStorage`, so the session source of truth is always the server-issued cookie rather than a client-stored value.

---

### Summary of Security Controls by Layer

| Layer | Control |
|---|---|
| Database | Parameterised queries, least-privilege accessors, FK constraints, WAL mode, sqlite file gitignored |
| Auth | bcrypt + pepper, HMAC email hash, httpOnly+sameSite cookie, JWT 1h expiry, rate limiting, password blacklist |
| Middleware | inputSecurity (prototype pollution, depth, array, string), file security (MIME + magic byte + size) |
| Route handlers | Ownership checks on every class/student operation, year validation, duplicate detection |
| Frontend | React JSX escaping, sanitiseInput + containsHtml + validatePayload before API calls, maxLength on all inputs |
