#!/bin/bash
# Namespace privé : pivot_root retire l’hôte, env -i retire les secrets, setpriv retire les capabilities.
# Ce n’est pas un conteneur Docker : pas de cgroup, pas d’image, pas de lecture seule du système.
set -eu
root=$1
work=$2
nproc=$3
shift 3
case "$nproc" in
  ''|*[!0-9]*) exit 2 ;;
esac
mkdir -p "$root/usr" "$root/bin" "$root/lib" "$root/lib64" "$root/work" "$root/tmp" "$root/proc" "$root/oldroot"
cd "$root"
mount --bind "$root" "$root"
cd "$root"
mount --bind /usr usr
if [ -d /bin ]; then mount --bind /bin bin; fi
if [ -d /lib ]; then mount --bind /lib lib; fi
if [ -d /lib64 ]; then mount --bind /lib64 lib64; fi
mount --bind "$work" work
mount -t tmpfs -o nosuid,nodev,mode=1777 tmpfs tmp
mount -t proc proc proc
hostprocs=$(ps -u "$(id -u)" --no-headers 2>/dev/null | wc -l | tr -dc '0-9' || true)
case "$hostprocs" in ''|*[!0-9]*) hostprocs=99999 ;; esac
pivot_root . oldroot
cd /
/bin/umount -l /oldroot
rmdir /oldroot || true
exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 LC_ALL=C.UTF-8 TMPDIR=/tmp \
  /usr/bin/setpriv --bounding-set -all --inh-caps -all --ambient-caps -all --nnp -- \
  /bin/bash --noprofile --norc -c 'if [ "$1" -gt "$2" ]; then ulimit -u "$1" || exit 126; fi; ulimit -n 128 || exit 126; shift 2; cd /work && exec "$@"' bash "$nproc" "$hostprocs" "$@"
