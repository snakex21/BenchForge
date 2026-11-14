// Package migrate copies the data of a BenchForge 1.x (Electron) install
// into the Go build's data directory.
//
// The SQLite schema is the same, so the database is copied as is (the Go
// build opens it and runs its usual additive migrations). API keys saved by
// the Electron safeStorage stay readable (internal/secrets reads them). The
// source is never modified, so the Electron build keeps working.
//
// Portable/zip users need nothing: the Go exe dropped into the same folder
// (or the 1.x in-app updater) finds data\benchforge.db next to it. The
// NSIS installer kept data in the install folder, which is what Candidates
// looks for.
package migrate

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// DBName is the database file name used by both builds.
const DBName = "benchforge.db"

// Candidates returns existing Electron data folders (containing a
// benchforge.db), most likely first. getenv is os.Getenv in production.
func Candidates(getenv func(string) string) []string {
	var dirs []string
	if la := getenv("LOCALAPPDATA"); la != "" {
		// electron-builder NSIS per-user default: Programs\<package name>
		dirs = append(dirs,
			filepath.Join(la, "Programs", "benchforge-desktop", "data"),
			filepath.Join(la, "Programs", "BenchForge", "data"))
	}
	for _, pf := range []string{getenv("ProgramFiles"), getenv("ProgramFiles(x86)")} {
		if pf != "" {
			dirs = append(dirs, filepath.Join(pf, "BenchForge", "data"))
		}
	}
	if ad := getenv("APPDATA"); ad != "" {
		// pre-0.2 development builds kept the DB in the Electron userData folder
		dirs = append(dirs, filepath.Join(ad, "benchforge-desktop"))
	}
	var out []string
	seen := map[string]bool{}
	for _, d := range dirs {
		key := strings.ToLower(filepath.Clean(d))
		if seen[key] {
			continue
		}
		seen[key] = true
		if st, err := os.Stat(filepath.Join(d, DBName)); err == nil && st.Mode().IsRegular() && st.Size() > 0 {
			out = append(out, d)
		}
	}
	return out
}

// Report describes a finished import.
type Report struct {
	Source    string
	Files     int
	Bytes     int64
	Artifacts bool
}

// ErrTargetExists is returned when the destination already has a database.
var ErrTargetExists = errors.New("the destination already contains benchforge.db")

// Import copies benchforge.db (with its -wal/-shm files) and the artifacts
// folder from srcDir to dstDir. It refuses to overwrite an existing database
// and copies the database through a temp file, so an interrupted import never
// leaves a half-written benchforge.db behind.
func Import(srcDir, dstDir string) (Report, error) {
	rep := Report{Source: srcDir}
	src, err := filepath.Abs(srcDir)
	if err != nil {
		return rep, err
	}
	dst, err := filepath.Abs(dstDir)
	if err != nil {
		return rep, err
	}
	if strings.EqualFold(filepath.Clean(src), filepath.Clean(dst)) {
		return rep, errors.New("source and destination are the same folder")
	}
	if st, err := os.Stat(filepath.Join(src, DBName)); err != nil || !st.Mode().IsRegular() {
		return rep, fmt.Errorf("no %s in %s", DBName, src)
	}
	if _, err := os.Stat(filepath.Join(dst, DBName)); err == nil {
		return rep, ErrTargetExists
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return rep, err
	}
	// -wal first: a database without its WAL would lose the last writes.
	for _, suffix := range []string{"-wal", "-shm"} {
		s := filepath.Join(src, DBName+suffix)
		if _, err := os.Stat(s); err != nil {
			continue
		}
		n, err := copyFile(s, filepath.Join(dst, DBName+suffix))
		if err != nil {
			return rep, err
		}
		rep.Files++
		rep.Bytes += n
	}
	tmp := filepath.Join(dst, DBName+".import-tmp")
	n, err := copyFile(filepath.Join(src, DBName), tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return rep, err
	}
	if err := os.Rename(tmp, filepath.Join(dst, DBName)); err != nil {
		_ = os.Remove(tmp)
		return rep, err
	}
	rep.Files++
	rep.Bytes += n
	art := filepath.Join(src, "artifacts")
	if st, err := os.Stat(art); err == nil && st.IsDir() {
		files, bytes, err := copyTree(art, filepath.Join(dst, "artifacts"))
		rep.Files += files
		rep.Bytes += bytes
		if err != nil {
			return rep, fmt.Errorf("database imported, but copying artifacts failed: %w", err)
		}
		rep.Artifacts = true
	}
	return rep, nil
}

func copyFile(src, dst string) (int64, error) {
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return n, err
}

// copyTree copies regular files and folders; symlinks are skipped and
// existing files in dst are kept.
func copyTree(src, dst string) (int, int64, error) {
	files, total := 0, int64(0)
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if _, err := os.Stat(target); err == nil {
			return nil
		}
		n, err := copyFile(p, target)
		files++
		total += n
		return err
	})
	return files, total, err
}
