#!/usr/bin/env python3
import ctypes
import ctypes.util
import errno
import os
import stat
import sys
import shutil

SYS_OPENAT2 = 437
RESOLVE_NO_XDEV = 0x01
RESOLVE_NO_MAGICLINKS = 0x02
RESOLVE_NO_SYMLINKS = 0x04
RESOLVE_BENEATH = 0x08
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
MAX_FILES = 200_000
MAX_BYTES = 4 * 1024 * 1024 * 1024
file_count = 0
total_bytes = 0

class OpenHow(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_ulonglong), ("mode", ctypes.c_ulonglong), ("resolve", ctypes.c_ulonglong)]

libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

def openat2(dirfd, name, flags, mode=0):
    how = OpenHow(flags, mode, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
    fd = libc.syscall(SYS_OPENAT2, dirfd, os.fsencode(name), ctypes.byref(how), ctypes.sizeof(how))
    if fd < 0:
        err = ctypes.get_errno()
        raise OSError(err, os.strerror(err), name)
    return fd

def copy_tree(src, dst):
    srcfd = os.open(src, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | O_CLOEXEC)
    dstfd = os.open(dst, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | O_CLOEXEC)
    try:
        copy_dir(srcfd, dstfd)
    finally:
        os.close(srcfd)
        os.close(dstfd)

def copy_dir(srcfd, dstfd):
    global file_count, total_bytes
    for entry in os.scandir(f"/proc/self/fd/{srcfd}"):
        name = entry.name
        sfd = None
        dfd = None
        try:
            st = os.stat(name, dir_fd=srcfd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode) or not (stat.S_ISREG(st.st_mode) or stat.S_ISDIR(st.st_mode)) or (stat.S_ISREG(st.st_mode) and st.st_nlink != 1):
                raise RuntimeError(f"unsafe workspace object: {name}")
            if stat.S_ISDIR(st.st_mode):
                os.mkdir(name, dir_fd=dstfd, mode=st.st_mode & 0o777)
                sfd = openat2(srcfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | O_CLOEXEC)
                dfd = openat2(dstfd, name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | O_CLOEXEC)
                opened = os.fstat(sfd)
                if opened.st_ino != st.st_ino or opened.st_dev != st.st_dev or opened.st_nlink < 2:
                    raise RuntimeError(f"workspace identity changed: {name}")
                copy_dir(sfd, dfd)
            else:
                file_count += 1
                if file_count > MAX_FILES or st.st_size > MAX_BYTES or total_bytes + st.st_size > MAX_BYTES:
                    raise RuntimeError("workspace size or file-count limit exceeded")
                sfd = openat2(srcfd, name, os.O_RDONLY | os.O_NOFOLLOW | O_CLOEXEC)
                opened = os.fstat(sfd)
                if opened.st_ino != st.st_ino or opened.st_dev != st.st_dev or opened.st_nlink != 1:
                    raise RuntimeError(f"workspace identity changed: {name}")
                dfd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | O_CLOEXEC, st.st_mode & 0o666, dir_fd=dstfd)
                copied = 0
                while True:
                    chunk = os.read(sfd, 1024 * 1024)
                    if not chunk:
                        break
                    offset = 0
                    while offset < len(chunk):
                        written = os.write(dfd, chunk[offset:])
                        if written <= 0:
                            raise RuntimeError(f"partial workspace write: {name}")
                        offset += written
                        copied += written
                final = os.fstat(sfd)
                if final.st_ino != opened.st_ino or final.st_size != opened.st_size or final.st_mtime_ns != opened.st_mtime_ns or final.st_ctime_ns != opened.st_ctime_ns or copied != final.st_size:
                    raise RuntimeError(f"workspace changed while reading: {name}")
                os.fsync(dfd)
                total_bytes += copied
        finally:
            if sfd is not None:
                os.close(sfd)
            if dfd is not None:
                os.close(dfd)

if len(sys.argv) != 3:
    print("usage: copy-workspace-secure.py SOURCE DEST", file=sys.stderr)
    sys.exit(2)
try:
    copy_tree(os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2]))
except OSError as exc:
    print(f"secure-copy-error: {exc}", file=sys.stderr)
    shutil.rmtree(os.path.abspath(sys.argv[2]), ignore_errors=True)
    sys.exit(77 if exc.errno == errno.ENOSYS else 1)
except Exception as exc:
    print(f"secure-copy-error: {exc}", file=sys.stderr)
    shutil.rmtree(os.path.abspath(sys.argv[2]), ignore_errors=True)
    sys.exit(1)
