/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
export function jsonResult(obj, isError = false, space = 2) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, space) }],
    ...(!isError && { structuredContent: obj }),
    ...(isError && { isError: true }),
  };
}
