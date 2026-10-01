variable "project_id" {
  type        = string
  description = "GCP project ID to deploy into."
}

variable "region" {
  type        = string
  description = "Region for Artifact Registry and Cloud Run."
  default     = "us-central1"
}

variable "wif_pool" {
  type        = string
  description = "Full resource name of the shared deploy Workload Identity pool, which lives in the tools project and serves every environment: projects/<number>/locations/global/workloadIdentityPools/<prefix>-deploy-github. scripts/bootstrap-tools.sh prints it. No default: it anchors deploy-credential trust."
}

variable "github_environment" {
  type        = string
  description = "GitHub Environment whose deploy job may impersonate the deployer SA. The shared provider pins the repository; this pins the environment on the binding, so a dev deploy can never mint a prod credential."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*$", var.github_environment))
    error_message = "github_environment must be a lowercase GitHub Environment name, such as dev or prod."
  }
}

variable "service_name" {
  type        = string
  description = "Cloud Run service name, and the prefix of both service accounts. Load-bearing: changing it replaces the service and the accounts."
  default     = "mcp-server"
}

variable "artifact_registry_repo" {
  type        = string
  description = "Artifact Registry Docker repository ID."
  default     = "mcp-server"
}

variable "cloud_run_ingress" {
  type        = string
  description = "Who may reach the Cloud Run service directly. INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER (the default) admits only a load balancer — apply ../gateway or the service is unreachable (it fails closed, never silently public). INGRESS_TRAFFIC_ALL makes the run.app URL publicly reachable, protected by the application's OAuth layer alone; set it when you delete ../gateway."
  default     = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  validation {
    condition = contains([
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      "INGRESS_TRAFFIC_ALL",
    ], var.cloud_run_ingress)
    error_message = "cloud_run_ingress must be INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER or INGRESS_TRAFFIC_ALL."
  }
}

variable "image_reader_service_accounts" {
  type        = list(string)
  description = "Service account emails granted read on this environment's image repository: in dev, prod's deployer SA, so a promotion can copy the image dev already ran. Empty until the environment that promotes from this one exists."
  default     = []

  validation {
    condition     = alltrue([for sa in var.image_reader_service_accounts : can(regex("^[^@\\s]+@[^@\\s]+\\.iam\\.gserviceaccount\\.com$", sa))])
    error_message = "Each entry must be a service account email (…@….iam.gserviceaccount.com)."
  }
}
