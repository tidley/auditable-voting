#!/usr/bin/env bash

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_LOG="$ROOT_DIR/test-results/run.log"

cleanup() {
    kill "$TAIL_PID" 2>/dev/null
    wait "$TAIL_PID" 2>/dev/null
    tput cnorm 2>/dev/null || true
    stty echo 2>/dev/null || true
    echo ""
    exit 0
}
trap cleanup EXIT INT TERM

mkdir -p "$ROOT_DIR/test-results"

_any_agent_running() {
    pgrep -f "python.*pytest" -q 2>/dev/null && return 0
    pgrep -f "ansible-playbook.*integration" -q 2>/dev/null && return 0
    return 1
}

TAIL_PID=""

while true; do
    kill "$TAIL_PID" 2>/dev/null || true
    wait "$TAIL_PID" 2>/dev/null || true
    TAIL_PID=""

    if _any_agent_running; then
        clear 2>/dev/null || true
        printf "\033[1m=== Agents running — tailing test-results/run.log ===\033[0m\n"
        printf "    (press Ctrl+C to exit)\n\n"
        tail -F -n 30 "$RUN_LOG" &
        TAIL_PID=$!
        while _any_agent_running; do sleep 1; done
    else
        clear 2>/dev/null || true
        printf "\033[1m=== Idle — git status ===\033[0m\n"
        printf "    (press Ctrl+C to exit)\n\n"
        git -C "$ROOT_DIR" status --short 2>/dev/null || true
        echo ""
        git -C "$ROOT_DIR" log --oneline -5 2>/dev/null || true
        sleep 3
    fi
done
