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

# omp 19 exits 1 in RPC mode when no default model is available
# ("No default model selected"), which has nothing to do with these extensions:
# CI has no credentials, so the check used to fail or pass depending on ambient
# model discovery. Give omp a throwaway provider from a private HOME so startup
# is deterministic. Nothing contacts the network; the model only has to exist
# for session creation to finish.
smoke_home="$work/home"
mkdir -p "$smoke_home/.omp/agent"
cat >"$smoke_home/.omp/agent/models.yml" <<'YAML'
providers:
  smoke:
    baseUrl: http://127.0.0.1:9/v1
    apiKey: smoke
    api: openai-completions
    models:
      - id: smoke-model
        name: Smoke Model
YAML

set +e
out=$(
	cd "$work" &&
		env HOME="$smoke_home" timeout 60 omp --mode rpc --no-ui --no-extensions --no-session --no-skills --no-context-files \
			--model smoke/smoke-model \
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
