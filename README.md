# Initiative Advisor

A Node.js web app that pulls creator program data from BigQuery and surfaces initiative recommendations.

## Local Development

```bash
npm install
node server.js
# Open http://localhost:3000
```

## Deploy to Google Cloud Run

### Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and authenticated
- A GCP project with the following APIs enabled:
  - Cloud Run
  - Cloud Build
  - Artifact Registry (or Container Registry)
  - BigQuery

### 1. Set your project

```bash
gcloud config set project YOUR_PROJECT_ID
```

### 2. Grant BigQuery access to the Cloud Run service account

Cloud Run uses the default compute service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`).
Grant it BigQuery Data Viewer and Job User roles:

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/bigquery.dataViewer"

gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/bigquery.jobUser"
```

### 3. Build and deploy

```bash
gcloud run deploy initiative-advisor \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --platform managed
```

Cloud Build will automatically build the Docker image and deploy it. On success, a URL will be printed.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port the server listens on (set automatically by Cloud Run) |
