#!/usr/bin/env bash
set -euo pipefail
: "${P0_XFS_MOUNT:?Définir P0_XFS_MOUNT}"
: "${P0_WORKSPACE_QUOTA_BYTES:?Définir P0_WORKSPACE_QUOTA_BYTES}"
[ "$(id -u)" -eq 0 ] || { echo 'Cette étape administrative nécessite root explicite.' >&2; exit 2; }
command -v xfs_quota >/dev/null
workspace="$P0_XFS_MOUNT/workspace"; mkdir -p "$workspace"; chown "${SUDO_USER:-$USER}:${SUDO_USER:-$USER}" "$workspace"
proj="${P0_PROJECT_ID:-1001}"
printf '%s:%s\n' "$proj" "$workspace" >> /etc/projects
printf '%s:%s\n' "$proj" "cortex-p0" >> /etc/projid
xfs_quota -x -c "project -s cortex-p0" "$P0_XFS_MOUNT"
xfs_quota -x -c "limit -p bhard=$P0_WORKSPACE_QUOTA_BYTES $proj" "$P0_XFS_MOUNT"
xfs_quota -x -c "report -p" "$P0_XFS_MOUNT"
