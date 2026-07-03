#!/usr/bin/env bash
# Provision the e2e services started by docker-compose.test.yml: assign the
# Garage cluster layout, import a fixed test key, create the S3 and GCS test
# buckets. Idempotent — safe to re-run. Normally invoked via `npm run test:e2e:up`.
set -euo pipefail
cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f docker-compose.test.yml"
garage() { $COMPOSE exec -T garage /garage "$@"; }

# Fixed throwaway test credentials — must match the defaults in test/s3.test.ts.
S3_ACCESS_KEY="GK31c2f218a2e44f485b94239e"
S3_SECRET_KEY="0f2b5f2e1c4a4d5e8a7b6c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b"
BUCKET="agentcomm-test"
GCS_ENDPOINT="http://127.0.0.1:4443"

# --- Garage (S3) ---
for _ in $(seq 1 30); do
  garage status >/dev/null 2>&1 && break
  sleep 1
done

if garage status | grep -q "NO ROLE ASSIGNED"; then
  NODE_ID=$(garage node id -q | cut -d@ -f1)
  garage layout assign -z dc1 -c 1G "$NODE_ID"
  garage layout apply --version 1
fi

if ! garage key info "$S3_ACCESS_KEY" >/dev/null 2>&1; then
  garage key import --yes -n agentcomm-test "$S3_ACCESS_KEY" "$S3_SECRET_KEY"
fi

garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"
garage bucket allow --read --write "$BUCKET" --key "$S3_ACCESS_KEY" >/dev/null

# --- fake-gcs-server (GCS) ---
for _ in $(seq 1 30); do
  curl -sf "$GCS_ENDPOINT/storage/v1/b?project=test" >/dev/null && break
  sleep 1
done
# 409 when the bucket already exists — fine.
curl -s -o /dev/null -X POST "$GCS_ENDPOINT/storage/v1/b?project=test" \
  -H 'Content-Type: application/json' -d "{\"name\":\"$BUCKET\"}"

echo "e2e services ready:"
echo "  s3        http://127.0.0.1:3900  bucket=$BUCKET (Garage)"
echo "  gcs       $GCS_ENDPOINT  bucket=$BUCKET (fake-gcs-server)"
echo "  postgres  postgresql://postgres:test@localhost:55432/agentcomm"
