/** Even a failed home cleanup must not skip deleting the isolated test keychain. */
export async function cleanupTemporaryKeychain(home: () => Promise<void>, keychain: () => Promise<void>, folder: () => void): Promise<void> {
  try { await home(); }
  finally {
    try { await keychain(); }
    finally { folder(); }
  }
}
