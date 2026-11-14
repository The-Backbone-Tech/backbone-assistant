"""Trusted Linux supervisor. The model supplies command text, never this program.

Adopts bubblewrap's user/mount/PID/network namespaces (LGPL-2.0-or-later), following
Codex's bwrap.rs at 360319d8dee62d87e2d59fc0c21805d79519cfed. No Codex code is copied.
An open directory descriptor retains the bounded tmpfs after namespace teardown;
only then may the supervisor checkpoint ordinary files without following links.
"""
import base64
import ctypes
import errno
import fcntl
import json
import os
import platform
import re
import resource
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid

CAPACITY = 32 * 1024 * 1024
PAGE_SIZE = os.sysconf('SC_PAGESIZE')
MAX_FILES = 4096
CGROUP_ROOT = '/sys/fs/cgroup'
MEMORY_MAX = 1024 ** 3
PIDS_MAX = 32
RUNTIME = ['/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/bin', '/sbin', '/lib', '/lib64']
BOOT_ID = str(int(open('/proc/sys/kernel/random/boot_id').read().strip().replace('-', ''), 16))


class WorkspaceRefusal(Exception):
    """No command was admitted; retain the current checkpoint."""


def cgroup_path(pid):
    entries = open('/proc/%d/cgroup' % pid).read().splitlines()
    paths = [line[3:] for line in entries if line.startswith('0::/')]
    if len(paths) != 1:
        raise WorkspaceRefusal('Linux workspace requires delegated cgroup v2 memory and pids controls')
    path = os.path.realpath(CGROUP_ROOT + paths[0])
    if path != CGROUP_ROOT and not path.startswith(CGROUP_ROOT + '/'):
        raise WorkspaceRefusal('Linux workspace cgroup path could not be confirmed')
    return path


def cgroup_parent():
    # Accept an existing delegation, never enable controllers or move the Host.
    # The child moves itself before exec; descendants inherit its hard kernel caps.
    buffer = ctypes.create_string_buffer(256)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.statfs(os.fsencode(CGROUP_ROOT), buffer) != 0 or ctypes.c_long.from_buffer(buffer).value != 0x63677270:
        raise WorkspaceRefusal('Linux workspace requires delegated cgroup v2 memory and pids controls')
    candidate = cgroup_path(os.getpid())
    while candidate != CGROUP_ROOT:
        if (os.stat(candidate).st_uid == os.getuid()
                and os.access(os.path.join(candidate, 'cgroup.procs'), os.W_OK)
                and open(os.path.join(candidate, 'cgroup.type')).read().strip() == 'domain'
                and {'memory', 'pids'} <= set(open(os.path.join(candidate, 'cgroup.subtree_control')).read().split())):
            return candidate
        candidate = os.path.dirname(candidate)
    raise WorkspaceRefusal('Linux workspace requires delegated cgroup v2 memory and pids controls')


def remove_cgroup(path, token):
    if (not path.startswith(CGROUP_ROOT + '/') or os.path.realpath(path) != path
            or not re.fullmatch(r'workspace-%d-\d+-%s' % (os.getuid(), re.escape(token)), os.path.basename(path))):
        raise RuntimeError('Invalid workspace cgroup identity')
    try:
        if os.stat(path).st_uid != os.getuid():
            raise RuntimeError('Workspace cgroup owner changed')
        # rmdir refuses live processes. Never kill an unverified process through a cgroup.
        os.rmdir(path)
    except FileNotFoundError:
        pass


