"""Trusted macOS supervisor helper. No process arguments, environments or private files are read.
libproc supplies uid/status/start time; Seatbelt permission checks identify this call's descendants,
including reparented setsid children. The two existing nonce files are an OS-policy label only.
"""
import ctypes
import json
import os
import resource
import signal
import struct
import sys
import time

proc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
proc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
sandbox = ctypes.CDLL('/usr/lib/libsandbox.dylib', use_errno=True)
check = sandbox.sandbox_check
check.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
check.restype = ctypes.c_int
flags = 1 | ctypes.c_int.in_dll(sandbox, 'SANDBOX_CHECK_NO_REPORT').value  # PATH, no logging


def identity(pid, include_zombies=False):
    # SDK sys/proc_info.h: PROC_PIDTBSDINFO (3), struct proc_bsdinfo (136 bytes).
    buf = ctypes.create_string_buffer(136)
    if proc.proc_pidinfo(pid, 3, 0, buf, len(buf)) != len(buf):
        return None
    status = struct.unpack_from('=I', buf, 4)[0]
    uid = struct.unpack_from('=I', buf, 28)[0]  # real uid; include set-id executables owned by this caller
    sec, usec = struct.unpack_from('=QQ', buf, 120)
    if status == 5 and not include_zombies:  # SZOMB: cannot execute or fork; waiting for its parent to reap.
        return None
    return {'pid': pid, 'uid': uid, 'start': '%d:%d' % (sec, usec)}


def processes(include_zombies=False):
    count = proc.proc_listallpids(None, 0)
    if count <= 0:
        raise RuntimeError('libproc process enumeration failed')
    ids = (ctypes.c_int * (count + 1024))()
    used = proc.proc_listallpids(ids, ctypes.sizeof(ids))
    if used <= 0 or used >= len(ids):
        raise RuntimeError('libproc process enumeration was incomplete')
    return [item for pid in ids[:used] if pid > 1
            for item in [identity(pid, include_zombies)] if item and item['uid'] == os.getuid()]


def carries(item, permit, refuse):
    return (check(item['pid'], b'file-read-metadata', flags, ctypes.c_char_p(permit.encode())) == 0
            and check(item['pid'], b'file-read-metadata', flags, ctypes.c_char_p(refuse.encode())) == 1)


def stop_all(permit, refuse):
    deadline = time.monotonic() + 5
    empty = 0
    while time.monotonic() < deadline:
        found = [p for p in processes() if carries(p, permit, refuse)]
        if not found:
            empty += 1
            if empty == 2:
                return
        else:
            empty = 0
            # Freeze each verified process first, so a fork loop cannot outrun cleanup.
            for item in found:
                if identity(item['pid']) == item and carries(item, permit, refuse):
                    try:
                        os.kill(item['pid'], signal.SIGSTOP)
                    except ProcessLookupError:
                        pass
            for item in found:
                if identity(item['pid']) == item and carries(item, permit, refuse):
                    try:
                        os.kill(item['pid'], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        time.sleep(.02)
    raise RuntimeError('Sandbox descendants have not all stopped')


mode = sys.argv[1]
if mode == 'identity':
    print(json.dumps(identity(int(sys.argv[2]))))
elif mode == 'headroom':
    hard = resource.getrlimit(resource.RLIMIT_NPROC)[1]
    print(min(len(processes(True)) + 32, hard) if hard != resource.RLIM_INFINITY else len(processes(True)) + 32)
elif mode == 'stop':
    stop_all(sys.argv[2], sys.argv[3])
elif mode == 'usage':
    base = (ctypes.c_uint32 * 2)()
    if ctypes.CDLL(None).mach_timebase_info(ctypes.byref(base)) != 0 or not base[1]:
        raise RuntimeError('Mach CPU timebase is unavailable')
    values, memory = [], 0
    for item in processes():
        if not carries(item, sys.argv[2], sys.argv[3]):
            continue
        buf = ctypes.create_string_buffer(96)  # SDK proc_taskinfo, PROC_PIDTASKINFO (4).
        if proc.proc_pidinfo(item['pid'], 4, 0, buf, len(buf)) != len(buf):
            if identity(item['pid']) == item:
                raise RuntimeError('Live sandbox CPU accounting is unavailable')
            continue
        # SDK sys/resource.h: RUSAGE_INFO_V0, 96 bytes, ri_phys_footprint at 72.
        # Kernel footprint charges include compressed memory, unlike resident size alone.
        usage = ctypes.create_string_buffer(96)
        if proc.proc_pid_rusage(item['pid'], 0, usage) != 0:
            if identity(item['pid']) == item:
                raise RuntimeError('Live sandbox memory accounting is unavailable')
            continue
        if identity(item['pid']) != item or not carries(item, sys.argv[2], sys.argv[3]):
            continue
        user, system = struct.unpack_from('=QQ', buf, 16)  # Mach ticks, includes exited threads (XNU fill_taskprocinfo)
        values.append((user + system) * base[0] / base[1] / 1e9)
        memory += struct.unpack_from('=Q', usage, 72)[0]
    print(json.dumps({'cpuSeconds': values, 'memoryBytes': memory}))
elif mode == 'list':
    print(json.dumps([p for p in processes() if carries(p, sys.argv[2], sys.argv[3])]))
else:
    raise RuntimeError('Unknown process operation')
