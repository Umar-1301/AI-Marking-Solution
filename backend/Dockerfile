# ---- Backend (Node/Express API) — Azure Container Apps image ----
# A plain long-running Node server: it runs the same `node src/server.js` in dev
# and prod, so unlike the frontend it needs no build step or restructuring —
# this image just packages it. All wiring comes from environment variables at
# deploy time, never baked in:
#   - Non-secret: SQL_SERVER, SQL_DATABASE, FRONTEND_URL, AI_SERVICE_URL, PORT
#   - Secret (from Key Vault): JWT_SECRET, PASSWORD_PEPPER, EMAIL_PEPPER
# The Azure SQL database needs NO secret at all: the container authenticates with
# its Entra managed identity, resolved at runtime by @azure/identity's
# DefaultAzureCredential — so there is no DB password or connection string to
# store, rotate, or leak.
#
# Deploy with INTERNAL ingress: only the frontend's nginx (same Container Apps
# environment) calls it, proxying /api/* to it. The browser never reaches it
# directly, so it does not need to be public.

# ---- build stage: install deps (compiles native addons if no prebuilt exists) ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for native modules — only bcrypt and sharp are C/C++ addons; the
# data layer (mssql + tedious + @azure/identity) is pure JavaScript. They usually
# fetch prebuilt linux/amd64 binaries, but this toolchain is here as a fallback
# so the build can compile from source if a prebuilt is missing.
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

# Logs dir for winston-daily-rotate-file, owned by the non-root runtime user.
# (No SQLite directory anymore — data lives in Azure SQL, an external service,
# so backend storage is stateless and the app can run multiple replicas.)
RUN mkdir -p logs && chown -R node:node logs

# Drop root — the server only needs to listen on a port and write under /app.
USER node

EXPOSE 3001
CMD ["node", "src/server.js"]
