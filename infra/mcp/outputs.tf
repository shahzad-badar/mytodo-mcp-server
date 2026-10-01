output "deploy_service_account" {
  description = "Deployer SA email -> the environment's GitHub secret GCP_SERVICE_ACCOUNT."
  value       = google_service_account.deployer.email
}

output "runtime_service_account" {
  description = "Runtime SA the Cloud Run service runs as. Grant it access to a data store here, when you add one."
  value       = google_service_account.runtime.email
}

output "artifact_registry_repo" {
  description = "Artifact Registry repository -> the environment's GitHub variable GCP_ARTIFACT_REGISTRY_REPO."
  value       = google_artifact_registry_repository.images.repository_id
}

output "region" {
  description = "Cloud Run region -> the environment's GitHub variable GCP_REGION."
  value       = var.region
}

output "cloud_run_service" {
  description = "Cloud Run service name -> the environment's GitHub variable CLOUD_RUN_SERVICE, and service_name in ../gateway and ../monitoring."
  value       = google_cloud_run_v2_service.app.name
}

output "image_repository" {
  description = "Image path without a tag. In dev, this is prod's GitHub variable PROMOTE_SOURCE_IMAGE."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}/${google_cloud_run_v2_service.app.name}"
}
