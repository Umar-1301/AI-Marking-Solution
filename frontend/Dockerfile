# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve ----
FROM nginx:1.27-alpine

# Default for local docker-compose testing — override with the backend
# Container App's internal URL when deploying to Azure.
ENV BACKEND_URL=http://backend:3001

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

# Sourced by the nginx entrypoint before envsubst — exports NGINX_RESOLVER and
# BACKEND_HOST for the runtime-DNS proxy_pass in the template. Must be
# executable, or the entrypoint silently skips it.
COPY --chmod=0755 docker-entrypoint.d/15-resolver.envsh /docker-entrypoint.d/15-resolver.envsh

EXPOSE 80
