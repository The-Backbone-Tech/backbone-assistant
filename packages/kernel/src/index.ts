// The v0.8 kernel: its pinned SQL and the provisioner that installs it.
export { type KernelPin, kernelPin, kernelSql } from './sql.ts';
export { IDENTITY_LOGIN, type KernelLogins, OBSERVER_LOGIN, provisionKernel } from './provision.ts';