class CommandCgroup:
    def __init__(self, parent, token):
        # Reclaim only empty groups whose creating supervisor is dead. A reused PID
        # retains an empty group until later; it never grants permission to kill it.
        for name in os.listdir(parent):
            match = re.fullmatch(r'workspace-%d-(\d+)-([a-f0-9-]{36})' % os.getuid(), name)
            if match and identity(int(match[1])) is None:
                try:
                    remove_cgroup(os.path.join(parent, name), match[2])
                except OSError:
                    pass
        self.token = token
        self.path = os.path.join(parent, 'workspace-%d-%d-%s' % (os.getuid(), os.getpid(), token))
        self.created = False
        try:
            os.mkdir(self.path, 0o700)
            self.created = True
            for name, value in [('memory.max', str(MEMORY_MAX)), ('memory.swap.max', '0'), ('memory.oom.group', '1'), ('pids.max', str(PIDS_MAX))]:
                with open(os.path.join(self.path, name), 'w') as output:
                    output.write(value)
            self.verify()
        except Exception as error:
            if self.created:
                self.close()
            raise WorkspaceRefusal('Linux workspace delegated cgroup memory/task limits could not be established') from error

    def verify(self):
        for name, value in [('memory.max', str(MEMORY_MAX)), ('memory.swap.max', '0'), ('memory.oom.group', '1'), ('pids.max', str(PIDS_MAX))]:
            if open(os.path.join(self.path, name)).read().strip() != value:
                raise WorkspaceRefusal('Linux workspace cgroup limits could not be confirmed')

    def enter(self):
        with open(os.path.join(self.path, 'cgroup.procs'), 'w') as output:
            output.write(str(os.getpid()))
        limits()

    def oom_killed(self):
        return any(line.startswith('oom_kill ') and int(line.split()[1]) > 0
                   for line in open(os.path.join(self.path, 'memory.events')))

    def close(self):
        remove_cgroup(self.path, self.token)

# util-linux unshare gives only this trusted setup an outer private user/mount
# namespace. It mounts the bounded volume, then execs bubblewrap, which drops all
# capabilities and disables further user namespaces before the admission shell.
SETUP = r'''
import ctypes,json,os,sys
libc=ctypes.CDLL(None,use_errno=True)
size,inodes=int(sys.argv[2]),int(sys.argv[3])
if not os.sysconf('SC_PAGESIZE') <= size <= 33554432 or not 1 <= inodes <= 4096:
 raise RuntimeError('Refusing an unbounded workspace volume')
options=('size='+str(size)+',nr_inodes='+str(inodes)+',mode=0700').encode()
if libc.mount(b'tmpfs',os.fsencode(sys.argv[1]),b'tmpfs',2|4,options) != 0:
 raise OSError(ctypes.get_errno(),'Workspace inode bound could not be established')
argv=json.loads(sys.argv[4])
os.execv(argv[0],argv)
'''


def network_filter():
    # Adopt libseccomp's architecture-aware compiler; bubblewrap loads the sealed BPF.
    # Codex also denies io_uring: it can create VM sockets without socket(). AF_VSOCK
    # can reach the host even with a separate network namespace. This offline workspace
    # refuses every socket family, including Unix sockets entirely inside the sandbox.
    lib = ctypes.CDLL('libseccomp.so.2')
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW; unknown architectures kill.
    if not context:
        raise RuntimeError('Linux network filter allocation failed')
    fd = None
    try:
        for name in ['socket', 'socketpair', 'socketcall', 'connect', 'bind', 'listen', 'accept', 'accept4',
                     'sendto', 'recvfrom', 'sendmsg', 'recvmsg', 'sendmmsg', 'recvmmsg', 'shutdown',
                     'io_uring_setup', 'io_uring_enter', 'io_uring_register',
                     'keyctl', 'add_key', 'request_key', 'perf_event_open',
                     'ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_getfd', 'process_madvise']:
            number = lib.seccomp_syscall_resolve_name(name.encode())
            if number == -1:
                if name in ('socket', 'connect', 'io_uring_setup'):
                    raise RuntimeError('Linux network syscall resolution failed')
                continue
            if lib.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('Linux network filter compilation failed')
        fd = os.memfd_create('workspace-network', os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING)
        if lib.seccomp_export_bpf(context, fd) != 0:
            raise RuntimeError('Linux network filter export failed')
        os.lseek(fd, 0, os.SEEK_SET)
        fcntl.fcntl(fd, fcntl.F_ADD_SEALS, fcntl.F_SEAL_WRITE | fcntl.F_SEAL_SHRINK | fcntl.F_SEAL_GROW | fcntl.F_SEAL_SEAL)
        return fd
    except Exception:
        if fd is not None:
            os.close(fd)
        raise
    finally:
        lib.seccomp_release(context)


