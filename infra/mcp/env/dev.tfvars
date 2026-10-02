# This file sets the dev inputs of the MCP server root. All values are public.
# CI refuses to plan while a REPLACE_ME remains.

project_id = "ai-enablement-dev-0cf5f"

# scripts/bootstrap-tools.sh prints this value.
wif_pool           = "projects/970749219253/locations/global/workloadIdentityPools/mytodo-mcp-deploy-github"
github_environment = "dev"

region = "us-central1"

# service_name starts the names of the service and its service accounts.
# Use the same value in every environment.
service_name           = "mcp-server"
artifact_registry_repo = "mcp-server"

# Only the gateway can reach the service. Use INGRESS_TRAFFIC_ALL if you delete infra/gateway.
cloud_run_ingress = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

# Add the prod mcp output deploy_service_account here. Prod can then copy dev images.
image_reader_service_accounts = []
