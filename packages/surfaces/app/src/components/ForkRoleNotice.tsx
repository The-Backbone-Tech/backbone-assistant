/** Forking is a person action: the new chat uses ordinary settings rather than the child's role. */
export function ForkRoleNotice() {
  return <span role="note" data-testid="fork-role-notice" className="block max-w-64 whitespace-normal text-xs font-normal text-muted">Forks are ordinary chats. Helper role tool limits do not carry over.</span>;
}