def identity(pid):
    try:
        text = open('/proc/%d/stat' % pid).read().rsplit(')', 1)[1].split()
        if text[0] in ('Z', 'X'):
            return None
        status = open('/proc/%d/status' % pid).read()
        uid = int(re.search(r'^Uid:\s*(\d+)', status, re.M).group(1))
        return dict(pid=pid, uid=uid, start=BOOT_ID + ':' + text[19])
    except (FileNotFoundError, ProcessLookupError):
        return None


def namespace(pid, kind='pid'):
    return os.readlink('/proc/%d/ns/%s' % (pid, kind))


def members(record):
    # /proc/PID/ns links require ptrace permission. A child may disable dumpability;
    # PPid in status remains readable. Every member is descended from this PID 1,
    # including setsid/double-forks (orphans reparent to it). Nested user namespaces
    # are disabled, capabilities dropped, and no host namespace descriptor is given.
    if identity(record['pid']) != record['identity']:
        return set()
    parents = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            text = open('/proc/' + name + '/status').read()
            parents[pid] = int(re.search(r'^PPid:\s*(\d+)', text, re.M).group(1))
        except (FileNotFoundError, ProcessLookupError):
            pass
    found = {record['pid']}
    while True:
        added = {pid for pid, parent in parents.items() if parent in found} - found
        if not added:
            return found
        found.update(added)


def stop(record):
    if record['namespace'] == namespace(os.getpid()):
        raise RuntimeError('Refusing to target the supervisor namespace')
    current = identity(record['pid'])
    if current != record['identity']:
        # Linux kills every member when PID 1 exits. A reused pid is never targeted.
        return
    try:
        if namespace(record['pid']) != record['namespace']:
            raise RuntimeError('Namespace identity changed')
        os.kill(record['pid'], signal.SIGKILL)
    except (FileNotFoundError, ProcessLookupError):
        # The cgroup OOM killer may remove PID 1 between inspection and signaling.
        # Its exit kills the namespace; a still-matching live identity remains unconfirmed.
        if identity(record['pid']) == record['identity']:
            raise RuntimeError('Namespace shutdown could not be confirmed')
        return
    deadline = time.monotonic() + 5
    while identity(record['pid']) == record['identity']:
        if time.monotonic() >= deadline:
            raise RuntimeError('Namespace shutdown could not be confirmed')
        time.sleep(.02)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_json(path, value):
    with open(path, 'x') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    sync_dir(os.path.dirname(path))


