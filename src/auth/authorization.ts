// Each tool has its own scope. The server grants no blanket scope.

export function scopeForTool(toolName: string): string {
  return `tools.${toolName}`;
}

export function hasScope(granted: readonly string[], required: string): boolean {
  return granted.includes(required);
}

// MCP clients replace their scopes on re-auth, so the step-up asks for the union.
export function stepUpScope(granted: readonly string[], required: string): string {
  return [...new Set([...granted, required])].join(" ");
}
