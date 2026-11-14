// Loaded before the app's main (electron -r) so a journey runs the real `keychainKeys` path with no
// plain text and without touching the person's login Keychain. Only safeStorage's own wrap is replaced.
const { safeStorage } = require('electron');
safeStorage.isAsyncEncryptionAvailable = async () => true;
safeStorage.encryptStringAsync = async (text) => Buffer.from(`fake-keychain:${text}`);
safeStorage.decryptStringAsync = async (sealed) => ({ result: sealed.toString().replace('fake-keychain:', ''), shouldReEncrypt: false });
safeStorage.getSelectedStorageBackend = () => 'fake';
globalThis.__fakeKeychain = true;
