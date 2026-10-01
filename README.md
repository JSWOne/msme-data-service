# msme-data-service

A read-only REST API for internal services. It serves three MSME analytics tables from the Cloud SQL Postgres database `bq_to_pg` and runs on **Cloud Run**. Jenkins builds and deploys it.

| Branch        | Environment | GCP project        | Cloud SQL instance                    |
| ------------- | ----------- | ------------------ | ------------------------------------- |
| `release/gke` | QA          | `jswone-qa-356112` | `jswone-qa-356112:asia-south1:ccp-qa` |
| `preprod/gke` | Preprod     | TODO               | TODO                                  |
| `master/gke`  | Prod        | TODO               | TODO                                  |

Stack: Node 20, TypeScript, Fastify, `pg`, Zod, Vitest.

## API

Every `/v1/*` request needs the header `x-api-key: <key>`. The `/healthz` (liveness) and `/readyz` (checks the DB) endpoints don't need a key.

| Endpoint                              | Table                                          |
| ------------------------------------- | ---------------------------------------------- |
| `GET /v1/dealer-month-activity`       | `public.fct_dealer_month_activity_table`       |
| `GET /v1/high-potential-taluka-month` | `public.fct_high_potential_taluka_month_table` |
| `GET /v1/user-month-summary`          | `public.fct_user_month_summary_table`          |
| `GET /v1/<endpoint>/columns`          | Lists the table's columns and their types      |

### Query parameters

| Param               | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `limit`             | Page size. Default 100, max 1000.                                              |
| `offset`            | Rows to skip. Default 0, max 100000.                                           |
| `sort` / `order`    | A column to sort by, and `asc` (default) or `desc`. Default: the first column. |
| `<column>=v`        | Column equals `v`.                                                             |
| `<column>.gte=v`    | Column is ≥ `v`.                                                               |
| `<column>.lte=v`    | Column is ≤ `v`.                                                               |
| `<column>.in=a,b,c` | Column is any of the listed values (max 100).                                  |

The service reads the allowed column names from `information_schema` and caches them for 10 minutes. A column added to a table becomes filterable without a code change. An unknown column or operator returns `400`.

```bash
curl -H "x-api-key: $KEY" \
  "$URL/v1/dealer-month-activity?limit=50&offset=0&sort=month&order=desc&month.gte=2024-01-01"
```

```json
{
  "data": [{ "...": "row" }],
  "pagination": { "limit": 50, "offset": 0, "count": 50, "hasMore": true }
}
```

Notes:

- Results are sorted on every column, so moving through pages with `offset` never skips or repeats a row.
- `numeric` and `bigint` values come back as strings, so they don't lose precision.
- `date` values come back as `YYYY-MM-DD`.

| Status | When                                                       |
| ------ | ---------------------------------------------------------- |
| 400    | Bad parameter, or a value of the wrong type for the column |
| 401    | Missing or invalid API key                                 |
| 503    | Database unreachable                                       |
| 504    | Query took longer than `STATEMENT_TIMEOUT_MS`              |

## Security

- Column names are only accepted if they're in the whitelist, and are quoted in the SQL. Every value is sent as a bind parameter.
- Defence in depth: the DB user is read-only, and every session also sets `default_transaction_read_only=on`.
- API keys are compared in constant time. `API_KEYS` takes a comma-separated list, so you can add a new key, move callers over, then remove the old one.
- The container runs as a non-root user on a distroless image. Secrets come only from Secret Manager.

## Local development

```bash
cp .env.example .env              # add the QA DB user/password and an API key
cloud-sql-proxy jswone-qa-356112:asia-south1:ccp-qa --port 5433   # needs roles/cloudsql.client
npm ci
npm run dev                       # http://localhost:8080
npm test                          # unit and route tests (no DB needed)
npm run lint && npm run typecheck && npm run build
```

## How the database connection works

Cloud Run starts with `--add-cloudsql-instances <conn>`, which runs the **Cloud SQL Auth Proxy**. The proxy uses the service account's IAM role (`roles/cloudsql.client`) to open a connection to the instance's public IP and exposes it to the app as the socket `/cloudsql/<conn>`. The app then logs in to Postgres with the existing **DB username and password**, which come from Secret Manager.

