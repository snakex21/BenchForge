package migrate

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCandidatesFindsNSISInstallData(t *testing.T) {
	la, ad := t.TempDir(), t.TempDir()
	write(t, filepath.Join(la, "Programs", "benchforge-desktop", "data", DBName), "db")
	write(t, filepath.Join(ad, "benchforge-desktop", DBName), "old")
	_ = os.MkdirAll(filepath.Join(la, "Programs", "BenchForge", "data"), 0o755) // no db: ignored
	env := map[string]string{"LOCALAPPDATA": la, "APPDATA": ad}
	got := Candidates(func(k string) string { return env[k] })
	if len(got) != 2 || got[0] != filepath.Join(la, "Programs", "benchforge-desktop", "data") {
		t.Fatalf("candidates %v", got)
	}
}

func TestImportCopiesDatabaseWalAndArtifacts(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "data")
	write(t, filepath.Join(src, DBName), "main")
	write(t, filepath.Join(src, DBName+"-wal"), "wal")
	write(t, filepath.Join(src, "artifacts", "runs", "session-1", "result.json"), "{}")
	write(t, filepath.Join(src, "benchforge.log"), "not copied")
	rep, err := Import(src, dst)
	if err != nil {
		t.Fatal(err)
	}
	if rep.Files != 3 || !rep.Artifacts {
		t.Fatalf("report %+v", rep)
	}
	for _, f := range []string{DBName, DBName + "-wal", filepath.Join("artifacts", "runs", "session-1", "result.json")} {
		if _, err := os.Stat(filepath.Join(dst, f)); err != nil {
			t.Fatalf("missing %s", f)
		}
	}
	if _, err := os.Stat(filepath.Join(dst, "benchforge.log")); err == nil {
		t.Fatal("log must not be copied")
	}
	if b, _ := os.ReadFile(filepath.Join(src, DBName)); string(b) != "main" {
		t.Fatal("source modified")
	}
}

func TestImportRefusesToOverwrite(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	write(t, filepath.Join(src, DBName), "new")
	write(t, filepath.Join(dst, DBName), "existing")
	if _, err := Import(src, dst); err != ErrTargetExists {
		t.Fatalf("err %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, DBName)); string(b) != "existing" {
		t.Fatal("overwritten")
	}
	if _, err := Import(dst, dst); err == nil {
		t.Fatal("same folder must fail")
	}
}
