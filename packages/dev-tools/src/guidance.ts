/**
 * Reusable guidance embedded across the coding tool schemas and
 * descriptions. Single source of truth: every description that needs to tell
 * the model where durable files live says it with
 * {@link CODE_ARTIFACT_PATH_GUIDANCE}, so the wording cannot drift per tool.
 */

/** Where generated files must be written so later calls can read them back. */
export const CODE_ARTIFACT_PATH_GUIDANCE =
    'Anything a later call needs (data, helper scripts/modules, partial results) MUST be written under `/mnt/data` in the same call that produces it; `/tmp` never survives the call. `/mnt/data` keeps files with recognized extensions, covering common source, text, data, document, image, and archive formats (.py/.sh/.sql/.md/.json/.csv/.parquet/.png/.pdf/.zip and similar); extensionless or unusual extensions are not kept. Failed executions register nothing; fix the error and rerun before relying on new files.';

/** How to produce multi-line files and Python one-liners from bash. */
export const BASH_SHELL_GUIDANCE =
    'Bash: multi-line files use heredoc/printf; run Python via python3 -c/heredoc, not bare Python.';
