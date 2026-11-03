# syntax=docker/dockerfile:1
# Build-Kontext ist das Repo-Wurzelverzeichnis (wegen shared/), siehe docker-compose.yml.

# ── Stufe 1: TypeScript bauen ────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /app/shared
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev

# ── Stufe 2: schlanke Laufzeit ───────────────────────────────
FROM node:22-alpine
# node:sqlite gilt in Node 22 noch als experimentell – die Warnung bei jedem Start (auch beim Konten-Befehl) ausblenden
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DATA_DIR=/app/server/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app/server
COPY --from=build /app/server/package.json ./
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
# Datenordner (Tracking-Liste, Datenbank cockpit.db) – als Docker-Volume eingebunden, gehört dem Benutzer node
RUN mkdir -p /app/server/data && chown node:node /app/server/data
USER node
# Stand, mit dem gebaut wurde (Build-Argumente aus docker-compose.yml, gesetzt vom Update-Dienst; sonst leer).
# Am Ende, damit ein neuer Commit den Cache der Schichten davor nicht verwirft.
ARG APP_COMMIT=""
ARG APP_COMMIT_TITLE=""
ARG APP_COMMIT_DATE=""
ENV APP_COMMIT=$APP_COMMIT APP_COMMIT_TITLE=$APP_COMMIT_TITLE APP_COMMIT_DATE=$APP_COMMIT_DATE
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
CMD ["node", "dist/server/src/index.js"]
