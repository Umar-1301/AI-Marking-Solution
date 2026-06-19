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

EXPOSE 80
