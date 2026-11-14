#!/usr/bin/python3
"""Owned canaries only. No account/model, system service message, or sandbox implementation."""
import errno, json, os, selectors, signal, socket, subprocess, sys, threading, time

def blocked(operation):
    try:
        operation()
        return 'allowed'
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EPERM, errno.ENOENT, errno.ENOTDIR, errno.EROFS, errno.EAFNOSUPPORT, errno.ENETUNREACH, errno.ECONNREFUSED):
            return 'denied'
        raise

def content(path, token):
    def read():
        with open(path) as file:
            if file.read() != token:
                raise OSError(errno.EACCES, 'masked')
    return blocked(read)

DNS_QUERY = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x05owned\x07invalid\x00\x00\x01\x00\x01'

def client(spec):
    token = spec['token']
    result = {'single_file_initial': content(spec['single'], token)}
    print(json.dumps({'ready': True, **result}), flush=True)
    deadline = time.monotonic() + 10
    while not os.path.exists(spec['release']):
        if time.monotonic() > deadline: raise RuntimeError('release timeout')
        time.sleep(.01)
    result.update(single_file_renamed=content(spec['single'], token), created_path=content(spec['late'] + '/canary', token),
                  data_home=content(spec['data_home'] + '/canary', token), arrangement=content(spec['arrangement'] + '/canary', token))
    def ip(port, payload):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(1)
            sock.sendto(payload, ('127.0.0.1', port))
            reply, _ = sock.recvfrom(2048)
            if port == spec['dns'] and (reply[:2] != payload[:2] or reply[2:4] != b'\x81\x80'):
                raise RuntimeError('DNS positive response invalid')
    def stream(path):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(1); sock.connect(path); sock.sendall(token.encode()); sock.recv(128)
    def abstract_sendmsg():
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.sendmsg([token.encode()], [], 0, '\0' + spec['abstract_datagram'])
    def sendmsg():
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as sock:
            sock.sendmsg([token.encode()], [], 0, spec['datagram'])  # deliberately unconnected; never sendto
    result.update(udp=blocked(lambda: ip(spec['udp'], token.encode())),
                  dns=blocked(lambda: ip(spec['dns'], DNS_QUERY)),
                  unix_stream=blocked(lambda: stream(spec['stream'])), abstract_stream=blocked(lambda: stream('\0' + spec['abstract'])),
                  abstract_datagram_sendmsg=blocked(abstract_sendmsg), unix_datagram_sendmsg=blocked(sendmsg), host_datagram_visible=os.path.exists(spec['datagram']), run_visible=os.path.exists(spec['run_root']))
    try: result['network_namespace_distinct'] = os.readlink('/proc/self/ns/net') != spec['host_network_namespace']
    except OSError: result['network_namespace_distinct'] = None
    try:
        result['pid_namespace_distinct'] = os.readlink('/proc/self/ns/pid') != spec['host_pid_namespace']
        result['fresh_proc'] = result['pid_namespace_distinct'] and os.readlink('/proc/self') == str(os.getpid())
    except OSError as error:
        if error.errno not in (errno.ENOENT, errno.EACCES, errno.EPERM): raise
        result['fresh_proc'] = False
        result['pid_namespace_distinct'] = None
    result['proc_cmdline'] = blocked(lambda: open('/proc/%d/cmdline' % spec['host_pid'], 'rb').read())
    result['proc_environ'] = blocked(lambda: open('/proc/%d/environ' % spec['host_pid'], 'rb').read())
    print(json.dumps(result), flush=True)

