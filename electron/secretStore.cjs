const { safeStorage } = require('electron')

const SECURE_PREFIX = 'bfsec:v1:'
const FALLBACK_PREFIX = 'bfinsecure:v1:'

function isEncryptedSecret(value) {
  const text = String(value || '')
  return text.startsWith(SECURE_PREFIX) || text.startsWith(FALLBACK_PREFIX)
}

function hasSafeStorage() {
  try {
    return Boolean(safeStorage?.isEncryptionAvailable?.())
  } catch {
    return false
  }
}

function encryptSecret(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (!text) return null
  if (isEncryptedSecret(text)) return text

  if (hasSafeStorage()) {
    const encrypted = safeStorage.encryptString(text).toString('base64')
    return `${SECURE_PREFIX}${encrypted}`
  }

  // Last-resort fallback for platforms where Electron safeStorage is unavailable.
  // This is intentionally marked as insecure so Health Check can warn users.
  return `${FALLBACK_PREFIX}${Buffer.from(text, 'utf8').toString('base64')}`
}

function decryptSecret(value) {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (!text) return null

  if (text.startsWith(SECURE_PREFIX)) {
    try {
      return safeStorage.decryptString(Buffer.from(text.slice(SECURE_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  }

  if (text.startsWith(FALLBACK_PREFIX)) {
    try {
      return Buffer.from(text.slice(FALLBACK_PREFIX.length), 'base64').toString('utf8')
    } catch {
      return null
    }
  }

  // Legacy plaintext value. Callers can migrate it by re-saving through encryptSecret().
  return text
}

function maskSecret(value) {
  const decrypted = decryptSecret(value)
  if (!decrypted) return null
  if (decrypted.length <= 8) return '•'.repeat(Math.max(4, decrypted.length))
  return `${decrypted.slice(0, 4)}${'•'.repeat(Math.min(16, decrypted.length - 8))}${decrypted.slice(-4)}`
}

function getSecretStoreStatus() {
  const available = hasSafeStorage()
  return {
    ok: available,
    available,
    backend: available ? 'electron.safeStorage' : 'insecure-base64-fallback',
    securePrefix: SECURE_PREFIX,
    fallbackPrefix: FALLBACK_PREFIX,
  }
}

module.exports = {
  SECURE_PREFIX,
  FALLBACK_PREFIX,
  isEncryptedSecret,
  encryptSecret,
  decryptSecret,
  maskSecret,
  getSecretStoreStatus,
}
