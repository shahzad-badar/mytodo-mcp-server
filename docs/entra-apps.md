# Entra app registrations

Create these registrations once per environment. Do not share them between dev and prod.

| App | Required | Environment variable |
|---|---|---|
| Resource app | Always | `RESOURCE_AUDIENCE` |
| Client app | When `OAUTH_PROXY_ENABLED=true` | `ENTRA_CLIENT_ID` |

Prerequisites:

- The Application Administrator role. A tenant admin must run the consent step if you do not have it.
- `az`, `jq` and `uuidgen`.
- Entra ID P1 or P2 if you assign groups to roles. The free tier only allows the assignment of individual users.

```sh
export ENV=dev
export TENANT_ID=<tenant GUID>
az login --tenant "$TENANT_ID"
```

The commands below use two helpers. Define them in your shell first.

```sh
# Prints a delegated scope as JSON.
new_scope() {
  jq -cn --arg id "$(uuidgen | tr 'A-Z' 'a-z')" --arg v "$1" '{
    id: $id, value: $v, type: "User", isEnabled: true,
    adminConsentDisplayName: $v, adminConsentDescription: ("Call " + $v),
    userConsentDisplayName: $v,  userConsentDescription: ("Call " + $v)
  }'
}

# Reads the resource app's api object, applies a jq filter, and writes it back.
# The other fields of the api object stay unchanged.
patch_api() {
  local filter=$1; shift
  az rest --method GET --uri "https://graph.microsoft.com/v1.0/applications/$RES_OBJ_ID" --query api -o json \
    | jq -c "$@" "$filter | {api: .}" > /tmp/mcp-api.json
  az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$RES_OBJ_ID" \
    --headers Content-Type=application/json --body @/tmp/mcp-api.json
}
```

## 1. Resource app

### Create

```sh
RES_APP_ID=$(az ad app create \
  --display-name "My MCP API ($ENV)" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
RES_OBJ_ID=$(az ad app show --id "$RES_APP_ID" --query id -o tsv)

az ad app update --id "$RES_APP_ID" --identifier-uris "api://$RES_APP_ID"
```

### Scopes, roles, token version

- One scope `tools.<name>` per tool. The list must match `SCOPES_SUPPORTED` exactly.
- The roles defined in `src/auth/roles.ts`.
- `requestedAccessTokenVersion` must be `2`. The server rejects every token with version 1.

