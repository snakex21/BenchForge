//go:build windows

package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

func blobOf(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func takeBlob(out *windows.DataBlob) []byte {
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
}

var entropy = []byte("BenchForge secret v1")

func protect(plain []byte) ([]byte, error) {
	var out windows.DataBlob
	desc, _ := windows.UTF16PtrFromString("BenchForge")
	if err := windows.CryptProtectData(blobOf(plain), desc, blobOf(entropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(&out), nil
}

func unprotect(blob []byte) ([]byte, error) { return unprotectWith(blob, entropy) }

func unprotectWith(blob, ent []byte) ([]byte, error) {
	var out windows.DataBlob
	var e *windows.DataBlob
	if ent != nil {
		e = blobOf(ent)
	}
	if err := windows.CryptUnprotectData(blobOf(blob), nil, e, 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, err
	}
	return takeBlob(&out), nil
}

func available() bool {
	b, err := protect([]byte("probe"))
	if err != nil {
		return false
	}
	p, err := unprotect(b)
	return err == nil && string(p) == "probe"
}

// ---- Electron safeStorage compatibility (read-only) ----

var (
	electronKeyMu  sync.Mutex
	electronKeys   [][]byte
	electronLoaded bool
	// ElectronProfileDirs lists where the Electron build kept "Local State".
	ElectronProfileDirs = defaultElectronProfileDirs
)

func defaultElectronProfileDirs() []string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return nil
	}
	return []string{filepath.Join(appData, "BenchForge"), filepath.Join(appData, "benchforge-desktop")}
}

// loadElectronKeys returns every usable key: the packaged build
// (APPDATA/BenchForge) and `npm start` (APPDATA/benchforge-desktop) have
// separate profiles, and a database may contain values from either.
func loadElectronKeys() [][]byte {
	var keys [][]byte
	for _, dir := range ElectronProfileDirs() {
		data, err := os.ReadFile(filepath.Join(dir, "Local State"))
		if err != nil {
			continue
		}
		var st struct {
			OSCrypt struct {
				EncryptedKey string `json:"encrypted_key"`
			} `json:"os_crypt"`
		}
		if json.Unmarshal(data, &st) != nil || st.OSCrypt.EncryptedKey == "" {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(st.OSCrypt.EncryptedKey)
		if err != nil || len(raw) < 5 || string(raw[:5]) != "DPAPI" {
			continue
		}
		if key, err := unprotectWith(raw[5:], nil); err == nil && len(key) == 32 {
			keys = append(keys, key)
		}
	}
	return keys
}

func decryptElectron(raw []byte) ([]byte, error) {
	if len(raw) > 3 && (string(raw[:3]) == "v10" || string(raw[:3]) == "v11") {
		electronKeyMu.Lock()
		if !electronLoaded {
			electronKeys, electronLoaded = loadElectronKeys(), true
		}
		keys := electronKeys
		electronKeyMu.Unlock()
		if len(keys) == 0 {
			return nil, errors.New("electron safeStorage key not found")
		}
		var lastErr error
		for _, key := range keys {
			plain, err := decryptGCM(key, raw[3:])
			if err == nil {
				return plain, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}
	// Very old Chromium/Electron builds stored raw DPAPI blobs.
	return unprotectWith(raw, nil)
}

func decryptGCM(key, payload []byte) ([]byte, error) {
	const nonceSize = 12
	if len(payload) < nonceSize+16 {
		return nil, errors.New("ciphertext too short")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, payload[:nonceSize], payload[nonceSize:], nil)
}

// resetElectronKeyForTests clears the cached Electron key.
func resetElectronKeyForTests() {
	electronKeyMu.Lock()
	electronKeys, electronLoaded = nil, false
	electronKeyMu.Unlock()
}
