#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4173}"

cd "$ROOT_DIR"
exec perl "$ROOT_DIR/server.pl" "$PORT"
