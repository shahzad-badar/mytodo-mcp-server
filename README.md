> ⚠️ **Work in progress.** This template is still changing. Its layout, defaults
> and conventions may change without notice. The code builds and runs. Tests
> cover the auth path. Expect to reconcile your server against a later version
> by hand if you start it from this template. Read the diff. Do not assume the
> changes are additive.

# MCP Server + Entra ID Template

This is a starter for a [Model Context Protocol](https://modelcontextprotocol.io)
server. The server authenticates with **Microsoft Entra ID** (Azure AD). Add your
own tools and ship.

## What you must change

Every item below ships with a placeholder. Every item is required unless marked
optional.

A `TODO:` comment marks each code field at its definition. Run
`grep -rn "TODO:" src/` to find them. `package.json` has no `TODO:` comment
because JSON does not support comments.

### In the code

| Field | File | Ships as | Set it to |
|---|---|---|---|
| `SERVER_NAME` | `src/mcp.ts` | `"my-mcp-server"` | Your server's id, as clients will see it |
| `RESOURCE_NAME` | `src/auth/protectedResource.ts` | `"My MCP Server"` | The display name in OAuth discovery |
| `ADMIN` / `MEMBER` | `src/auth/roles.ts` | `"Admin"` / `"Member"` | The app role names you define on the Entra resource app |
| `ADMIN_ONLY` | `src/auth/roles.ts` | `[]` | Tool names only the privileged role may call |
| `DEFAULT_TOOL_SCOPES` | `src/auth/config.ts` | the three example tools | One `tools.<name>` per tool you register |
| `"name"` | `package.json` | `"my-mcp-server"` | Your package name |
| `MAX_REQUEST_BYTES` _(optional)_ | `src/server.ts` | 1 MB | Only if a tool takes large payloads |

### In the environment

- Local values go in `.env`. Copy `.env.example` to create it.
- Deployed values are **GitHub Environment variables, not secrets**.
- Every value is a public identifier. Each one already appears in issued tokens
  or in the metadata this server serves.

| Variable | Required | Set it to |
|---|---|---|
| `ENTRA_TENANT_ID` | yes | Your Entra tenant GUID |
| `RESOURCE_AUDIENCE` | yes | The resource app's **client_id GUID**, not the App ID URI |
| `RESOURCE_BASE_URL` | yes | This server's own public URL |
| `SCOPES_SUPPORTED` | deployed | Only the scopes actually registered in Entra (see Step 6) |
| `ENTRA_CLIENT_ID` | if proxy on | The client app's id, when `OAUTH_PROXY_ENABLED=true` |

### Before shipping

| Do | Why |
|---|---|
| Delete `src/tools/hello.ts` and `test.ts`, **and their wiring** | They are example tools. `src/mcp.ts`, `config.ts` and the tests reference each one. Deleting only the files breaks the build (see Step 3). |
| Keep `src/tools/ping.ts` | It is a zero-argument liveness probe. It proves a client can reach and authenticate. |
| Set the resource app to **require app role assignment** | Entra then refuses a token to anyone unassigned. You change access by assignment, not by redeploy. |

[Customising this template](#customising-this-template) explains each of these.

## What's included

| Layer | What it does |
|---|---|
| `src/auth/` | An OAuth 2.1 resource server. It provides Entra JWT validation, RFC 9728 Protected Resource Metadata, a per-tool scope gate, audit logging and an optional DCR proxy for Claude. |
| `src/observability/` | Structured JSON logger with request-id tracing (AsyncLocalStorage) |
| `src/tools/hello.ts`, `ping.ts`, `test.ts` | Three working example tools. Follow their pattern. |
| `src/mcp.ts` | Per-request McpServer factory with scope/role-gated tool registration |
| `src/server.ts` | Express + Streamable HTTP transport with the full auth middleware chain |
| `scripts/dev-auth.ts` | Local JWKS + JWT minter for development without a live Entra tenant |
| `tests/` | End-to-end tests that drive the real server through an MCP client |
| `infra/` _(optional)_ | Terraform for Cloud Run, a Cloud Armor gateway, monitoring and Azure DNS, plus the bootstrap inputs. See [infra/README.md](infra/README.md). |
| `scripts/bootstrap-*.sh` _(optional)_ | Idempotent, checkable setup of the GCP projects that Terraform and the deploys use |
| `.github/workflows/` | CI runs the type check, build and tests on pushes to `main` and on every pull request. CI is always on. The Wiz scan runs once you configure it. Terraform, deploy and promotion stay off until you enable an environment. |

## Prerequisites

- Node 20+ (Node 24 recommended)
- An Entra ID tenant with:
  - A **resource app** registration (exposes `tools.*` delegated scopes)
  - A **client app** registration (public PKCE, needed only if `OAUTH_PROXY_ENABLED=true`)

  See [docs/entra-apps.md](docs/entra-apps.md). [docs/auth-flow.md](docs/auth-flow.md) describes the authentication flow.

## Getting started

```sh
npm install
cp .env.example .env
```

Set these values in `.env` for local development. Local development needs no Entra tenant.

```sh
ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000   # any GUID
RESOURCE_AUDIENCE=00000000-0000-0000-0000-000000000001 # any GUID
RESOURCE_BASE_URL=http://localhost:8080
HOST=127.0.0.1
AS_ISSUER=http://127.0.0.1:9001
AS_JWKS_URI=http://127.0.0.1:9001/jwks
DEV_AUTH_USER=you@example.com                          # the user in the local token
```

`AS_ISSUER` and `AS_JWKS_URI` make the server trust the local token issuer. The server otherwise trusts Entra and rejects the local token with `401`.

The local issuer uses port 9001. Set `DEV_AUTH_PORT` to another port if this port is busy. Use that port in `AS_ISSUER` and `AS_JWKS_URI`.

Then start the issuer and the server:

```sh
# Two terminals:
npm run dev:auth        # local JWKS endpoint at http://127.0.0.1:9001
npm run dev            # MCP server at http://localhost:8080/mcp

# Get a token to paste into your client:
npm run dev:token
```

Connect a client with a static bearer header:

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://localhost:8080/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer <the printed token>" }
}
```

## Adding a tool

1. Create `src/tools/<name>.ts` exporting `register<Name>(server: McpServer): void`.
2. Add `"tools.<name>"` to `DEFAULT_TOOL_SCOPES` in `src/auth/config.ts`.
3. Import and wire `granted("<name>", () => register<Name>(server))` in `src/mcp.ts`.
4. Expose the delegated scope `tools.<name>` on the Entra resource app.
5. Add a test case in `tests/tools.test.ts` and update the tool list assertion.

[docs/writing-tools.md](docs/writing-tools.md) explains how to write the description, the schemas, the annotations and the errors.

## Customising this template

Follow these steps in order.

### Step 1. Rename the server

Change `SERVER_NAME` in `src/mcp.ts`:
```ts
export const SERVER_NAME = "my-mcp-server"; // → e.g. "project-data-mcp"
```

Change the display name for OAuth discovery in `src/auth/protectedResource.ts`:
```ts
const RESOURCE_NAME = "My MCP Server"; // → e.g. "Project Data MCP"
```

### Step 2. Define your Entra app roles

Edit `src/auth/roles.ts`:

- Rename `Admin` / `Member` to match the roles on the Entra resource app.
- List the tools that only the privileged role may call.

Roles enable **group-based access**:

- You can assign a role to an Entra group.
- Every group member then has the role without per-person consent.
- Each member still needs the tool's scope.

Define one catch-all role (e.g. `User`) if you have no tiered access today.
Leave the `ADMIN_ONLY` list empty. You can split the role later.

Set the resource app to **require app role assignment**. Entra then issues no
token to anyone unassigned. You widen or narrow access by assignment, not by
redeploy.

This example defines two roles:

```ts
export const OWNER = "Owner";      // full access
export const VIEWER = "Viewer";    // read-only

const OWNER_ONLY: readonly string[] = ["delete_item", "admin_tool"];
```

### Step 3. Replace the example tools with your own

Add your domain tools. Follow the pattern in "Adding a tool" above.

- Remove `hello.ts` and `test.ts` before shipping. Production does not need them.
- Keep `ping.ts`. It is a zero-argument liveness probe. It confirms that a
  connected client can reach and authenticate with the server.

Several places reference each tool. The build breaks if you delete only the
files. Remove every reference below for **each** tool:

| Remove | From |
|---|---|
| `src/tools/<name>.ts` | the file itself |
| its `import { register<Name> }` line | `src/mcp.ts` |
| its `granted("<name>", ...)` line | `src/mcp.ts` |
| `"tools.<name>"` | `DEFAULT_TOOL_SCOPES` in `src/auth/config.ts` |
| its name from the expected list | the `lists every registered tool` assertion in `tests/tools.test.ts` |
| any test calling it | `tests/tools.test.ts` |

`tests/tools.test.ts` also imports `TEST_MESSAGE` from `test.ts`. Remove that
import too. Run `npm run typecheck && npm test` to find any reference you missed.

### Step 4. Add a data store (if needed)

Add a store interface and implementations first if your tools persist data:

| File | Content |
|---|---|
| `src/store/store.ts` | The interface and the domain types |
| `src/store/<yours>Store.ts` | The production implementation |
| `src/store/memoryStore.ts` | The in-memory implementation for tests |

Then follow these steps:

- Pass the store and the caller's email through `ToolContext` in `src/mcp.ts`.
- Inject `createMemoryStore()` in your tests. Tests then never hit a real database.
- See "Building a real MCP server on this template" below for a worked example.

The database goes in `infra/mcp` if you kept `infra/`. Its README section
"Adding a data store" lists the runtime grant and the apply role the database needs.

### Step 5. Update the body-size limit _(optional)_

The default limit is 1 MB. It fits almost all tool calls (text queries, IDs,
small JSON). Change it only if a tool accepts large payloads, such as a full
HTML document or a file upload. The limit is in `src/server.ts`:

```ts
const MAX_REQUEST_BYTES = 1024 * 1024; // 1 MB default. Raise only if tools need it.
```

### Step 6. Pin your scopes in the deployment config

Set `SCOPES_SUPPORTED` as a GitHub Environment variable. List only the scopes
you registered on the Entra resource app.

Sign-in fails for every tool if the server advertises a scope that Entra does
not know. Register the scope in Entra first. Then add it to the variable.

---

## Building a real MCP server on this template

The three example tools take no arguments and store nothing. A real server needs
a data store. Its tools read and write that store for the token holder.

This section shows the pattern with an item store:

- The caller's email is the store key.
- The server injects the store. Tools do not import it.

Adapt the names to your own domain.

### 1. Add a data store

Install your persistence package. Write a store interface and at least two
implementations:

- a real implementation
- an in-memory implementation for tests

Tools depend on the interface, not on the database. The test suite therefore
needs no database.

```
src/
  store/
    store.ts          ← interface + domain types
    memoryStore.ts    ← test / dev implementation
    <yours>Store.ts   ← production implementation
```

**`src/store/store.ts`** defines the interface your tools depend on:

```ts
export type Item = { readonly id: string; readonly content: string };

export interface ItemStore {
  save(ownerEmail: string, item: Item): Promise<void>;
  list(ownerEmail: string): Promise<Item[]>;
  get(ownerEmail: string, id: string): Promise<Item | undefined>;
  delete(ownerEmail: string, id: string): Promise<void>;
}
```

**`src/store/memoryStore.ts`** is an in-memory map for tests:

```ts
import type { Item, ItemStore } from "./store.js";

export function createMemoryStore(): ItemStore {
  const data = new Map<string, Map<string, Item>>();
  const forOwner = (email: string) => {
    if (!data.has(email)) data.set(email, new Map());
    return data.get(email)!;
  };
  return {
    async save(owner, item) { forOwner(owner).set(item.id, item); },
    async list(owner)       { return [...forOwner(owner).values()]; },
    async get(owner, id)    { return forOwner(owner).get(id); },
    async delete(owner, id) { forOwner(owner).delete(id); },
  };
}
```

### 2. Thread the caller's email and store into tools

The server builds a new `McpServer` for every request. It reads the user's email
from the validated token. Pass the email and the store through `ToolContext`.

Extend `ToolContext` in **`src/mcp.ts`**:

```ts
import type { ItemStore } from "./store/store.js";

export type ToolContext = {
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
  readonly ownerEmail: string;   // ← the caller, from their Entra token
  readonly store: ItemStore;     // ← the real store in prod, the memory store in tests
};
```

Create the store once in **`src/server.ts`**. Pass the store and the caller's
email on each request:

```ts
const store = createItemStore(); // or inject via ServerDeps for tests

// inside handleMcpRequest:
const server = createMcpServer({
  scopes: auth?.scopes ?? [],
  roles: rolesOf(auth),
  ownerEmail: callerEmailOf(req),
  store,
});
```

Inject `createMemoryStore()` via `ServerDeps` in tests. Tests then need no real database.

### 3. Write domain tools

Each tool receives the context it needs. No tool reads the bearer token directly.

**`src/tools/saveItem.ts`**:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ItemStore } from "../store/store.js";
import { jsonResult, errorResult } from "./results.js";
import { emitError, reasonOf } from "../observability/log.js";

type Context = { ownerEmail: string; store: ItemStore };

export function registerSaveItem(server: McpServer, ctx: Context): void {
  server.registerTool(
    "save_item",
    {
      title: "Save item",
      description: "Save an item to the caller's namespace. Saving an existing id replaces the item.",
      inputSchema: {
        id:      z.string().max(64).describe("Unique identifier for this item."),
        content: z.string().max(10_000).describe("The item's content."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, content }) => {
      try {
        await ctx.store.save(ctx.ownerEmail, { id, content });
        return jsonResult({ saved: id });
      } catch (error) {
        emitError("save-item-error", { reason: reasonOf(error) });
        return errorResult("Could not save the item. Try again later.");
      }
    },
  );
}
```

Register it in `src/mcp.ts`:

```ts
granted("save_item", () => registerSaveItem(server, { ownerEmail, store }));
```

Add `"tools.save_item"` to `DEFAULT_TOOL_SCOPES` in `src/auth/config.ts`.

### 4. Test with the memory store

Inject the in-memory store in `tests/tools.test.ts`. Tests then never touch a real database:

```ts
server = createHttpServer({
  config: auth.config,
  getKey:  auth.getKey,
  store:   createMemoryStore(),   // ← no database needed
});
```

Test a round trip as a real AI client would. Call the tool, then read the result back:

```ts
it("saves and retrieves an item", async () => {
  await withClient((client) =>
    client.callTool({ name: "save_item", arguments: { id: "x", content: "hello" } })
  );
  const result = await withClient((client) =>
    client.callTool({ name: "list_items", arguments: {} })
  );
  const items = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "x");
});
```

### What a real server adds beyond this

The pattern above covers all the wiring. A production server adds domain work on
top. None of that work belongs in `src/auth/`.

| Concern | Where it goes |
|---|---|
| A per-user namespace | The store key. `ownerEmail` comes from the validated token, never from an argument. |
| Sharing between users | Your store. Use a second collection, or a recipient list on the record. |
| Validating what a tool receives | A contract module. The tool calls it before writing. It refuses a bad record. |
| Refusing content that must not be stored | The same module, before the write. This costs less than deleting the content later. |
| Serving the data to something other than an assistant | A separate deployable. It reads the same store and has its own sign-in. |

Keep these concerns out of the auth layer. The auth layer has tests that prove a
token without a role or without a scope reaches nothing. You will also want to
compare the auth layer against later versions of the template.

## Roles

`src/auth/roles.ts` ships with placeholder `Admin` / `Member` Entra app roles.
Rename them to match the roles on your resource app.

**A role and a scope are both required, never either.** A token with only one
of them reaches nothing.

| Check | Meaning | Granted by |
|---|---|---|
| Role | The directory admitted this person. | Assignment to a user or to an Entra group. No per-person consent. |
| Scope | The client requested this tool. | Per-person consent. |

The two refusals differ on purpose:

| Missing | Response | Challenge |
|---|---|---|
| Scope | 403 `insufficient_scope` | `WWW-Authenticate` challenge naming the union scope. This is a **step-up**. The client requests the scope again. |
| Role | 403 `insufficient_role` | **None**. No client request can grant a role. |

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with reload on file change |
| `npm run dev:auth` | Start local JWKS server |
| `npm run dev:token` | Print a 7-day dev token |
| `npm run build` | Compile TypeScript |
| `npm start` | Run compiled output |
| `npm run typecheck` | Strict type check of `src`, `tests` and `scripts` |
| `npm test` | Run the tests |

## Security scan (Wiz)

The `security-scan` job in `.github/workflows/ci.yml` scans the repository with the Wiz CLI. It runs on pull requests and on `main` once you set `WIZ_CLIENT_ID`. It stays off until then.

Set these values at repository scope, under Settings, Secrets and variables, Actions.

| Name | Kind | Value |
|---|---|---|
| `WIZ_CLIENT_ID` | variable | The Wiz service account client id. It turns the scan on. |
| `WIZ_CLIENT_SECRET` | secret | The Wiz service account secret. The job fails if it is missing. |
| `WIZ_PROJECT_ID` | variable | Optional. The Wiz project that receives the results. |

The scan applies the default Wiz policies for vulnerabilities, secrets, malware, sensitive data, software licenses and IaC. It disables SAST, because SAST needs a Wiz Code license. Your Wiz tenant decides whether a policy only reports or also fails the job.

## Deployment (Cloud Run)

[docs/deployment.md](docs/deployment.md) lists every deployment step in order.

[infra/README.md](infra/README.md) deploys the server to Cloud Run end to end in
your own GCP projects. Start with dev. Add prod when you are ready. The steps
are:

1. Fill in `infra/bootstrap/bootstrap.env`.
2. Run `scripts/bootstrap-tools.sh` and `scripts/bootstrap-env.sh dev`.
3. Set `ENABLED_ENVIRONMENTS=dev`.
4. Apply the roots.
5. Set the deploy variables.
6. Push.

Only CI runs until you enable an environment. Nothing plans or deploys. A
repository created from this template therefore passes CI from its first pull
request.

Verify that auth is live after deploy. This call must return `401`:

```sh
curl -i -X POST https://<your-host>/mcp
```

## Choose how much you take

The server never depends on the infrastructure layer. You can keep all of it.
You can also delete any part you already handle yourself. Run the command below
from the repository root and commit the result.

| Mode | Keeps | You provide |
|---|---|---|
| **Full** | everything | two GCP projects (tools, and one per environment) |
| **Own infra, our deploy** | the server, CI, the deploy and promotion workflows | what [What deploy expects](#what-deploy-expects) lists |
| **Server only** | the server, its tests, the Dockerfile and CI | your own deployment |

**Own infra, our deploy**:

<!-- remove:own-infra -->
```sh
rm -rf infra .github/workflows/terraform.yml scripts/bootstrap-lib.sh scripts/bootstrap-tools.sh scripts/bootstrap-env.sh scripts/bootstrap-dns.sh scripts/check-apply-roles.sh scripts/tf-env-vars.sh scripts/install-terraform.sh
```

**Server only**:

<!-- remove:server-only -->
```sh
rm -rf infra .github/workflows/terraform.yml .github/workflows/_deploy.yml .github/workflows/deploy.yml .github/workflows/deploy-prod.yml .github/workflows/verify-promotion-access.yml scripts/bootstrap-lib.sh scripts/bootstrap-tools.sh scripts/bootstrap-env.sh scripts/bootstrap-dns.sh scripts/check-apply-roles.sh scripts/tf-env-vars.sh scripts/install-terraform.sh scripts/promote-image.sh scripts/verify-promotion-access.sh
```

You can delete a single root in **Full** mode:

| Delete | When |
|---|---|
| `infra/dns` | Your zone is not in Azure DNS. |
| `infra/monitoring` | You alert elsewhere. |
| `infra/gateway` | You serve from the `run.app` URL. Then set `cloud_run_ingress = "INGRESS_TRAFFIC_ALL"` in `infra/mcp/env/*.tfvars`. |

CI, the bootstrap scripts and the role check adapt to the directories that exist.

### What deploy expects

This list is the full contract for teams that keep the deploy workflows and
provision with their own tooling. `infra/` meets every item.

- An **Artifact Registry** Docker repository and a **Cloud Run** service.
- A **runtime** service account for the service.
- A **deployer** service account with these roles:
  - `roles/artifactregistry.writer` on the repository
  - `roles/run.admin` on the service
  - `roles/iam.serviceAccountUser` on the runtime service account
- A Workload Identity pool with a GitHub OIDC provider. The provider:
  - maps `attribute.environment=assertion.environment`
  - is conditioned on this repository
- The deployer grants `roles/iam.workloadIdentityUser` to
  `principalSet://iam.googleapis.com/<pool>/attribute.environment/<env>`.
- The repository secret `DEPLOY_WORKLOAD_IDENTITY_PROVIDER` (the provider's full
  resource name).
- On each GitHub Environment:
  - the secret `GCP_SERVICE_ACCOUNT` (the deployer)
  - the variables `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ARTIFACT_REGISTRY_REPO`,
    `CLOUD_RUN_SERVICE`
  - the variable `CLOUD_RUN_INVOKER_FLAG=--allow-unauthenticated`. Cloud Run
    answers 403 to every call without it.
  - the server's own variables `ENTRA_TENANT_ID`, `RESOURCE_AUDIENCE`,
    `RESOURCE_BASE_URL`, `SCOPES_SUPPORTED`, and `OAUTH_PROXY_ENABLED`/`ENTRA_CLIENT_ID`
    for Claude
- The environment name in the `ENABLED_ENVIRONMENTS` repository variable.
- For promotion:
  - The target's deployer holds `roles/artifactregistry.reader` on the source's repository.
  - The target sets `PROMOTE_SOURCE_IMAGE`.

## Security posture

- No tool executes without a valid Entra JWT (`requireBearerAuth` → 401).
- The server accepts user tokens only. It rejects application-only tokens (`requireCallerEmail` → 403).
- Every call needs a role **and** a per-tool scope. The gate runs before the MCP transport.
  - A missing scope gets 403 `insufficient_scope` with a step-up challenge.
  - A missing role gets 403 `insufficient_role` with no challenge.
- RS256 only. `exp` is required. Issuer and audience are pinned.
- The server image contains no token-minting code.
- The server refuses to start on Cloud Run with the `AS_ISSUER`/`AS_JWKS_URI` dev overrides (`K_SERVICE` guard).
- OAuth proxy:
  - PKCE S256 is required.
  - `redirect_uri` must exactly match an allowlist entry.
  - Scopes are enumerated. There is no passthrough.
