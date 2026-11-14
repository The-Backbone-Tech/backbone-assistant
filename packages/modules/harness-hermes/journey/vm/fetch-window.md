# The journey VM and its fetch window

The real journeys in [drive.ts](../drive.ts) run against Hermes in a disposable Lima VM. This folder holds what defines that VM and what it is allowed to fetch, so both can be reviewed from source.

- [parity.yaml](parity.yaml): the VM. vz, plain mode, no mounts, no forwarded ports or agents.
- [install.sh](install.sh): the fetch window. It fetches the pinned Hermes release, uv, Python 3.14 and the locked dependencies, then closes the window for good.
- [start-install.sh](start-install.sh): runs the install detached inside the VM, writing its own log. A dropped SSH session from the host cannot hide what state the VM is in.

Nothing of Hermes runs on the host. The VM is deleted after each run.

## The rules

DNS goes only to two pinned public resolvers, `1.1.1.1` and `8.8.8.8`. The VM's own resolver, Lima's gateway at `192.168.5.2`, is unpinned first and then refused like every other private address. IPv6 is off.

**While the window is open**, the `OUTPUT` policy is ACCEPT and the rules are, in order:

1. loopback: accept;
2. established and related: accept;
3. udp and tcp 53 to `1.1.1.1/32` and to `8.8.8.8/32`: accept;
4. `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` and `100.64.0.0/10`: reject.

**When it closes**, the policy is DROP and only two rules accept:

1. loopback;
2. established TCP from source port 22, which is `sshd`'s own replies.

Nothing else leaves the VM, DNS included, and neither does any connection opened during the window. The journeys' API and gate tunnels ride inside the SSH session, so they still work, each in its own direction: the API from host to VM, the gate from VM to host.

Two more steps run at the close:

- `conntrack -F` runs where the tool exists. It is absent from this image, and the log says so. With no rule accepting other established traffic, stale entries grant nothing.
- Every process the install left running is listed and ended.

The journeys run only after the close.

**Limit.** For about 75 seconds the window allows general egress to public addresses, as the fetch window always has. The two pinned resolvers are public services outside our control. This is the window, not containment.

## Proof that a connection opened in the window cannot go on

The script opens an HTTP keep-alive connection to `1.1.1.1:80` once the window is open. It asks on it every 3 seconds, so the connection is shown alive right up to the close. After the close it asks once more, on the same connection, and must get no answer.

An earlier version of this proof held an idle TLS connection instead. On instance `hosted-engine-7` it found the connection already closed by the peer when the window closed. That showed nothing either way, so that run was discarded and its VM deleted.

## Evidence

From the install log of instance `hosted-engine-8`, 2 November 2026, which ran this folder's scripts. Times are UTC, with the date prefix trimmed.

One line differs from what ran: the probe found its flag file through `os.path.expanduser` with a tilde path. The committed script reads `HOME` from the environment instead, because the repository's path check refuses a literal tilde path. Both name the same file inside the VM.

```text
08:15:47.272Z link eth0, resolver from the VM network before pinning: 192.168.5.2
08:15:47.289Z resolvers pinned: Link 2 (eth0): 1.1.1.1 8.8.8.8
08:15:47.342Z WINDOW OPEN. OUTPUT rules:
-P OUTPUT ACCEPT
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A OUTPUT -d 1.1.1.1/32 -p udp -m udp --dport 53 -j ACCEPT
-A OUTPUT -d 1.1.1.1/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A OUTPUT -d 8.8.8.8/32 -p udp -m udp --dport 53 -j ACCEPT
-A OUTPUT -d 8.8.8.8/32 -p tcp -m tcp --dport 53 -j ACCEPT
-A OUTPUT -d 10.0.0.0/8 -j REJECT --reject-with icmp-port-unreachable
-A OUTPUT -d 172.16.0.0/12 -j REJECT --reject-with icmp-port-unreachable
-A OUTPUT -d 192.168.0.0/16 -j REJECT --reject-with icmp-port-unreachable
-A OUTPUT -d 169.254.0.0/16 -j REJECT --reject-with icmp-port-unreachable
-A OUTPUT -d 100.64.0.0/10 -j REJECT --reject-with icmp-port-unreachable
long-lived connection to 1.1.1.1:80 opened during the window
08:15:48.347Z evidence during the window:
resolver 192.168.5.2: no answer (PermissionError)
resolver 1.1.1.1: ANSWERED
bf0203a794a07aac3ff764972ab9087baa4e4f4e
Hermes Agent v0.22.5 (2026.9.24) · stable · local bf0203a794a0
Python 3.14.10
3.53.1
08:17:00.710Z conntrack -F: tool not present; no rule accepts established traffic but sshd's, so stale entries grant nothing
08:17:00.710Z WINDOW CLOSED. OUTPUT rules:
-P OUTPUT DROP
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -p tcp -m tcp --sport 22 -m conntrack --ctstate ESTABLISHED -j ACCEPT
08:17:04.082Z long-lived connection:
long-lived connection to 1.1.1.1:80 opened during the window
during the window: 24 requests answered on it, the last 2.7 s before the close
after the close: no answer on it (TimeoutError)
08:17:04.084Z processes the install left running, then ended:
  none
08:17:04.099Z evidence after the window:
resolver 192.168.5.2: no answer (PermissionError)
resolver 1.1.1.1: no answer (PermissionError)
resolver 8.8.8.8: no answer (PermissionError)
curl: (28) Resolving timed out after 5001 milliseconds
08:17:09.144Z egress dropped
```

`PermissionError` is the REJECT rule refusing a query at send. So, from this log:

- The gateway resolver was refused while the window was open.
- A connection that carried 24 answers during the window, the last 2.7 seconds before the close, got none after it.
- Every resolver was refused after the close, and a new outbound request failed.

After the close, the 12 journeys ran on this VM through the SSH tunnels.

## Earlier runs

The first VMs of this work did not pin resolvers: `hosted-engine`, `hosted-engine-2`, `hosted-engine-3` and `hosted-engine-4`. During their fetch windows they allowed port 53 to Lima's gateway resolver, and nothing else private.

Through `hosted-engine-6`, the close kept accepting established and related traffic, so a connection opened in the window could have gone on. Both are gone from `hosted-engine-8` on.