def host(spec):
    sockets, threads, hits = [], [], []
    stopped = threading.Event()
    delivered = threading.Event()
    def serve(sock, name, stream=False):
        sockets.append(sock); sock.settimeout(.2)
        def loop():
            while not stopped.is_set():
                try:
                    if stream:
                        peer, _ = sock.accept()
                        with peer:
                            peer.settimeout(1); peer.recv(2048); hits.append(name); peer.sendall(b'owned')
                    else:
                        payload, address = sock.recvfrom(2048); hits.append(name); delivered.set()
                        if address:
                            reply = (payload[:2] + b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00' + payload[12:] + b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x00\x00\x04\x7f\x00\x00\x01') if name == 'dns' else b'owned'
                            sock.sendto(reply, address)
                except socket.timeout: pass
                except OSError:
                    if not stopped.is_set(): raise
        thread = threading.Thread(target=loop, daemon=True); threads.append(thread); thread.start()
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); udp.bind(('127.0.0.1', 0)); serve(udp, 'udp')
    dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); dns.bind(('127.0.0.1', 0)); serve(dns, 'dns')
    stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); stream.bind(spec['stream']); stream.listen(); serve(stream, 'unix_stream', True)
    abstract = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); abstract.bind('\0' + spec['abstract']); abstract.listen(); serve(abstract, 'abstract_stream', True)
    datagram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); datagram.bind(spec['datagram']); serve(datagram, 'sendmsg')
    abstract_dgram = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM); abstract_dgram.bind('\0' + spec['abstract_datagram']); serve(abstract_dgram, 'abstract_sendmsg')
    spec.update(host_network_namespace=os.readlink('/proc/self/ns/net'), host_pid_namespace=os.readlink('/proc/self/ns/pid'), udp=udp.getsockname()[1], dns=dns.getsockname()[1], host_pid=os.getpid())
    # Positive controls finish before the baseline is reset, never contact an existing service.
    for sock in [udp, dns]:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
            payload = DNS_QUERY if sock is dns else b'control'
            peer.settimeout(1); peer.sendto(payload, sock.getsockname()); reply = peer.recv(256)
            assert reply[2:4] == b'\x81\x80' if sock is dns else reply == b'owned'
    for address in [spec['stream'], '\0' + spec['abstract']]:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
            peer.settimeout(1); peer.connect(address); peer.sendall(b'control'); assert peer.recv(128) == b'owned'
    delivered.clear()
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as peer: peer.sendmsg([b'control'], [], 0, spec['datagram'])
    assert delivered.wait(1)
    assert open('/proc/%d/cmdline' % spec['host_pid'], 'rb').read()
    assert open('/proc/%d/environ' % spec['host_pid'], 'rb').read()
    delivered.clear()
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as peer: peer.sendmsg([b'control'], [], 0, '\0' + spec['abstract_datagram'])
    assert delivered.wait(1)
    hits.clear(); delivered.clear()
    child = None
    try:
        child = subprocess.Popen(spec['command'] + ['--', '/usr/bin/python3', os.path.realpath(__file__), '--client', json.dumps(spec)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(10), 'missing readiness'
        line = child.stdout.readline(); ready = json.loads(line)
        assert ready == {'ready': True, 'single_file_initial': 'denied'}, 'initial single-file deny failed'
        replacement = spec['single'] + '.replacement'
        with open(replacement, 'w') as file: file.write(spec['token'])
        os.replace(replacement, spec['single'])
        os.mkdir(spec['late'])
        with open(spec['late'] + '/canary', 'w') as file: file.write(spec['token'])
        with open(spec['release'], 'w') as file: file.write('release')
        out, err = child.communicate(timeout=15)
        assert child.returncode == 0, 'sandbox child failed: ' + err[:1000]
        result = json.loads(out)
        if result['unix_datagram_sendmsg'] == 'allowed': assert delivered.wait(1)
        result['host_hits'] = list(hits)
        print(json.dumps(result), flush=True)
    finally:
        if child and child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL); child.wait()
        stopped.set()
        for sock in sockets: sock.close()
        for thread in threads: thread.join(1)

if __name__ == '__main__':
    if sys.platform != 'linux': raise RuntimeError('Linux qualification only; not run on this OS')
    (client if sys.argv[1] == '--client' else host)(json.loads(sys.argv[2]))
