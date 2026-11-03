# syntax=docker/dockerfile:1
# Update-Dienst (Vertrag shared/system.ts → „Updates“): holt neue Versionen per git und baut die Software mit
# docker compose neu. Build-Kontext ist dieser Ordner, siehe docker-compose.yml → updater.
FROM node:22-alpine
# Das Repo gehört dem Benutzer des Servers, nicht dem Container → safe.directory.
# uid 1000 ist oft der Benutzer des Servers – das Abbild braucht den Benutzer „node“ nicht.
RUN apk add --no-cache git openssh-client docker-cli docker-cli-buildx docker-cli-compose \
  && git config --system --add safe.directory '*' \
  && deluser --remove-home node
WORKDIR /app
COPY server.mjs entrypoint.sh ./
RUN chmod +x /app/entrypoint.sh
# Kein EXPOSE und kein Port nach außen: nur im internen Docker-Netz erreichbar (Port 8790).
ENTRYPOINT ["/app/entrypoint.sh"]
