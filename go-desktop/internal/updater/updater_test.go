package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRelease struct {
	asset     []byte
	sums      string // "" = no SHA256SUMS.txt asset
	assetName string
}

func newFakeGitHub(t *testing.T, fr fakeRelease) (*Updater, *httptest.Server) {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/repos/"+Repo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		assets := []map[string]any{{"id": 1, "name": fr.assetName, "size": len(fr.asset), "browser_download_url": srv.URL + "/dl/" + fr.assetName}}
		if fr.sums != "" {
			assets = append(assets, map[string]any{"id": 2, "name": "SHA256SUMS.txt", "size": len(fr.sums), "browser_download_url": srv.URL + "/dl/SHA256SUMS.txt"})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v9.9.9", "name": "v9.9.9", "html_url": "https://github.com/" + Repo, "assets": assets})
	})
	mux.HandleFunc("/repos/evil/repo/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		t.Error("the updater queried a repository other than the fixed one")
	})
	mux.HandleFunc("/dl/", func(w http.ResponseWriter, r *http.Request) {
		switch strings.TrimPrefix(r.URL.Path, "/dl/") {
		case "SHA256SUMS.txt":
			_, _ = w.Write([]byte(fr.sums))
		case fr.assetName:
			_, _ = w.Write(fr.asset)
		default:
			http.NotFound(w, r)
		}
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	u := New()
	u.APIBase = srv.URL
	u.RequireHTTPS = false
	host, _ := url.Parse(srv.URL)
	u.AllowedHosts = map[string]bool{host.Hostname(): true}
	return u, srv
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func TestDownloadVerifiesChecksum(t *testing.T) {
	data := []byte("PK\x03\x04 fake zip payload")
	u, _ := newFakeGitHub(t, fakeRelease{asset: data, assetName: "BenchForge-9.9.9-x64.zip",
		sums: fmt.Sprintf("%s  BenchForge-9.9.9-x64.zip\n%s *other.exe\n", sum(data), strings.Repeat("0", 64))})
	rel, err := u.Latest(context.Background(), "", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !rel.UpdateAvail || rel.Recommended["zip"] == nil || rel.Recommended["checksum"] == nil {
		t.Fatalf("release %+v", rel)
	}
	asset, err := SelectAsset(rel, "", "zip")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "update.zip")
	got, err := u.DownloadTo(context.Background(), rel, asset, target, "")
	if err != nil {
		t.Fatal(err)
	}
	if !got.ChecksumVerified || got.SHA256 != sum(data) {
		t.Fatalf("download %+v", got)
	}
	if b, _ := os.ReadFile(target); string(b) != string(data) {
		t.Fatal("content mismatch")
	}
}

func TestDownloadFailsOnChecksumMismatch(t *testing.T) {
	data := []byte("tampered payload")
	u, _ := newFakeGitHub(t, fakeRelease{asset: data, assetName: "BenchForge-9.9.9-x64.zip",
		sums: strings.Repeat("a", 64) + "  BenchForge-9.9.9-x64.zip\n"})
	rel, _ := u.Latest(context.Background(), "", "1.0.0")
	asset, _ := SelectAsset(rel, "", "zip")
	dir := t.TempDir()
	target := filepath.Join(dir, "update.zip")
	_, err := u.DownloadTo(context.Background(), rel, asset, target, "")
	if err == nil || !strings.Contains(err.Error(), "SHA256 mismatch") {
		t.Fatalf("expected mismatch error, got %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("nothing may be left behind after a failed verification, found %v", entries)
	}
}

func TestDownloadRefusesReleaseWithoutChecksums(t *testing.T) {
	u, _ := newFakeGitHub(t, fakeRelease{asset: []byte("x"), assetName: "BenchForge-9.9.9-x64.zip"})
	rel, _ := u.Latest(context.Background(), "", "1.0.0")
	asset, _ := SelectAsset(rel, "", "zip")
	target := filepath.Join(t.TempDir(), "u.zip")
	if _, err := u.DownloadTo(context.Background(), rel, asset, target, ""); err == nil || !strings.Contains(err.Error(), "SHA256SUMS") {
		t.Fatalf("expected refusal, got %v", err)
	}
	if _, err := os.Stat(target); err == nil {
		t.Fatal("file must not be written")
	}
}

func TestDownloadRefusesAssetMissingFromChecksums(t *testing.T) {
	u, _ := newFakeGitHub(t, fakeRelease{asset: []byte("x"), assetName: "BenchForge-9.9.9-x64.zip", sums: strings.Repeat("b", 64) + "  something-else.zip\n"})
	rel, _ := u.Latest(context.Background(), "", "1.0.0")
	asset, _ := SelectAsset(rel, "", "zip")
	if _, err := u.DownloadTo(context.Background(), rel, asset, filepath.Join(t.TempDir(), "u.zip"), ""); err == nil || !strings.Contains(err.Error(), "does not list") {
		t.Fatalf("expected refusal, got %v", err)
	}
}

func TestRepoCannotBeChangedFromUI(t *testing.T) {
	for _, ok := range []any{nil, "", Repo, "SnakeX21/benchforge"} {
		if err := CheckRepo(ok); err != nil {
			t.Fatalf("%v rejected: %v", ok, err)
		}
	}
	for _, bad := range []any{"evil/repo", "snakex21/BenchForge-fork", 42, "snakex21/BenchForge/../../evil"} {
		if err := CheckRepo(bad); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
}

func TestRejectsForeignHosts(t *testing.T) {
	u := New()
	for _, raw := range []string{"http://github.com/x", "https://evil.example/x.zip", "https://user:pw@github.com/x", "file:///C:/x"} {
		p, _ := url.Parse(raw)
		if err := u.checkURL(p); err == nil {
			t.Fatalf("%s accepted", raw)
		}
	}
	p, _ := url.Parse("https://objects.githubusercontent.com/a")
	if err := u.checkURL(p); err != nil {
		t.Fatal(err)
	}
	// Release JSON pointing to a foreign host is refused at download time.
	rel := &Release{TagName: "v1", Recommended: map[string]*Asset{"checksum": {Name: "SHA256SUMS.txt", DownloadURL: "https://evil.example/SHA256SUMS.txt"}}}
	if _, err := u.ExpectedChecksum(context.Background(), rel, &Asset{Name: "a.zip"}, ""); err == nil {
		t.Fatal("foreign checksum host accepted")
	}
}

func TestCompareVersionsAndChecksumParsing(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{{"1.0.1", "1.0.0", 1}, {"v1.0.0", "1.0.0", 0}, {"1.0", "1.0.1", -1}, {"1.1.0-go", "1.0.1", 1}, {"2", "10", -1}}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("Compare(%s,%s)=%d", c.a, c.b, got)
		}
	}
	m := ParseChecksums(strings.Repeat("A", 64) + " *BenchForge.zip\r\nbad line\n")
	if m["BenchForge.zip"] != strings.Repeat("a", 64) {
		t.Fatalf("parse %v", m)
	}
}

func TestPreparePortableScript(t *testing.T) {
	dir := t.TempDir()
	plan, err := PreparePortable(dir, `C:\apps\BenchForge\BenchForge.exe`)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(plan.ScriptPath)
	if plan.ExeName != "BenchForge.exe" || !strings.Contains(string(b), "Where-Object { $_.Name -ne 'data' }") {
		t.Fatal("portable script must keep the data folder")
	}
}