## One-time GCP setup (run once per environment)

```bash
PROJECT=jswone-qa-356112          # or the preprod / prod project
REGION=asia-south1
AR_REPO=<artifact-registry-repo>  # must match AR_REPO in deploy/env/<env>.env
SA=msme-data-service@${PROJECT}.iam.gserviceaccount.com
DEPLOYER=<jenkins-deployer-sa>@${PROJECT}.iam.gserviceaccount.com

gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com --project $PROJECT

# Service account the Cloud Run service runs as
gcloud iam service-accounts create msme-data-service --project $PROJECT
gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$SA" --role roles/cloudsql.client

# Secrets (the read-only DB user already exists)
printf '%s' '<db-user>'     | gcloud secrets create msme-db-user     --data-file=- --project $PROJECT
printf '%s' '<db-password>' | gcloud secrets create msme-db-password --data-file=- --project $PROJECT
printf '%s' "$(openssl rand -hex 32)" | gcloud secrets create msme-api-keys --data-file=- --project $PROJECT
for s in msme-db-user msme-db-password msme-api-keys; do
  gcloud secrets add-iam-policy-binding $s --project $PROJECT \
    --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor
done

# Image registry (skip if a repo already exists)
gcloud artifacts repositories create $AR_REPO --repository-format docker \
  --location $REGION --project $PROJECT

# Permissions for the Jenkins deployer account
gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$DEPLOYER" --role roles/run.admin
gcloud projects add-iam-policy-binding $PROJECT --member "serviceAccount:$DEPLOYER" --role roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding $SA --project $PROJECT \
  --member "serviceAccount:$DEPLOYER" --role roles/iam.serviceAccountUser
```

If the read-only DB user doesn't have SELECT on the tables yet:

```sql
GRANT USAGE ON SCHEMA public TO <db-user>;
GRANT SELECT ON public.fct_dealer_month_activity_table,
                public.fct_high_potential_taluka_month_table,
                public.fct_user_month_summary_table TO <db-user>;
```

## CI/CD (Jenkins)

- Set up a **Multibranch Pipeline** that uses the `Jenkinsfile`.
- Each environment needs a Jenkins "Secret file" credential holding the deployer service account's JSON key: `gcp-sa-qa`, `gcp-sa-preprod`, `gcp-sa-prod`.
- Build agents need Node 20, Docker, the gcloud CLI and curl. Trivy is optional; if it's installed, the image is scanned.

Pipeline: install → lint, typecheck, test → build → docker build → image scan → (Prod only: manual approval) → push to Artifact Registry → `gcloud run deploy` → smoke test of `/healthz` and `/readyz`.

Per-environment Cloud Run settings live in `deploy/env/<env>.env`: project, instance, scaling, ingress and secret names. You can also deploy by hand:

```bash
docker build -t msme-data-service:$(git rev-parse --short=12 HEAD) .
bash deploy/deploy.sh qa $(git rev-parse --short=12 HEAD)
```

The deploy script stops with an error if any required value in the env file still contains `TODO`.

## Configuration

| Variable                   | Default  | Notes                                                                                         |
| -------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `INSTANCE_CONNECTION_NAME` | –        | Used on Cloud Run; connects through `/cloudsql/<conn>`                                        |
| `DB_HOST` / `DB_PORT`      | – / 5432 | Used locally (proxy on 127.0.0.1)                                                             |
| `DB_NAME`                  | –        | `bq_to_pg`                                                                                    |
| `DB_USER` / `DB_PASSWORD`  | –        | From Secret Manager                                                                           |
| `API_KEYS`                 | –        | Comma-separated list from Secret Manager, each ≥ 16 characters                                |
| `POOL_MAX`                 | 5        | DB connections per instance. Keep `max-instances × POOL_MAX` below the DB's connection limit. |
| `STATEMENT_TIMEOUT_MS`     | 10000    | Longest a single query may run                                                                |
| `SCHEMA_CACHE_TTL_MS`      | 600000   | How long the column whitelist is cached                                                       |
| `LOG_LEVEL`                | info     | Logs are JSON with `severity`, in the format Cloud Logging reads                              |
