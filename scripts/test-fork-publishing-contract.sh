#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fork_workflow="$repo_root/.github/workflows/fork-desktop-artifacts.yml"
docker_workflow="$repo_root/.github/workflows/docker.yml"
sprig_workflow="$repo_root/.github/workflows/sprig-image.yml"
helm_workflow="$repo_root/.github/workflows/helm-chart.yml"
push_gateway_helm_workflow="$repo_root/.github/workflows/push-gateway-helm-chart.yml"

require_literal() {
  local file=$1
  local needle=$2
  grep -Fq -- "$needle" "$file" || {
    echo "fork publishing contract is missing required text in $(basename "$file"): $needle" >&2
    exit 1
  }
}

for file in "$docker_workflow" "$sprig_workflow" "$helm_workflow" "$push_gateway_helm_workflow"; do
  require_literal "$file" "github.repository_owner"
  require_literal "$file" "github.repository == 'block/buzz'"
done
require_literal "$docker_workflow" "GATEWAY_IMAGE_NAME"
require_literal "$push_gateway_helm_workflow" "GHCR_PUSH_GATEWAY_CHART_REPO"

require_literal "$fork_workflow" "if: github.repository != 'block/buzz'"
require_literal "$fork_workflow" "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
require_literal "$fork_workflow" "--no-sign"
require_literal "$fork_workflow" '"createUpdaterArtifacts": false'
require_literal "$fork_workflow" '"endpoints": []'
require_literal "$fork_workflow" "permissions: {}"

for forbidden in \
  "block/apple-codesign-action" \
  "id-token:" \
  "TAURI_SIGNING" \
  "BUZZ_UPDATER_" \
  "gh release" \
  "contents: write"; do
  if grep -Fq -- "$forbidden" "$fork_workflow"; then
    echo "fork artifact workflow contains forbidden upstream release capability: $forbidden" >&2
    exit 1
  fi
done

echo "fork publishing contract passed"
