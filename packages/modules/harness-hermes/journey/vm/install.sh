#!/bin/bash
# Fetch window for the pinned Hermes release, uv, Python 3.14 and locked dependencies.
# DNS goes only to two pinned public resolvers. Every private range is refused, Lima's gateway
# resolver included, with no exception. Each step is timestamped and the evidence is printed.
set -euo pipefail
stamp() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
RESOLVERS="1.1.1.1 8.8.8.8"
PRIVATE="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10"
probe() {
  # One DNS query for example.com to $1 port 53, over UDP. Prints what happened.
  python3 -I - "$1" <<'P'
import socket, sys
q = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01'
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(3)
try:
    s.sendto(q, (sys.argv[1], 53))
    s.recv(512)
    print(f"resolver {sys.argv[1]}: ANSWERED")
except Exception as e:
    print(f"resolver {sys.argv[1]}: no answer ({type(e).__name__})")
P
}

IFACE=$(ip route show default | awk '{print $5; exit}')
GATEWAY_DNS=$(resolvectl dns "$IFACE" | awk '{print $NF}')
echo "$(stamp) link $IFACE, resolver from the VM network before pinning: $GATEWAY_DNS"
sudo sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
sudo resolvectl dns "$IFACE" $RESOLVERS
sudo resolvectl domain "$IFACE" "~."
sudo resolvectl flush-caches
echo "$(stamp) resolvers pinned: $(resolvectl dns "$IFACE")"

sudo iptables -F OUTPUT
sudo iptables -P OUTPUT ACCEPT
sudo iptables -A OUTPUT -o lo -j ACCEPT
sudo iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for r in $RESOLVERS; do
  sudo iptables -A OUTPUT -d "$r" -p udp --dport 53 -j ACCEPT
  sudo iptables -A OUTPUT -d "$r" -p tcp --dport 53 -j ACCEPT
done
for r in $PRIVATE; do sudo iptables -A OUTPUT -d "$r" -j REJECT; done
echo "$(stamp) WINDOW OPEN. OUTPUT rules:"
sudo iptables -S OUTPUT
# A long-lived connection opened inside the window: HTTP keep-alive to 1.1.1.1:80, asked every 3 s
# so it is shown alive right up to the close. After the close one more request must get no answer.
python3 -I - > "$HOME/long-lived.log" 2>&1 <<'P' &
import os, socket, time
ASK = b"HEAD / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: keep-alive\r\n\r\n"
closed = os.path.join(os.environ["HOME"], "window.closed")
s = socket.create_connection(("1.1.1.1", 80), timeout=5)
print("long-lived connection to 1.1.1.1:80 opened during the window", flush=True)

def ask():
    s.settimeout(3)
    s.sendall(ASK)
    data = s.recv(4096)
    if not data:
        raise ConnectionResetError("closed by the peer")
    return data

answered, last = 0, time.time()
try:
    while not os.path.exists(closed):
        ask()
        answered, last = answered + 1, time.time()
        for _ in range(15):
            if os.path.exists(closed):
                break
            time.sleep(0.2)
except Exception as e:
    print(f"INCONCLUSIVE: the connection ended during the window ({type(e).__name__}) after {answered} answers", flush=True)
    raise SystemExit(0)
print(f"during the window: {answered} requests answered on it, the last {time.time() - last:.1f} s before the close", flush=True)
try:
    ask()
    print("ANSWERED after the close: the connection still carries traffic", flush=True)
except Exception as e:
    print(f"after the close: no answer on it ({type(e).__name__})", flush=True)
P
LONG_LIVED=$!
sleep 1
cat "$HOME/long-lived.log"
echo "$(stamp) evidence during the window:"
probe "$GATEWAY_DNS"
probe 1.1.1.1
getent hosts astral.sh github.com pypi.org | sed 's/^/  resolved: /'

curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
git clone --quiet --depth 1 --branch v0.22.5 https://github.com/NousResearch/hermes-agent.git "$HOME/hermes"
cd "$HOME/hermes"
git rev-parse HEAD
UV_PYTHON_INSTALL_DIR="$HOME/.uv-python" uv sync --frozen --python 3.14 --extra all 2>&1 | tail -3
.venv/bin/hermes --version | head -1
.venv/bin/python -V
.venv/bin/python -c 'import sqlite3; print(sqlite3.sqlite_version)'

# Close: nothing leaves from here on, DNS included, and no connection opened in the window goes on.
# Only sshd's own replies stay: the journeys' API and gate tunnels ride inside that session.
sudo iptables -P OUTPUT DROP
sudo iptables -F OUTPUT
sudo iptables -A OUTPUT -o lo -j ACCEPT
sudo iptables -A OUTPUT -p tcp --sport 22 -m conntrack --ctstate ESTABLISHED -j ACCEPT
if command -v conntrack > /dev/null; then sudo conntrack -F; echo "$(stamp) conntrack -F: flushed"; else echo "$(stamp) conntrack -F: tool not present; no rule accepts established traffic but sshd's, so stale entries grant nothing"; fi
echo "$(stamp) WINDOW CLOSED. OUTPUT rules:"
sudo iptables -S OUTPUT
touch "$HOME/window.closed"
for _ in $(seq 1 40); do grep -q "after the close" "$HOME/long-lived.log" && break; sleep 0.25; done
echo "$(stamp) long-lived connection:"
cat "$HOME/long-lived.log"
echo "$(stamp) processes the install left running, then ended:"
pgrep -a -P $$ || echo "  none"
pkill -P $$ || true
kill "$LONG_LIVED" 2> /dev/null || true
echo "$(stamp) evidence after the window:"
probe "$GATEWAY_DNS"
probe 1.1.1.1
probe 8.8.8.8
if curl -m 5 -sS https://example.com -o /dev/null; then echo "EGRESS OPEN"; exit 1; else echo "$(stamp) egress dropped"; fi
