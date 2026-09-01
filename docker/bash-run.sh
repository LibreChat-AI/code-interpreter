#!/bin/bash

# RTK is deliberately invoked here, inside NsJail, so user-controlled source
# never reaches a privileged service or worker process. Unsupported rewrites,
# denied commands, and tool failures preserve the existing raw execution path.
if [ "${CODEAPI_SHELL_OUTPUT_FILTER:-raw}" = "rtk" ] && [ "$#" -gt 0 ]; then
    # `bash -c` preserves the submitted path as $0/BASH_ARGV0, but Bash does
    # not populate BASH_SOURCE for command strings. Keep the original file
    # execution path for scripts that inspect BASH_SOURCE so filtering cannot
    # change source-relative imports or helper lookups.
    if ! grep -q 'BASH_SOURCE' -- "$1" 2>/dev/null; then
        rewritten="$(rtk rewrite "$(cat -- "$1")" 2>/dev/null)"
        rewrite_status=$?

        if { [ "$rewrite_status" -eq 0 ] || [ "$rewrite_status" -eq 3 ]; } && [ -n "$rewritten" ]; then
            exec bash -c "$rewritten" "$1" "${@:2}"
        fi
    fi
fi

exec bash "$@"