Run these commands once, on the new app. See [Adding a tool](#adding-a-tool) to add a scope later.

```sh
scopes_json=$(for s in tools.hello tools.ping tools.test; do new_scope "$s"; done | jq -cs .)
patch_api '.requestedAccessTokenVersion = 2 | .oauth2PermissionScopes = $scopes' --argjson scopes "$scopes_json"

roles_json=$(for r in Admin Member; do
  jq -cn --arg id "$(uuidgen | tr 'A-Z' 'a-z')" --arg v "$r" '{
    id: $id, value: $v, displayName: $v, description: $v,
    allowedMemberTypes: ["User"], isEnabled: true
  }'; done | jq -cs .)
az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/applications/$RES_OBJ_ID" \
  --headers Content-Type=application/json \
  --body "$(jq -cn --argjson roles "$roles_json" '{appRoles: $roles}')"
```

### Assignment

```sh
az ad sp create --id "$RES_APP_ID" 2>/dev/null || true
RES_SP_ID=$(az ad sp show --id "$RES_APP_ID" --query id -o tsv)

az rest --method PATCH \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$RES_SP_ID" \
  --headers Content-Type=application/json \
  --body '{"appRoleAssignmentRequired": true}'

GROUP_OBJ_ID=<group object id>
ROLE_ID=$(az ad app show --id "$RES_APP_ID" --query "appRoles[?value=='Member'].id" -o tsv)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$RES_SP_ID/appRoleAssignedTo" \
  --headers Content-Type=application/json \
  --body "$(jq -n --arg p "$GROUP_OBJ_ID" --arg r "$RES_SP_ID" --arg a "$ROLE_ID" \
    '{principalId: $p, resourceId: $r, appRoleId: $a}')"
```

## 2. Client app

Register the redirect URI under the **Mobile and desktop** platform. The Web and SPA platforms do not work with this server.

```sh
CLIENT_APP_ID=$(az ad app create \
  --display-name "My MCP Client ($ENV)" \
  --sign-in-audience AzureADMyOrg \
  --public-client-redirect-uris "https://claude.ai/api/mcp/auth_callback" \
  --is-fallback-public-client true \
  --query appId -o tsv)
az ad sp create --id "$CLIENT_APP_ID" 2>/dev/null || true
```

### Permissions

```sh
# Pre-authorize the client on every enabled scope of the resource app.
patch_api '.preAuthorizedApplications = ([.preAuthorizedApplications[] | select(.appId != $app)]
  + [{appId: $app, delegatedPermissionIds: [.oauth2PermissionScopes[] | select(.isEnabled) | .id]}])' --arg app "$CLIENT_APP_ID"

# Add the Microsoft Graph scopes openid, profile, email and offline_access.
az ad app permission add --id "$CLIENT_APP_ID" --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions \
    37f7f235-527c-4136-accd-4a02d197296e=Scope \
    14dad69e-099b-42c9-810b-d002981feec1=Scope \
    64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0=Scope \
    7427e0e9-2fba-42fe-b0c0-848c9e6a8182=Scope
az ad app permission admin-consent --id "$CLIENT_APP_ID"
```

Do not create a client secret.

## 3. Environment variables

| Variable | Value |
|---|---|
| `ENTRA_TENANT_ID` | `$TENANT_ID` |
| `RESOURCE_AUDIENCE` | `$RES_APP_ID` (GUID, not `api://`) |
| `SCOPES_SUPPORTED` | `tools.hello tools.ping tools.test` |
| `OAUTH_PROXY_ENABLED` | `true` |
| `ENTRA_CLIENT_ID` | `$CLIENT_APP_ID` |
| `RESOURCE_BASE_URL` | `https://<host>` |

## 4. Connect Claude

Add a custom connector in Claude with the URL `https://<host>/mcp`.

Check before connecting:

```sh
curl -i -X POST https://<host>/mcp   # expect 401
```

## Adding a tool

Set `RES_OBJ_ID` and `CLIENT_APP_ID`, and define the helpers from the top of this page.

```sh
# 1. Add the scope. The existing scopes keep their ids.
patch_api '.oauth2PermissionScopes += [$scope]' --argjson scope "$(new_scope tools.<name>)"

# 2. Pre-authorize the client on the new scope.
patch_api '.preAuthorizedApplications = ([.preAuthorizedApplications[] | select(.appId != $app)]
  + [{appId: $app, delegatedPermissionIds: [.oauth2PermissionScopes[] | select(.isEnabled) | .id]}])' --arg app "$CLIENT_APP_ID"
```

3. Add the scope to `SCOPES_SUPPORTED`. Do this after steps 1 and 2.

Follow this order to remove a scope:

1. Remove the scope from `SCOPES_SUPPORTED`. Deploy.
2. Disable the scope with `patch_api '(.oauth2PermissionScopes[] | select(.value == $v) | .isEnabled) = false' --arg v tools.<name>`
3. Run step 2 above again. The pre-authorization then drops the disabled scope.
4. Delete the scope with `patch_api '.oauth2PermissionScopes |= map(select(.value != $v))' --arg v tools.<name>`

Entra refuses to delete an enabled scope.

## Troubleshooting

| Error | Fix |
|---|---|
| 401 on every call | Set `requestedAccessTokenVersion` to `2`. Set `RESOURCE_AUDIENCE` to the GUID. |
| `AADSTS7000218` | Move the redirect URI from Web to Mobile and desktop. |
| `AADSTS9002326` | Move the redirect URI from SPA to Mobile and desktop. |
| `AADSTS70011` | Register the missing scope, or remove it from `SCOPES_SUPPORTED`. |
| `AADSTS50105` | Assign the user or group to the resource app. |
| 403 `insufficient_role` | Assign a role defined in `src/auth/roles.ts`. |
