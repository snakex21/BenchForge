//go:build windows

package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDPAPIRoundTrip(t *testing.T) {
	enc, err := Encrypt("sk-test-123")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(enc, DPAPIPrefix) || strings.Contains(enc, "sk-test") {
		t.Fatalf("unexpected ciphertext %q", enc)
	}
	plain, ok := Decrypt(enc)
	if !ok || plain != "sk-test-123" {
		t.Fatalf("decrypt = %q,%v", plain, ok)
	}
	if again, _ := Encrypt(enc); again != enc {
		t.Fatal("encrypting an encrypted value must be a no-op")
	}
}

func TestLegacyFormats(t *testing.T) {
	fallback := FallbackPrefix + base64.StdEncoding.EncodeToString([]byte("abc"))
	if p, ok := Decrypt(fallback); !ok || p != "abc" {
		t.Fatalf("fallback: %q %v", p, ok)
	}
	if p, ok := Decrypt("plain-key"); !ok || p != "plain-key" {
		t.Fatal("plaintext legacy value must pass through")
	}
	migrated, changed := MigrateValue(fallback)
	if !changed || !strings.HasPrefix(migrated, DPAPIPrefix) {
		t.Fatalf("fallback must migrate to DPAPI, got %q", migrated)
	}
	if p, _ := Decrypt(migrated); p != "abc" {
		t.Fatal("migrated value lost content")
	}
	if _, ok := Decrypt(DPAPIPrefix + "!!notbase64"); ok {
		t.Fatal("garbage must not decrypt")
	}
}

// TestElectronSafeStorageCompat builds a fake Electron profile (Local State
// with a DPAPI-wrapped AES key) and checks that a "bfsec:v1:" value written
// the way Chromium OSCrypt does it is readable.
func TestElectronSafeStorageCompat(t *testing.T) {
	dir := t.TempDir()
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	var out []byte
	{
		wrapped, err := protectNoEntropy(key)
		if err != nil {
			t.Fatal(err)
		}
		out = append([]byte("DPAPI"), wrapped...)
	}
	state, _ := json.Marshal(map[string]any{"os_crypt": map[string]any{"encrypted_key": base64.StdEncoding.EncodeToString(out)}})
	if err := os.WriteFile(filepath.Join(dir, "Local State"), state, 0o600); err != nil {
		t.Fatal(err)
	}
	old := ElectronProfileDirs
	ElectronProfileDirs = func() []string { return []string{dir} }
	resetElectronKeyForTests()
	defer func() { ElectronProfileDirs = old; resetElectronKeyForTests() }()

	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, 12)
	_, _ = rand.Read(nonce)
	ct := gcm.Seal(nil, nonce, []byte("electron-secret"), nil)
	blob := append(append([]byte("v10"), nonce...), ct...)
	value := ElectronPrefix + base64.StdEncoding.EncodeToString(blob)

	plain, ok := Decrypt(value)
	if !ok || plain != "electron-secret" {
		t.Fatalf("electron compat decrypt = %q %v", plain, ok)
	}
	migrated, changed := MigrateValue(value)
	if !changed || !strings.HasPrefix(migrated, DPAPIPrefix) {
		t.Fatal("electron value must migrate to DPAPI")
	}
	// Tampered ciphertext must fail closed.
	blob[len(blob)-1] ^= 0xff
	if _, ok := Decrypt(ElectronPrefix + base64.StdEncoding.EncodeToString(blob)); ok {
		t.Fatal("tampered GCM value must not decrypt")
	}
}

func protectNoEntropy(b []byte) ([]byte, error) {
	old := entropy
	entropy = nil
	defer func() { entropy = old }()
	return protect(b)
}

func TestStatus(t *testing.T) {
	if s := GetStatus(); !s.OK || s.Backend != "windows-dpapi" {
		t.Fatalf("status %+v", s)
	}
}