def copy_tree(source, destination, budget, depth=0):
    """Both sides are directory fds, never paths supplied by engine-created links."""
    if depth > 64:
        raise RuntimeError('Workspace directory depth limit reached')
    for entry in os.scandir(source):
        budget[1] += 1
        if budget[1] > MAX_FILES:
            raise RuntimeError('Workspace checkpoint exceeds 4096 entries')
        info = entry.stat(follow_symlinks=False)
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(entry.name, dir_fd=source)
            budget[0] += len(os.fsencode(target))
            budget[2] += len(os.fsencode(target))
            if budget[2] > 262144:
                raise RuntimeError('Workspace symlink metadata exceeds 256 KiB')
            os.symlink(target, entry.name, dir_fd=destination)
        elif stat.S_ISDIR(info.st_mode):
            os.mkdir(entry.name, 0o700, dir_fd=destination)
            src = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=source)
            dst = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=destination)
            try:
                copy_tree(src, dst, budget, depth + 1)
                os.fsync(dst)
            finally:
                os.close(src)
                os.close(dst)
        elif stat.S_ISREG(info.st_mode):
            budget[0] += info.st_size
            if budget[0] > CAPACITY:
                raise RuntimeError('Workspace checkpoint exceeds 32 MiB')
            src = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source)
            dst = os.open(entry.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if info.st_mode & 0o111 else 0o600, dir_fd=destination)
            try:
                if not stat.S_ISREG(os.fstat(src).st_mode):
                    raise RuntimeError('Workspace file changed type')
                left = info.st_size
                while left:
                    chunk = os.read(src, min(left, 65536))
                    if not chunk:
                        raise RuntimeError('Workspace checkpoint was truncated')
                    view = memoryview(chunk)
                    while view:
                        view = view[os.write(dst, view):]
                    left -= len(chunk)
                os.fsync(dst)
            finally:
                os.close(src)
                os.close(dst)
        else:
            raise RuntimeError('Workspace checkpoint refuses sockets, devices and FIFOs')
        if budget[0] > CAPACITY:
            raise RuntimeError('Workspace checkpoint exceeds 32 MiB')


