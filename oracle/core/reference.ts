import fc from 'fast-check';

/**
 * The reference models a target is compared with. The kernel twin of the core contracts
 * (mandates-decisions, effect-gateway) is the successor's own `packages/core/src/kernel`, written
 * from those contracts; the oracle's root devDependencies pin fast-check.
 */
export * from '../../packages/core/src/kernel/index.ts';
export { fc };
