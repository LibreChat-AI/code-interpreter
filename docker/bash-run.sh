#!/bin/bash

# RTK is deliberately invoked here, inside NsJail, so user-controlled source
# never reaches a privileged service or worker process. Unsupported rewrites,
# denied commands, and tool failures preserve the existing raw execution path.
if [ "${CODEAPI_SHELL_OUTPUT_FILTER:-raw}" = "rtk" ] && [ "$#" -gt 0 ]; then
    rewritten="$(rtk rewrite "$(cat -- "$1")" 2>/dev/null)"
    rewrite_status=$?

    if { [ "$rewrite_status" -eq 0 ] || [ "$rewrite_status" -eq 3 ]; } && [ -n "$rewritten" ]; then
        rewritten_script="$(mktemp /tmp/codeapi-rtk.XXXXXX.sh 2>/dev/null)"
        if [ -n "$rewritten_script" ]; then
            cleanup_rewritten_script() {
                rm -f -- "$rewritten_script"
            }
            trap cleanup_rewritten_script EXIT
            printf '%s\n' "$rewritten" > "$rewritten_script"
            bash "$rewritten_script" "${@:2}"
            exit $?
        fi
    fi
fi

exec bash "$@"
