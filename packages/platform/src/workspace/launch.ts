// Only the trusted wrapper owns fd 3. It reports setup before closing that pipe and executing user code.
export const WORKSPACE_WRAPPER = 'read -r admission || { printf "admission\\n" >&3; exit 125; }; umask 077; ulimit -S -u "$1" && ulimit -H -u "$1" && ulimit -S -t 10 && ulimit -H -t 10 || { printf "limits\\n" >&3; exit 125; }; { ulimit -v 524288; } 2>/dev/null || :; { ulimit -m 524288; } 2>/dev/null || :; printf "ready\\n" >&3; exec 3>&-; exec /bin/bash --noprofile --norc -c "$2"';

export function workspaceSetup(status: string): 'setup' | 'admission' | 'unconfirmed' | undefined {
  if (status === 'ready\n') return undefined;
  if (status === 'limits\n') return 'setup';
  if (status === 'admission\n') return 'admission';
  return 'unconfirmed';
}
