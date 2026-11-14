//go:build !windows

package secrets

import "errors"

// Non-Windows builds exist only for tooling; there is no OS secret store
// binding, so encryption is reported as unavailable and refused.
func protect([]byte) ([]byte, error)   { return nil, errors.New("secret store unavailable on this OS") }
func unprotect([]byte) ([]byte, error) { return nil, errors.New("secret store unavailable on this OS") }
func available() bool                  { return false }
func decryptElectron([]byte) ([]byte, error) {
	return nil, errors.New("electron safeStorage is only readable on Windows")
}
func resetElectronKeyForTests() {}
