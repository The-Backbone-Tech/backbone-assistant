// Self-contained so ElectronApplication.evaluate runs this in the fixture's Main process.
// Only children recorded by this fixture are signalled; every wait has a deadline.
export async function stopFixtureChildren(_electron: unknown, timeoutMs = 10_000): Promise<void> {
  const children = (globalThis as unknown as {restoredChildren?: import('node:child_process').ChildProcess[]}).restoredChildren ?? [];
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const wait = (signal: NodeJS.Signals) => new Promise<boolean>(resolve => {
      const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener('exit', exitedHandler); resolve(exited); };
      const exitedHandler = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', exitedHandler);
      child.kill(signal);
    });
    if (!await wait('SIGTERM') && !await wait('SIGKILL')) throw new Error('The fixture child did not confirm exit after SIGTERM and SIGKILL.');
  }
}
