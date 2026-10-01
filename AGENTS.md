# AGENTS.md

Instructions for agents that work in this repository. This repository is an MCP server with Entra ID authentication. It started from the MCP + Entra template.

Read [README.md](README.md) first. Its **What you must change** section lists every placeholder.

> **`ai-enablement-mcp-template` is a generated mirror.** A sync overwrites every edit in that repository. [CONTRIBUTING.md](CONTRIBUTING.md) says where changes belong.

## The main rule

**A tool call needs a role and a scope.** One of them is never enough.

- The role means the directory lets this person in.
- The scope means the client asked for this tool.

Two places enforce this rule. They must stay the same.

| Where | File | Decides |
|---|---|---|
| Registration | `src/mcp.ts`, `granted(...)` | Which tools `initialize` and `tools/list` offer |
| Request gate | `src/auth/scopeEnforcement.ts` | Whether a `tools/call` runs |

The template once changed one place without the other. The gate required both. Registration required either. A token with only a role saw every tool and failed at call time.

- Never change either check to `||`.
- Add any new condition to both places.
- Test it in `tests/tools.test.ts`.

The two refusals are different on purpose.

| Missing | Response | Reason |
|---|---|---|
| Scope | `403 insufficient_scope` with a `WWW-Authenticate` header naming the scopes | The client signs in again with the scope and retries. |
| Role | `403 insufficient_role` with no `WWW-Authenticate` header | A new sign-in cannot grant a role. |

## What must not be weakened

- **No auth bypass.** No environment variable lets the server run a tool without a valid token. Do not add one. Use `scripts/dev-auth.ts` for local development.
- **`scripts/dev-auth.ts` stays out of the server.** `src/` does not import it. The build does not compile it. The image does not contain it.
- **`AS_ISSUER` and `AS_JWKS_URI` change the trusted token issuer.** `loadAuthConfig` refuses to start when one of them is set with `K_SERVICE`. Cloud Run always sets `K_SERVICE`. Keep this guard. Never set these variables in a Dockerfile, a workflow or a deployed environment.
- **`/token` never widens the scope.** `authorizeScopes` turns an empty tool list into every supported scope. This is correct at `/authorize`. `tokenScopes` must not do it, because Entra refuses a request for more than the grant. Keep the two functions separate.
- **Scopes are enumerated.** The proxy accepts a scope only if the server advertises it or if it is an OIDC scope. It refuses any other scope by name.
- **Logs are explicit.** Use `emit`, `emitWarning` and `emitError` from `src/observability/log.ts`. Write each field by name. No other file in `src/` calls `console`. Never log a token, a secret or an upstream error text. Use `reasonOf()` for errors. It removes addresses and limits the length.

## The infrastructure layer

`infra/`, `scripts/bootstrap-*.sh` and the Terraform and deploy workflows are optional. This repository may have deleted them. See "Choose how much you take" in the README. These rules apply where they exist.

- **The server does not depend on them.** Nothing in `src/`, `tests/`, the `Dockerfile` or `package.json` reads `infra/` or a bootstrap script. `ci.yml` runs no Terraform.
- **Only `main` reaches a writing identity.** Each Terraform apply identity trusts `attribute.ref/refs/heads/main`. Each deployer trusts `attribute.environment/<env>`. Never widen them to the whole repository. The plan job runs on every pull request.
- **The plan job declares no `environment:`.** An environment would trigger the prod approval on every pull request. The plan job therefore reads repository variables with an environment suffix, such as `TF_STATE_BUCKET_DEV`. It would read an environment variable as an empty string.
- **Plan is read-only. Apply runs the saved plan.** Plan uses `-lock=false`, because its identity cannot write a lock. Apply takes no `-var-file`. The saved plan fails if the state changed after review.
- **One role list.** `infra/bootstrap/apply-roles.txt` is the only list of apply roles. A new resource type needs a line there. The plan checks the apply identity against this file.
- **Grants between environments are in Terraform.** Prod reads dev images through `image_reader_service_accounts` in dev. A plan shows it if someone removes it.
- **Prod never builds.** Prod deploys the image that dev ran, by digest. Do not add a build step to promotion.
- **Off means off. On means complete.** Nothing plans or deploys an environment missing from `ENABLED_ENVIRONMENTS`. The published template repository deploys nothing. A missing value in an enabled environment fails with its name. Do not turn this failure into a skip.
- **Never copy state between environments.** The copy would claim the other environment's resources.

