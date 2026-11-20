#!/usr/bin/env bash
# Loads both extensions in a headless omp and checks that they register their
# commands. This catches broken host imports, which is how an omp update
# usually breaks these plugins.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! command -v omp >/dev/null 2>&1; then
	echo "smoke: omp is not on PATH" >&2
	exit 1
fi

set +e
out=$(
	cd "$work" &&
		timeout 60 omp --mode rpc --no-ui --no-extensions --no-session --no-skills --no-context-files \
			-e "$root/fullscreen/index.ts" -e "$root/toolgroups/index.ts" </dev/null 2>&1
)
status=$?
set -e

if [ "$status" -ne 0 ]; then
	printf '%s\n' "$out" >&2
	echo "smoke: omp exited $status while loading the extensions" >&2
	exit 1
fi

for command in fullscreen toolgroups; do
	if ! grep -q "\"name\":\"$command\"" <<<"$out"; then
		printf '%s\n' "$out" >&2
		echo "smoke: /$command did not register" >&2
		exit 1
	fi
done

echo "smoke: ok"
