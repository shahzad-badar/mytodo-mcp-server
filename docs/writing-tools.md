# Writing a tool

Claude reads the name, the description and the schemas of each tool. It uses them to decide when to call the tool and with which arguments. A clear tool gets called correctly. A vague tool gets called wrongly or not at all.

[README.md](../README.md) lists the five steps to register a tool. This page covers the content of the tool.

## Example

`src/tools/hello.ts` shows every element below.

```ts
server.registerTool(
  "hello",
  {
    title: "Hello",
    description: "Return a friendly greeting, optionally addressed to a name.",
    inputSchema: {
      name: z.string().max(100).optional().describe("Who to greet. Defaults to 'world'."),
    },
    outputSchema: {
      greeting: z.string().describe("The greeting."),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  ({ name }) => {
    const greeting = `Hello, ${name ?? "world"}!`;
    return {
      content: [{ type: "text", text: greeting }],
      structuredContent: { greeting },
    };
  },
);
```

## Name

- Use `snake_case`, as in `list_projects` and `get_invoice`.
- Start with a verb.
- Use the same name in `src/mcp.ts`, in `DEFAULT_TOOL_SCOPES` and in Entra (`tools.<name>`).

## Description

- Say what the tool returns, in one or two sentences.
- Say when to use it if another tool does something similar.
- Name the limits. State the maximum number of results, the period covered and the required rights.
- Do not describe the implementation.

| Weak | Clear |
|---|---|
| `Gets data.` | `Return the open invoices of a customer, newest first. Returns at most 50 invoices.` |

## Input schema

- Declare every argument with `zod`. The SDK rejects a call that does not match.
- Add `.describe()` to every argument. Claude reads it.
- Bound every value. Use `.max()` on strings and arrays, `.int().min().max()` on numbers and `z.enum()` for fixed lists.
- Never take the caller's identity as an argument. Read it from the token. See "Building a real MCP server" in the README.

## Output

- Return `content` with a short text. Every client reads it.
- Also return `structuredContent` when the result is data. Declare its shape in `outputSchema`. The SDK checks the result against it.
- Keep results small. Return a page of results and say how to get the next one.

## Annotations

Annotations tell the client what the tool does. The client uses them to ask the user for confirmation.

| Annotation | Set to `true` when |
|---|---|
| `readOnlyHint` | The tool changes nothing. |
| `destructiveHint` | The tool deletes or overwrites data. |
| `idempotentHint` | Calling the tool twice with the same arguments has the same effect as once. |
| `openWorldHint` | The tool calls a system outside this server. |

Annotations are hints for the client. They are not a security control. The role and scope checks protect the tool.

## Errors

- Return `errorResult("<your message>")` from `src/tools/results.ts` for a failure. Claude reads the message and can correct its call.
- Write the message yourself. Say what failed and what to change. A good message reads `Customer 42 does not exist. Call list_customers to find a valid id.`
- Never pass a caught error to `errorResult`. Its text can contain a stack trace, a token or upstream data.
- Log the caught error with `emitError` and `reasonOf` from `src/observability/log.ts`. Never call `console`.

```ts
} catch (error) {
  emitError("save-item-error", { reason: reasonOf(error) });
  return errorResult("Could not save the item. Try again later.");
}
```

## Duration

Two limits apply.

| Limit | Value | Effect |
|---|---|---|
| `REQUEST_TIMEOUT_MS` in `src/server.ts` | 60 seconds | The server answers `504` and logs `mcp-request-timeout`. The tool keeps running unless it stops on its abort signal. |
| `latency_threshold_seconds` in `infra/monitoring` | 10 seconds (p95) | The latency alert fires. |

- Keep each call under 10 seconds.
- The server answers once, when the tool returns. It does not stream. Progress and log notifications sent during a call do not reach the client.
- Set a timeout on every call to another system.
- Split long work into several calls.

## Tests

Add a test in `tests/tools.test.ts` for each tool.

- One test for a normal call.
- One test for each expected error.
- Update the list in the test `lists every registered tool`.
