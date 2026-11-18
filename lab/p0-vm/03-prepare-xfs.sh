#!/usr/bin/env bash
set -euo pipefail
check_only=0
if [ "${1:-}" = '--check' ]; then check_only=1; fi
out="${P0_EVIDENCE_DIR:-lab/p0-vm/evidence}"; mkdir -p "$out"; exec > >(tee "$out/03-prepare-xfs.log") 2>&1
: "${P0_XFS_DEVICE:?Définir P0_XFS_DEVICE sur un volume dédié}"
: "${P0_XFS_MOUNT:?Définir P0_XFS_MOUNT sur un point de montage dédié}"
[ "$(id -u)" -eq 0 ] || { echo 'FAIL administrative-root-required'; exit 2; }
device="$(readlink -f -- "$P0_XFS_DEVICE")"; [ -b "$device" ] || { echo "FAIL not-block-device=$device"; exit 1; }
mountpoint="$(readlink -f -m -- "$P0_XFS_MOUNT")"; root_source="$(findmnt -no SOURCE / || true)"
findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS || true
[ "$device" != "$root_source" ] || { echo 'FAIL device-is-root-source'; exit 1; }
findmnt -S "$device" && { echo 'FAIL device-already-mounted'; exit 1; } || true
[ -z "$(lsblk -no PKNAME "$device" 2>/dev/null || true)" ] || { echo 'FAIL partition-or-child-device-not-explicitly-approved'; exit 1; }
[ -z "$(lsblk -nr -o NAME "$device" 2>/dev/null | sed 1d)" ] || { echo 'FAIL disk-has-partitions'; exit 1; }
case "$(lsblk -no TYPE "$device" 2>/dev/null || true)" in crypt|lvm|md|raid|loop) echo 'FAIL ambiguous-device-type'; exit 1;; esac
swapon --show=NAME --noheadings 2>/dev/null | grep -Fxq "$device" && { echo 'FAIL device-is-swap'; exit 1; } || true
mkdir -p "$mountpoint"; [ -z "$(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo 'FAIL mountpoint-not-empty'; exit 1; }
if [ "$check_only" -eq 1 ] || [ "${P0_XFS_VERIFY_ONLY:-0}" = 1 ]; then echo 'PASS preflight-only-no-format'; exit 0; fi
expected="${P0_CONFIRM_FORMAT:-}"; [ "$expected" = "$device" ] || { echo "FAIL explicit-confirmation-required expected=$device"; exit 1; }
[ "${P0_ALLOW_FORMAT:-}" = YES ] || { echo 'FAIL set P0_ALLOW_FORMAT=YES for one explicit destructive format'; exit 1; }
mkfs.xfs -f "$device"; mount -o prjquota "$device" "$mountpoint"; findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS "$mountpoint"; echo 'PASS xfs-prepared'
