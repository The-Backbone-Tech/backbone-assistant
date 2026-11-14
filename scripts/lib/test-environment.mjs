// A denial, never a key-provider choice. Even an opted-in suite starts denied; only its explicitly
// scoped real-store case clears this variable in its own process.
export const testEnvironment = (env = process.env) => ({ ...env, BACKBONE_SYSTEM_STORE_UNAVAILABLE: '1' });
