// Package secrets replaces electron/secretStore.cjs.
//
// New values are protected with Windows DPAPI (current user) and stored as
// "bfdpapi:v1:<base64>". Values written by the Electron build stay readable:
//   - "bfsec:v1:<base64>"   Electron safeStorage (Chromium OSCrypt "v10" AES-256-GCM,
//     key from the Electron profile's "Local State", itself DPAPI-protected)
//   - "bfinsecure:v1:<b64>" the old insecure fallback (base64 only)
//   - anything else          legacy plaintext
//
// Legacy formats are re-encrypted to DPAPI by MigrateValue.
package secrets

import (
	"encoding/base64"
	"strings"
)

const (
	DPAPIPrefix    = "bfdpapi:v1:"
	ElectronPrefix = "bfsec:v1:"
	FallbackPrefix = "bfinsecure:v1:"
)

// IsEncrypted reports whether value already uses a protected format.
func IsEncrypted(value string) bool {
	return strings.HasPrefix(value, DPAPIPrefix) || strings.HasPrefix(value, ElectronPrefix)
}

// Encrypt protects a secret. Empty input returns "" (stored as NULL by callers).
func Encrypt(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	if strings.HasPrefix(value, DPAPIPrefix) {
		return value, nil
	}
	if strings.HasPrefix(value, ElectronPrefix) || strings.HasPrefix(value, FallbackPrefix) {
		plain, ok := Decrypt(value)
		if !ok {
			return value, nil // keep an undecryptable legacy value untouched
		}
		value = plain
	}
	blob, err := protect([]byte(value))
	if err != nil {
		return "", err
	}
	return DPAPIPrefix + base64.StdEncoding.EncodeToString(blob), nil
}

// Decrypt returns the plaintext and whether decoding succeeded. Undecryptable
// values return ("", false): the UI then shows the key as missing, exactly
// like the Electron build did when safeStorage failed.
func Decrypt(value string) (string, bool) {
	switch {
	case value == "":
		return "", true
	case strings.HasPrefix(value, DPAPIPrefix):
		raw, err := base64.StdEncoding.DecodeString(value[len(DPAPIPrefix):])
		if err != nil {
			return "", false
		}
		plain, err := unprotect(raw)
		if err != nil {
			return "", false
		}
		return string(plain), true
	case strings.HasPrefix(value, ElectronPrefix):
		raw, err := base64.StdEncoding.DecodeString(value[len(ElectronPrefix):])
		if err != nil {
			return "", false
		}
		plain, err := decryptElectron(raw)
		if err != nil {
			return "", false
		}
		return string(plain), true
	case strings.HasPrefix(value, FallbackPrefix):
		raw, err := base64.StdEncoding.DecodeString(value[len(FallbackPrefix):])
		if err != nil {
			return "", false
		}
		return string(raw), true
	default:
		return value, true // legacy plaintext
	}
}

// MigrateValue converts legacy formats to DPAPI. It returns the new value and
// true when a rewrite is needed.
func MigrateValue(value string) (string, bool) {
	if value == "" || strings.HasPrefix(value, DPAPIPrefix) {
		return value, false
	}
	plain, ok := Decrypt(value)
	if !ok || plain == "" {
		return value, false
	}
	enc, err := Encrypt(plain)
	if err != nil || enc == "" {
		return value, false
	}
	return enc, true
}

// Status is reported by the Health Check.
type Status struct {
	OK             bool   `json:"ok"`
	Available      bool   `json:"available"`
	Backend        string `json:"backend"`
	SecurePrefix   string `json:"securePrefix"`
	FallbackPrefix string `json:"fallbackPrefix"`
}

func GetStatus() Status {
	ok := available()
	backend := "windows-dpapi"
	if !ok {
		backend = "unavailable"
	}
	return Status{OK: ok, Available: ok, Backend: backend, SecurePrefix: DPAPIPrefix, FallbackPrefix: FallbackPrefix}
}
