#!/usr/bin/env bash
# Oversight one-command installer: generate secrets + bring the stack up.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose)."; exit 1; }

rand() { # 32-byte hex; openssl if present, else /dev/urandom
  if command -v openssl >/dev/null; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ ! -f .env ]; then
  echo "Generating .env with fresh secrets..."
  cp .env.example .env
  JWT="$(rand)"; PGPW="$(rand | cut -c1-24)"; SEEDPW="$(rand | cut -c1-16)"
  # portable in-place sed (GNU + BSD)
  sedi() { if sed --version >/dev/null 2>&1; then sed -i "$1" .env; else sed -i '' "$1" .env; fi; }
  sedi "s|^JWT_SECRET=.*|JWT_SECRET=${JWT}|"
  sedi "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PGPW}|"
  sedi "s|^DATABASE_URL=.*|DATABASE_URL=postgres://vms:${PGPW}@postgres:5432/vms|"
  sedi "s|^SEED_PASS=.*|SEED_PASS=${SEEDPW}|"
  echo "  JWT_SECRET, POSTGRES_PASSWORD, SEED_PASS generated. VAPID left empty (run 'make vapid' to enable web push)."
else
  echo ".env already exists — leaving it untouched."
  SEEDPW="$(grep -E '^SEED_PASS=' .env | cut -d= -f2- || true)"
fi

echo "Building + starting the stack..."
docker compose up -d --build

echo ""
echo "Oversight is up:  http://localhost:3000"
echo "Login:            demo / ${SEEDPW:-<see SEED_PASS in .env>}"
echo "For LAN/remote access, set APP_URL + PUBLIC_API_URL in .env and re-run 'make up'."
