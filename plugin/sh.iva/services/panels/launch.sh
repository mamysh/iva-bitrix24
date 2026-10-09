#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PLUGIN_DATA:?PLUGIN_DATA required}"
command -v flock >/dev/null || { echo 'Bitrix24 Panels service requires flock' >&2; exit 1; }
mkdir -p "$PLUGIN_DATA"
exec flock --nonblock --no-fork "$PLUGIN_DATA/panels-service.lock" node server.mjs
