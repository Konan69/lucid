#!/usr/bin/env bash
# Usage: .agents/skills/state-machines/scripts/find.sh [path ...]   (default: apps/web/src apps/mobile/src apps/desktop/src)
# Prints kind <TAB> file:line <TAB> source for client lifecycle shapes that
# `vivid/react-no-state-after-wait` does not count. Run the lint rule as well;
# this list is the part it cannot see. Candidates, not verdicts.
set -euo pipefail
paths=("$@")
if ((${#paths[@]} == 0)); then paths=(apps/web/src apps/mobile/src apps/desktop/src); fi
globs=(-g '*.ts' -g '*.tsx' -g '!*.test.ts' -g '!*.test.tsx' -g '!**/node_modules/**')

scan() { # kind regex
  rg -n --with-filename --no-heading --color never -P "${globs[@]}" -- "$2" "${paths[@]}" \
    | while IFS= read -r hit; do
        file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*}; src=${rest#*:}
        printf '%s\t%s:%s\t%s\n' "$1" "$file" "$line" "${src#"${src%%[![:space:]]*}"}"
      done || true
}

# A status word or tagged union held in React state.
scan status-state "useState<\s*['\"][A-Za-z]+['\"]\s*\||useState<[^>]*\b(Status|Phase|Stage|Step)\b|useState\(\s*['\"](idle|loading|pending|saving|sending|busy|submitting)['\"]"
# Busy/error pairs and in-flight flags.
scan flag-pair "\[\s*(busy|pending|saving|sending|submitting|loading|working|asking|creating|removing|retitling)\s*,\s*set[A-Z]\w*\s*\]\s*=\s*useState"
# Per-row status maps and in-flight sets.
scan row-map "useState<\s*(ReadonlyMap|Map|Record|ReadonlySet|Set)<[^>]*>|useState\(\s*\(\)\s*=>\s*new\s+(Map|Set)\b"
# State written from an Effect finaliser or a named settlement callback (the lint rule misses both).
scan settle-callback "Effect\.(ensuring|tap|map|sync)\([^)]*\bset[A-Z]\w*\(|\.then\(\s*[a-z]\w*\s*\)"
# Lifecycle words in external stores (Zustand, custom stores, atoms).
scan store-status "\b(status|phase|stage)\s*:\s*['\"](idle|opening|waiting|asking|sending|unsent|finishing|ended|settled)['\"]|create<[^>]*>\(\s*\(set"
# Reducer events dispatched after a wait (the rule tracks only useState setters).
scan reducer "useReducer\("
