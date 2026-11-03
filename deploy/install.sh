#!/usr/bin/env bash
# Ersteinrichtung auf einem frischen VPS (z. B. Hostinger, Ubuntu) – einmal im Projektordner ausführen:
#
#   bash deploy/install.sh lukas.ylvalabs.de
#
# Macht: Docker + Firewall (nur SSH, HTTP, HTTPS), .env anlegen (Domain, Einladungslinks, Frontend nur intern),
# alles mit Caddy (HTTPS) starten und den Einrichtungs-Link für das erste Konto ausgeben. Alles Weitere (Schlüssel für
# Unipile, Anthropic …, Konten, Updates) läuft danach in der Oberfläche. Mehrfach ausführen schadet nicht.
set -euo pipefail

DOMAIN="${1:-lukas.ylvalabs.de}"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ] && ! groups | grep -qw docker; then
  echo "Bitte als root ausführen (oder als Benutzer in der Docker-Gruppe)." >&2
  exit 1
fi

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
else
  echo "schon installiert: $(docker --version)"
fi

say "Firewall (nur SSH, HTTP, HTTPS)"
if command -v ufw >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443 >/dev/null
  ufw --force enable >/dev/null
  ufw status | head -n 8
else
  echo "ufw nicht gefunden oder kein root – übersprungen."
fi

say "Konfiguration (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo ".env aus .env.example angelegt."
fi
# Wert setzen: vorhandene (auch auskommentierte) Zeile ersetzen, sonst anhängen.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^#?${key}=" .env; then
    sed -i -E "0,/^#?${key}=.*/s##${key}=${value}#" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
set_env SITE_ADDRESS "$DOMAIN"
set_env PUBLIC_URL "https://$DOMAIN"
set_env WEB_BIND "127.0.0.1:8080"
set_env AUTH_COOKIE_SECURE "true"
grep -E '^(SITE_ADDRESS|PUBLIC_URL|WEB_BIND)=' .env

say "DNS prüfen"
SERVER_IP="$(curl -fsS4 https://api.ipify.org 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1{print $1}' || true)"
echo "Server-IP: ${SERVER_IP:-unbekannt} · $DOMAIN zeigt auf: ${DNS_IP:-noch nichts}"
if [ -n "$SERVER_IP" ] && [ "$SERVER_IP" != "$DNS_IP" ]; then
  echo "⚠  Der DNS-Eintrag zeigt (noch) nicht auf diesen Server. Caddy holt das HTTPS-Zertifikat, sobald er stimmt –"
  echo "   ggf. danach einmal: docker compose --profile public restart caddy"
fi

say "Starten (erster Build dauert ein paar Minuten)"
docker compose --profile public up -d --build

say "Einrichtungs-Link für das erste Konto"
for _ in $(seq 1 30); do
  LINK="$(docker compose logs backend 2>/dev/null | grep -o 'https\?://[^ "]*registrieren#setup=[A-Za-z0-9_-]*' | tail -n 1 || true)"
  [ -n "$LINK" ] && break
  sleep 2
done
if [ -n "${LINK:-}" ]; then
  echo "Im Browser öffnen und das Gründer-Konto anlegen:"
  echo
  echo "  $LINK"
else
  echo "Noch nicht im Protokoll – gleich noch einmal nachsehen mit:"
  echo "  docker compose logs backend | grep Einrichtung"
fi
echo
echo "Fertig. Weiter in der Oberfläche: https://$DOMAIN"
