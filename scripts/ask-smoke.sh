#!/usr/bin/env bash
# A real pi TUI running only the ask smoke fixture: no taskforce agents, no
# tools, no model call.
#
# The config, session and journal live in ONE reusable workspace, because a
# restart must open the same session branch to recover a question:
#
#   scripts/ask-smoke.sh          run /ask-smoke, then leave it unanswered
#   scripts/ask-smoke.sh          run again, /recover-show opens the same ask
#   scripts/ask-smoke.sh -c       remove the workspace and start over
#
# After a run, scripts/ask-smoke-check.ts reads the journal back from the
# session file: it is the post-quit proof that the question persisted.
#
# The path defaults to ${TMPDIR:-/tmp}/pi-taskforce-ask-smoke and can be set with
# PI_TASKFORCE_ASK_SMOKE_DIR. It is never removed by a normal exit.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="${PI_TASKFORCE_ASK_SMOKE_DIR:-${TMPDIR:-/tmp}/pi-taskforce-ask-smoke}"

if [[ "${1:-}" == "-c" ]]; then
	rm -rf "$work"
	echo "ask smoke: removed $work"
	exit 0
fi
if [[ -n "${1:-}" ]]; then
	echo "usage: $0 [-c]" >&2
	exit 2
fi

mkdir -p "$work/agent" "$work/sessions"
echo "ask smoke: workspace $work (kept for the next run; -c removes it)"
echo "ask smoke: /ask-smoke opens the ask; Alt+H hides, Alt+Q reopens, Ctrl+Enter sends"
echo "ask smoke: leave the ask open and end pi (close the window, or kill it); run the script again, then /recover-show"
echo "ask smoke: after quitting, bun scripts/ask-smoke-check.ts \"$work\" reads the journal back"

# The journal only persists once the session has a real conversation entry; the
# seed creates one, exactly like a production session, without a model call.
bun "$root/scripts/ask-smoke-seed.ts" "$work"

cd "$work"
PI_CODING_AGENT_DIR="$work/agent" PI_OFFLINE=1 \
	pi --no-extensions \
	--extension "$root/tests/fixtures/ask-smoke.ts" \
	--session-dir "$work/sessions" \
	--session-id ask-smoke \
	--no-builtin-tools \
	--thinking off
