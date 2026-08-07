export const SHELL_OUTPUT_FILTERS = ['raw', 'rtk'] as const;

export type ShellOutputFilter = typeof SHELL_OUTPUT_FILTERS[number];

export class ShellOutputFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellOutputFilterError';
  }
}

/**
 * Validates the request-scoped shell output filter at each trust boundary.
 * RTK rewrites shell commands, so exposing it for non-Bash runtimes would be
 * misleading and would make future runtime behavior ambiguous.
 */
export function resolveShellOutputFilter(
  value: unknown,
  language: string,
): ShellOutputFilter | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || !SHELL_OUTPUT_FILTERS.includes(value as ShellOutputFilter)
  ) {
    throw new ShellOutputFilterError('shell_output_filter must be one of: raw, rtk');
  }
  if (language !== 'bash') {
    throw new ShellOutputFilterError('shell_output_filter is only supported for Bash executions');
  }
  return value as ShellOutputFilter;
}
