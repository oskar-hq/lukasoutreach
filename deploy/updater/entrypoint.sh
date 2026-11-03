#!/bin/sh
# Start des Update-Dienstes. Arbeitsverzeichnis = Projektordner (gleicher Pfad wie auf dem Server).
# git läuft als Besitzer des Projektordners, damit keine Dateien root gehören; seine Zugangsdaten (SSH-Schlüssel,
# .gitconfig, .git-credentials) kommen read-only aus dem Home-Verzeichnis des Servers (/hosthome).
set -eu

OWNER_UID=$(stat -c %u .)
OWNER_GID=$(stat -c %g .)

if [ "$OWNER_UID" = "0" ]; then
  # Projekt gehört root: Zugangsdaten nach /root verlinken (ssh liest ~/.ssh aus dem Benutzerkonto, nicht aus $HOME).
  for item in .ssh .gitconfig .git-credentials; do
    if [ -e "/hosthome/$item" ] && [ ! -e "/root/$item" ]; then ln -s "/hosthome/$item" "/root/$item"; fi
  done
  export GIT_UID=0 GIT_GID=0 GIT_HOME=/root
else
  # Benutzer mit der uid des Besitzers anlegen (einmal je Container), Home = /hosthome.
  if ! getent passwd "$OWNER_UID" >/dev/null 2>&1; then
    adduser -D -H -u "$OWNER_UID" -h /hosthome -s /bin/sh hostuser
  fi
  export GIT_UID="$OWNER_UID" GIT_GID="$OWNER_GID" GIT_HOME=/hosthome
fi

exec node /app/server.mjs
