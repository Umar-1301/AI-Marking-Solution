# ---- Backend (Node/Express API) — Azure Container Apps image ----
# A plain long-running Node server: it runs the same `node src/server.js` in dev
# and prod, so unlike the frontend it needs no build step or restructuring —
# this image just packages it. All wiring (port, frontend origin, AI service URL,
# secrets) comes from environment variables at deploy time, never baked in.
#
# Deploy with INTERNAL ingress: only the frontend's nginx (same Container Apps
# environment) calls it, proxying /api/* to it. The browser never reaches it
# directly, so it does not need to be public.

# ---- build stage: install deps (compiles native addons if no prebuilt exists) ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for native modules — better-sqlite3, bcrypt and sharp are C/C++
# addons. They usually fetch prebuilt linux/amd64 binaries, but these are here
# as a fallback so the build can compile from source if a prebuilt is missing.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage: lean image, no compilers shipped ----
FROM node:22-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001

# Native binaries were built against this same base/arch in the build stage, so
# copying node_modules across is safe. --chown hands ownership to the non-root
# runtime user so it can read everything it needs.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src

# I4 short-term fix: guarantee the SQLite directory exists so better-sqlite3 can
# create a fresh aimira.sqlite on first boot — schema.js then builds every table
# via CREATE TABLE IF NOT EXISTS. The app is self-seeding; no .sqlite file is
# copied in (the .dockerignore excludes the local one). The logs dir is for
# winston-daily-rotate-file. Both are owned by the non-root user that writes them.
#
# ⚠️ Container storage is EPHEMERAL: data written here is lost on restart/redeploy
# and is NOT shared across replicas. Run a single replica for now. PostgreSQL is
# the persistent, multi-replica long-term fix.
RUN mkdir -p src/data logs && chown -R node:node src/data logs

# Drop root — the server only needs to listen on a port and write under /app.
USER node

EXPOSE 3001
CMD ["node", "src/server.js"]