def copy_directory(source, destination, budget):
    src = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    dst = os.open(destination, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        copy_tree(src, dst, budget)
    finally:
        os.close(src)
        os.close(dst)


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    # pids.max counts the entire command's tasks independently of other same-UID jobs.


def checkpoint(folder):
    pointer = os.path.join(folder, 'checkpoint.json')
    if not os.path.exists(pointer):
        return None
    name = json.load(open(pointer))['generation']
    if not re.fullmatch(r'generation-[a-f0-9-]{36}', name):
        raise RuntimeError('Invalid checkpoint identity')
    return os.path.join(folder, name)


def discard_unpublished(folder):
    current = checkpoint(folder)
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if re.fullmatch(r'generation-[a-f0-9-]{36}', name) and path != current:
            shutil.rmtree(path)


def storage_needed(path):
    """Conservative pages/inodes required to restore a trusted checkpoint."""
    pages, entries = 0, 0
    for entry in os.scandir(path):
        entries += 1
        info = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            child_pages, child_entries = storage_needed(entry.path)
            pages += child_pages
            entries += child_entries
        elif stat.S_ISREG(info.st_mode):
            pages += (info.st_size + PAGE_SIZE - 1) // PAGE_SIZE * PAGE_SIZE
        elif stat.S_ISLNK(info.st_mode):
            size = len(os.fsencode(os.readlink(entry.path)))
            # Linux shmem.c SHORT_SYMLINK_LEN counts the terminating NUL: a
            # 128-byte target already needs a page, rather than inline storage.
            if size >= 128:
                pages += (size + PAGE_SIZE - 1) // PAGE_SIZE * PAGE_SIZE
        else:
            raise RuntimeError('Invalid checkpoint file type')
    return pages, entries


def run(folder, token, parent, preflight=False):
    # Close the death race before starting anything that may run model text.
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        raise RuntimeError('Supervisor parent identity unavailable')
    message = dict(command='true', inputs=[], expiresAt=int(time.time() * 1000) + 30000) if preflight else json.loads(sys.stdin.buffer.readline())
    if os.getuid() == 0:
        raise WorkspaceRefusal('Linux workspace must run as an unprivileged user')
    if platform.machine() != 'aarch64':
        raise WorkspaceRefusal('Linux workspace is qualified only on arm64; this architecture is unqualified')
    resource_parent = cgroup_parent()
    command = message['command']
    if not isinstance(command, str) or len(command) > 32000:
        raise WorkspaceRefusal('Invalid workspace command')
    deadline = time.monotonic() + min(30, message['expiresAt'] / 1000 - time.time())
    if deadline <= time.monotonic():
        raise WorkspaceRefusal('Workspace expired')
    previous = checkpoint(folder)
    pointer = os.path.join(folder, 'checkpoint.json')
    # Only the current generation is retained. Interrupted staging was never published.
    discard_unpublished(folder)
    generation = os.path.join(folder, 'generation-' + str(uuid.uuid4()))
    os.mkdir(generation, 0o700)
    inputs = os.path.join(generation, 'inputs')
    os.mkdir(inputs, 0o700)
    work_snapshot = os.path.join(generation, 'work')
    os.mkdir(work_snapshot, 0o700)
    mountpoint = os.path.join(generation, 'mount')
    os.mkdir(mountpoint, 0o700)
    budget = [0, 0, 0]
    if previous:
        copy_directory(os.path.join(previous, 'inputs'), inputs, budget)
    for item in message['inputs']:
        if not re.fullmatch(r'[A-Za-z0-9_-]+\.[a-z0-9]+', item['name']):
            raise WorkspaceRefusal('Invalid input name')
        data = base64.b64decode(item['base64'], validate=True)
        if len(data) > 10000000:
            raise WorkspaceRefusal('Oversized workspace input')
        path = os.path.join(inputs, item['name'])
        if os.path.exists(path):
            if open(path, 'rb').read() != data:
                raise RuntimeError('Workspace input identity changed')
        else:
            if budget[0] + len(data) > CAPACITY - 262144 - PAGE_SIZE or budget[1] >= 128:
                raise WorkspaceRefusal('Workspace input capacity reached; the previous workspace was retained and no command ran')
            with open(path, 'xb') as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            budget[0] += len(data)
            budget[1] += 1
    size = (CAPACITY - budget[0] - 262144) // PAGE_SIZE * PAGE_SIZE
    inodes = MAX_FILES - budget[1]
    needed_bytes, needed_entries = storage_needed(os.path.join(previous, 'work')) if previous else (0, 0)
    if size < PAGE_SIZE or needed_bytes > size or needed_entries + 1 > inodes:
        raise WorkspaceRefusal('Workspace input capacity reached; the retained files still need this space, so the previous workspace was retained and no command ran')
    info_read, info_write = os.pipe()
    filter_fd = network_filter()
    argv = ['/usr/bin/bwrap', '--die-with-parent', '--new-session', '--unshare-all', '--unshare-user', '--disable-userns', '--assert-userns-disabled', '--cap-drop', 'ALL', '--seccomp', str(filter_fd), '--clearenv']
    for path in RUNTIME:
        if os.path.exists(path):
            argv += ['--ro-bind', path, path]
    for path in ['/etc/ld.so.cache', '/etc/alternatives']:
        if os.path.exists(path):
            argv += ['--ro-bind', path, path]
    argv += ['--proc', '/proc', '--remount-ro', '/proc', '--dev', '/dev', '--remount-ro', '/dev',
             '--dir', '/workspace', '--bind', mountpoint, '/workspace/work',
             '--ro-bind', inputs, '/workspace/inputs', '--symlink', '/workspace/work', '/tmp',
             '--remount-ro', '/', '--chdir', '/workspace/work', '--setenv', 'PATH', '/usr/bin:/bin',
             '--setenv', 'HOME', '/workspace/work', '--setenv', 'TMPDIR', '/workspace/work',
             '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'PYTHONNOUSERSITE', '1', '--info-fd', str(info_write),
             '--', '/bin/bash', '--noprofile', '--norc', '-c',
             'printf "%s\\n" "$1"; read -r admission || exit 125; umask 077; exec /bin/bash --noprofile --norc -c "$2" </dev/null', 'workspace', token, command]
    launch = ['/usr/bin/unshare', '--user', '--map-root-user', '--mount', '--propagation', 'private',
              '/usr/bin/python3', '-I', '-S', '-c', SETUP, mountpoint,
              str(size), str(inodes), json.dumps(argv)]
    proc = None
    record = None
    work = None
    code = None
    reason = None
    output = [bytearray(), bytearray()]
    ready = bytearray()
    admitted = False
    group = None
    selector = selectors.DefaultSelector()
    try:
        group = CommandCgroup(resource_parent, token)
        proc = subprocess.Popen(launch, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                pass_fds=(info_write, filter_fd), env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, preexec_fn=group.enter)
        os.close(info_write)
        info_write = None
        selector.register(proc.stdout, selectors.EVENT_READ, 0)
        selector.register(proc.stderr, selectors.EVENT_READ, 1)
        if not preflight:
            selector.register(sys.stdin.buffer, selectors.EVENT_READ, 2)
        # Output begins only after bubblewrap has finished the entire namespace setup.
        while proc.poll() is None and not admitted and reason is None:
            if time.monotonic() > deadline:
                reason = 'time limit'
                break
            for key, _ in selector.select(.1):
                data = os.read(key.fd, 65536)
                if key.data == 2:
                    if not data:
                        reason = 'host disconnected'
                    continue
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                if key.data == 1:
                    output[1].extend(data[:65536 - len(output[1])])
                else:
                    ready.extend(data)
                    if len(ready) > 256 or b'\n' in ready and ready != (token + '\n').encode():
                        raise RuntimeError('Namespace admission handshake changed')
                    if ready == (token + '\n').encode():
                        info_bytes = bytearray()
                        while True:
                            chunk = os.read(info_read, 4096)
                            if not chunk:
                                break
                            info_bytes.extend(chunk)
                            if len(info_bytes) > 65536:
                                raise RuntimeError('Namespace information exceeded its bound')
                        info = json.loads(info_bytes)
                        pid = info['child-pid']
                        record = dict(pid=pid, identity=identity(pid), namespace=namespace(pid), cgroup=group.path)
                        if any(namespace(pid, kind) == namespace(os.getpid(), kind) for kind in ('pid', 'net', 'user')) or not record['identity']:
                            raise RuntimeError('Namespace isolation unavailable')
                        status = open('/proc/%d/status' % pid).read()
                        if any(int(re.search(r'^' + field + r':\s*(\w+)', status, re.M).group(1), 16) != 0 for field in ('CapEff', 'CapBnd')):
                            raise RuntimeError('Namespace capabilities were not dropped')
                        group.verify()
                        if cgroup_path(pid) != group.path:
                            raise RuntimeError('Namespace resource cgroup membership could not be confirmed')
                        work = os.open('/proc/%d/root/workspace/work' % pid, os.O_RDONLY | os.O_DIRECTORY)
                        if previous:
                            src = os.open(os.path.join(previous, 'work'), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                            try:
                                copy_tree(src, work, budget.copy())
                            finally:
                                os.close(src)
                        # The work submount is writable; its parent is part of the read-only
                        # root mount. Permissions alone would let the owner chmod that parent.
                        write_json(os.path.join(folder, '.namespace-' + token), record)
                        proc.stdin.write(b'run\n')
                        proc.stdin.flush()
                        admitted = True
        while admitted and proc.poll() is None and reason is None:
            if time.monotonic() > deadline:
                reason = 'time limit'
                break
            for key, _ in selector.select(.1):
                data = os.read(key.fd, 65536)
                if key.data == 2:
                    if not data:
                        reason = 'host disconnected'
                    continue
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                used = len(output[0]) + len(output[1])
                output[key.data].extend(data[:max(0, 65536 - used)])
                if used + len(data) > 65536:
                    reason = 'output limit'
        if not admitted and reason is None:
            reason = 'Linux namespace setup refused; bubblewrap, unprivileged user namespaces and tmpfs are required'
    finally:
        if record:
            stop(record)
        if proc:
            if proc.poll() is None:
                proc.kill()
            code = proc.wait(timeout=5)
            # Namespace shutdown closes all writers. Drain EOF before publishing a result.
            for index, pipe in enumerate([proc.stdout, proc.stderr]):
                rest = pipe.read()
                used = len(output[0]) + len(output[1])
                output[index].extend(rest[:max(0, 65536 - used)])
                if used + len(rest) > 65536:
                    reason = reason or 'output limit'
        if group:
            if group.oom_killed():
                reason = 'stopped: the workspace reached its hard 1 GiB cgroup memory limit'
            try:
                group.close()
            except (OSError, RuntimeError):
                # Teardown already stopped the namespace. A busy or changed-owner
                # group stays for identity-checked recovery; keep the result and checkpoint.
                pass
        selector.close()
        os.close(info_read)
        os.close(filter_fd)
        if info_write is not None:
            os.close(info_write)
    if admitted:
        dst = os.open(work_snapshot, os.O_RDONLY | os.O_DIRECTORY)
        try:
            copy_tree(work, dst, budget)
            os.fsync(dst)
        finally:
            os.close(dst)
            os.close(work)
        sync_dir(inputs)
        sync_dir(generation)
        temporary = pointer + '.new'
        if os.path.exists(temporary):
            os.unlink(temporary)
        write_json(temporary, dict(generation=os.path.basename(generation)))
        os.replace(temporary, pointer)
        sync_dir(folder)
        if previous:
            shutil.rmtree(previous)
    else:
        shutil.rmtree(generation)
    try:
        text = [bytes(part).decode('utf-8') for part in output]
    except UnicodeDecodeError:
        text = ['', '(binary output; encode it as base64 to return it)']
        reason = reason or 'non-UTF8 output'
    result = dict(code=code, stdout=text[0], stderr=text[1])
    if reason:
        result['reason'] = reason
    return result


mode = sys.argv[1]
if mode == 'identity':
    print(json.dumps(identity(int(sys.argv[2]))))
elif mode in ('stop', 'list'):
    permit, refuse = sys.argv[2:4]
    token = os.path.basename(permit).removeprefix('.permit-')
    if not re.fullmatch(r'[a-f0-9-]{36}', token) or refuse != os.path.join(os.path.dirname(permit), '.refuse-' + token):
        raise RuntimeError('Invalid namespace ownership token')
    path = os.path.join(os.path.dirname(permit), '.namespace-' + token)
    if mode == 'list':
        result = []
        if os.path.exists(path):
            for pid in members(json.load(open(path))):
                current = identity(pid)
                if current:
                    text = open('/proc/%d/status' % pid).read()
                    current['namespacePid'] = int(re.search(r'^NSpid:\s*(.*)', text, re.M).group(1).split()[-1])
                    result.append(current)
        print(json.dumps(result))
        sys.exit(0)
    if os.path.exists(path):
        record = json.load(open(path))
        stop(record)
        if 'cgroup' in record:
            remove_cgroup(record['cgroup'], token)
        os.unlink(path)
    print('stopped')
elif mode == 'run':
    try:
        print(json.dumps(run(sys.argv[2], sys.argv[3], int(sys.argv[4]))))
    except WorkspaceRefusal as error:
        discard_unpublished(sys.argv[2])
        print(json.dumps(dict(code=None, stdout='', stderr='', reason=str(error))))
    except Exception:
        # Never publish successful cleanup or scratch after an unconfirmed operation.
        with open(os.path.join(sys.argv[2], '.retiring'), 'w'):
            pass
        print(json.dumps(dict(code=None, stdout='', stderr='', reason='Linux workspace execution or checkpoint could not be confirmed; scratch was retired')))
elif mode == 'preflight':
    try:
        print(json.dumps(run(sys.argv[2], str(uuid.uuid4()), os.getppid(), preflight=True)))
    except WorkspaceRefusal as error:
        print(json.dumps(dict(code=None, reason=str(error))))
    except Exception:
        print(json.dumps(dict(code=None, reason='Linux namespace, volume or seccomp preflight refused execution')))
else:
    raise RuntimeError('Unknown supervisor operation')
