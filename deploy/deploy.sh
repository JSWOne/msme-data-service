#!/usr/bin/env bash
# Push a locally built image and deploy it to Cloud Run.
#   usage: deploy/deploy.sh <qa|preprod|prod> <image-tag>
# Expects the image msme-data-service:<image-tag> to exist locally (docker build).
# If GOOGLE_APPLICATION_CREDENTIALS points at a service-account key, it is used for auth.
set -euo pipefail

ENV_NAME="${1:?usage: deploy.sh <qa|preprod|prod> <image-tag>}"
IMAGE_TAG="${2:?usage: deploy.sh <qa|preprod|prod> <image-tag>}"
SERVICE_NAME=msme-data-service
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/env/$ENV_NAME.env"

[[ -f "$ENV_FILE" ]] || { echo "ERROR: no env file $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

for v in GCP_PROJECT REGION INSTANCE_CONNECTION_NAME DB_NAME AR_REPO SERVICE_ACCOUNT \
         SECRET_DB_USER SECRET_DB_PASSWORD SECRET_API_KEYS; do
  if [[ -z "${!v:-}" || "${!v}" == *TODO* ]]; then
    echo "ERROR: $v is not set in $ENV_FILE" >&2
    exit 1
  fi
done

# Isolate gcloud auth to this run (important on shared Jenkins agents).
export CLOUDSDK_CONFIG="$(mktemp -d)"
trap 'rm -rf "$CLOUDSDK_CONFIG"' EXIT
if [[ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]]; then
  gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS" --quiet
fi
gcloud config set project "$GCP_PROJECT" --quiet

REGISTRY="${REGION}-docker.pkg.dev"
IMAGE="${REGISTRY}/${GCP_PROJECT}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

echo "==> Pushing $IMAGE"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY}"
docker tag "${SERVICE_NAME}:${IMAGE_TAG}" "$IMAGE"
docker push "$IMAGE"

echo "==> Deploying $SERVICE_NAME to Cloud Run ($ENV_NAME / $GCP_PROJECT)"
gcloud run deploy "$SERVICE_NAME" \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT" \
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME" \
  --set-env-vars "APP_ENV=${APP_ENV},INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME},DB_NAME=${DB_NAME},LOG_LEVEL=${LOG_LEVEL},POOL_MAX=${POOL_MAX},STATEMENT_TIMEOUT_MS=${STATEMENT_TIMEOUT_MS},BASE_PATH=${BASE_PATH:-}" \
  --set-secrets "DB_USER=${SECRET_DB_USER}:latest,DB_PASSWORD=${SECRET_DB_PASSWORD}:latest,API_KEYS=${SECRET_API_KEYS}:latest" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances "$MAX_INSTANCES" \
  --concurrency "$CONCURRENCY" \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --timeout 60 \
  --ingress "$INGRESS" \
  --allow-unauthenticated \
  --labels "app=${SERVICE_NAME},env=${ENV_NAME}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE_NAME" --project "$GCP_PROJECT" --region "$REGION" --format 'value(status.url)')"
echo "==> Deployed: $URL"

if [[ "${SMOKE_TEST:-true}" == "true" ]]; then
  echo "==> Smoke test"
  for path in /healthz /readyz; do
    ok=false
    for _ in 1 2 3 4 5 6; do
      if curl -fsS --max-time 10 "${URL}${BASE_PATH:-}${path}"; then ok=true; echo; break; fi
      sleep 5
    done
    $ok || { echo "ERROR: smoke test failed for ${path}" >&2; exit 1; }
  done
fi
