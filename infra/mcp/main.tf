# Roots pass values to each other as variables and never read another root's state.
# The shared Workload Identity pool lives in the tools project (var.wif_pool).

terraform {
  required_version = ">= 1.5"
  # A backend block cannot read a variable, so the bucket is left out on purpose.
  # Every init must pass -backend-config="bucket=<prefix>-<env>-tfstate" or it fails.
  backend "gcs" {
    prefix = "mcp"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "required" {
  for_each = toset([
    "iam.googleapis.com",
    "sts.googleapis.com",
    "iamcredentials.googleapis.com",
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}


resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = var.artifact_registry_repo
  format        = "DOCKER"
  depends_on    = [google_project_service.required]
}

resource "google_service_account" "deployer" {
  account_id   = "${var.service_name}-deployer"
  display_name = "Deployer for ${var.service_name} (GitHub Actions via WIF)"
}


resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-runtime"
  display_name = "Runtime identity for ${var.service_name}"
}


resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# Another environment's deployer copies images from this repository on promote.
# Terraform holds this grant so a plan shows any change to it.
resource "google_artifact_registry_repository_iam_member" "image_readers" {
  for_each   = toset(var.image_reader_service_accounts)
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${each.value}"
}


resource "google_cloud_run_v2_service_iam_member" "deployer_run_admin" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.admin"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# The grant covers the runtime SA only, not the whole project.
resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  service_account_id = google_service_account.runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}

# The shared pool serves every environment, so this binding pins the GitHub Environment.
# A dev deploy therefore cannot obtain a prod credential.
resource "google_service_account_iam_member" "wif_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${var.wif_pool}/attribute.environment/${var.github_environment}"
}


resource "google_cloud_run_v2_service" "app" {
  name     = var.service_name
  location = var.region
  ingress  = var.cloud_run_ingress

  template {
    service_account = google_service_account.runtime.email
    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello"
    }
  }

  # The deploy workflow sets the image and env vars, so Terraform ignores them.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      template[0].containers[0].env,
      template[0].labels,
      scaling,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.required]
}