## Adding a tool

1. Create `src/tools/<name>.ts`. It exports `register<Name>(server: McpServer): void`.
2. Add `"tools.<name>"` to `DEFAULT_TOOL_SCOPES` in `src/auth/config.ts`.
3. Add `granted("<name>", () => register<Name>(server))` in `src/mcp.ts`.
4. Add the scope `tools.<name>` to the Entra resource app **before** you deploy. Entra refuses a sign-in request with an unknown scope. One unknown scope breaks sign-in for every tool.
5. Add a test in `tests/tools.test.ts`. Update the tool list in the test `lists every registered tool`.

[docs/writing-tools.md](docs/writing-tools.md) explains the description, the schemas, the annotations and the errors. A tool call must finish before `REQUEST_TIMEOUT_MS` in `src/server.ts` (60 seconds).

Reverse these steps to remove a tool. README Step 3 lists every reference.

## Comments and documentation

Apply these rules to code comments, the READMEs and `docs/`.

- Comment the reason, the constraint or the security rule. Do not restate the code.
- Keep a comment to two lines or fewer. Keep `TODO:` markers and tool directives.
- Write subject, verb, object. Put one idea in each sentence.
- Put the main clause first. Write "Set X if Y", not "If Y, set X".
- Do not use em dashes, en dashes or semicolons.
- Use a colon only at the end of a line that introduces a list, a table or a code block.
- Prefer lists and tables to long paragraphs.
- Check every claim against the code before you write it.
- Do not prefill team-specific values, such as domains, IP ranges or subscriptions.

| Avoid | Write |
|---|---|
| `Both, not either: the role says X, the scope says Y.` | `A tool needs the role and the scope.` |
| `Without it, the server rejects the token.` | `The server rejects the token without it.` |

## Tests

- The tests use `node:test`. Run them with `npm test`.
- Most tests are end-to-end. They start the real server on a free port. They call it with an MCP client and a token signed by a local key.
- A pure function without HTTP, such as `reasonOf`, can have a unit test.
- `tests/helpers/testAuthServer.ts` creates tokens. A token has a role by default. A test that needs a token without a role must ask for one.
- `tests/helpers/httpServer.ts` starts the server. `tests/helpers/captureLog.ts` captures log lines.

| File | Covers |
|---|---|
| `tests/tools.test.ts` | Tools, tool list, role and scope per tool |
| `tests/auth.test.ts` | Token validation, discovery metadata, the request gate |
| `tests/oauthProxy.test.ts` | `/register`, `/authorize` and `/token`, with redirect URIs, PKCE and scope translation |
| `tests/audit.test.ts` | The audit line of each tool call |
| `tests/logging.test.ts` | Log format, request ids, redaction |
| `tests/devAuth.test.ts` | The local token issuer and its deployment guard |
| `tests/requestTimeout.test.ts` | The request timeout |

- A test for an auth change must fail before the fix and pass after it.
- `.github/workflows/ci.yml` runs the type check, the build and the tests on every pull request and on `main`. A push without a pull request does not run them. Protect `main` in the GitHub settings so that a red run blocks the merge.
- The `security-scan` job in `ci.yml` runs the Wiz CLI when `WIZ_CLIENT_ID` is set. Keep the CLI version and its SHA-256 pinned together.

## Before deploying

- Set `SCOPES_SUPPORTED` to the scopes registered in Entra. The code default is one scope per tool. The deploy workflow refuses to run without this variable.
- Set the resource app to **require app role assignment**. Entra then refuses a token to unassigned users.
- Send `POST /mcp` without a token. The answer must be **401** with a `WWW-Authenticate` header that points to the protected resource metadata. A `200` or an HTML `403` page from Google means the server does not see the request.
