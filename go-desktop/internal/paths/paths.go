// Package paths mirrors electron/paths.cjs: portable data next to the
// executable (or BENCHFORGE_DATA_DIR / BENCHFORGE_APP_DIR overrides) and a
// confinement helper for relative artifact paths.
package paths

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	mu       sync.Mutex
	override string // tests
)

// SetDataDirForTests forces the data directory (tests only).
func SetDataDirForTests(dir string) {
	mu.Lock()
	override = dir
	mu.Unlock()
}

// AppBase is the directory that holds the executable (portable layout).
func AppBase() string {
	if v := os.Getenv("BENCHFORGE_APP_DIR"); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			return abs
		}
	}
	exe, err := os.Executable()
	if err != nil {
		wd, _ := os.Getwd()
		return wd
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

// Data returns (and creates) the data directory.
func Data() string {
	mu.Lock()
	o := override
	mu.Unlock()
	dir := o
	if dir == "" {
		if v := os.Getenv("BENCHFORGE_DATA_DIR"); v != "" {
			dir = v
		} else {
			dir = filepath.Join(AppBase(), "data")
		}
	}
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// ResolveData resolves a path relative to the data directory and returns ""
// when it would escape it (absolute paths, "..", volume names).
func ResolveData(rel string) string {
	root := filepath.Clean(Data())
	return ResolveWithin(root, rel)
}

// ResolveWithin joins rel to root and refuses anything outside root.
func ResolveWithin(root, rel string) string {
	if strings.ContainsRune(rel, 0) {
		return ""
	}
	if filepath.IsAbs(rel) || filepath.VolumeName(rel) != "" || strings.HasPrefix(rel, `\`) {
		return ""
	}
	abs := filepath.Clean(filepath.Join(root, rel))
	r, err := filepath.Rel(root, abs)
	if err != nil || r == ".." || strings.HasPrefix(r, ".."+string(filepath.Separator)) || filepath.IsAbs(r) {
		return ""
	}
	return abs
}

// ToPosix converts separators to forward slashes.
func ToPosix(p string) string { return strings.ReplaceAll(p, `\`, "/") }
