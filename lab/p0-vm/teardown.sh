#!/usr/bin/env bash
set -euo pipefail
[ "${P0_CONFIRM_TEARDOWN:-}" = YES ] || { echo 'Refus: définir P0_CONFIRM_TEARDOWN=YES pour un nettoyage destructif.' >&2; exit 2; }
if [ -n "${P0_XFS_MOUNT:-}" ] && mountpoint -q "$P0_XFS_MOUNT"; then sudo umount "$P0_XFS_MOUNT"; fi
echo 'Teardown terminé; la suppression du périphérique est volontairement non automatisée.'
