#!/usr/bin/env bash
# Installe un .ipa signé sur l'iPhone connecté en USB, depuis Linux.
#
# Ne peut rien pour un paquet non signé : iOS refuse d'installer une
# application dont la signature ne couvre pas l'UDID de l'appareil. Le message
# d'erreur d'Apple étant peu explicite, on vérifie ce qui peut l'être avant.
set -euo pipefail

IPA=${1:-}
if [ -z "$IPA" ] || [ ! -f "$IPA" ]; then
  echo "usage : $0 <chemin/vers/App.ipa>" >&2
  exit 2
fi

if ! command -v ideviceinstaller >/dev/null; then
  echo "ideviceinstaller absent. Installez-le : sudo pacman -S ideviceinstaller" >&2
  exit 3
fi

UDID=$(idevice_id -l | head -1)
if [ -z "$UDID" ]; then
  echo "Aucun iPhone détecté. Branchez-le et déverrouillez-le." >&2
  exit 4
fi

echo "Appareil    : $UDID"
echo "Application : $(ideviceinfo -k DeviceName 2>/dev/null || echo '?')"

# Le mode développeur est requis pour exécuter une application de développement.
MODE=$(idevicedevmodectl list 2>/dev/null | awk -v u="$UDID" '$1==u {print $2}')
if [ "$MODE" != "enabled" ]; then
  echo "Attention : mode développeur « ${MODE:-inconnu} »." >&2
  echo "  Réglages → Confidentialité et sécurité → Mode développeur" >&2
fi

ideviceinstaller --udid "$UDID" --install "$IPA"
echo "Installé."
