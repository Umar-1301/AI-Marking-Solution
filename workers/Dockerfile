FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

# The worker's package manifest lives in package/ locally. Place it at the
# image root so Node treats server.js and its imports as ES modules.
COPY package/package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node index.js markingWorker.js server.js ./
COPY --chown=node:node SQL ./SQL
COPY --chown=node:node config ./config
COPY --chown=node:node blob ./blob
COPY --chown=node:node logging ./logging
COPY --chown=node:node public ./public
COPY --chown=node:node services ./services
COPY --chown=node:node utils ./utils

RUN mkdir -p logs && chown node:node logs

USER node

EXPOSE 4000
CMD ["node", "server.js"]
