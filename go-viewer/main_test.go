package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func synthetic(t *testing.T) []byte {
	t.Helper()
	b, err := assets.ReadFile("examples/synthetic.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func call(h http.Handler, method, path, host, origin string) (int, string) {
	r := httptest.NewRequest(method, "http://127.0.0.1:8788"+path, strings.NewReader(`{"id":1}`))
	r.Host = host
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}
func TestReadOnlyViewsAndAllMutationsRejected(t *testing.T) {
	s, err := parseSnapshot(synthetic(t))
	if err != nil {
		t.Fatal(err)
	}
	h := handler(s, "127.0.0.1:8788")
	for _, path := range []string{"/api/readonly/meta", "/api/readonly/models", "/api/readonly/benchmarks", "/api/readonly/tasks?benchmark_id=1", "/api/readonly/results", "/api/readonly/runs"} {
		if status, _ := call(h, "GET", path, "127.0.0.1:8788", ""); status != 200 {
			t.Fatal(path, status)
		}
		for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
			if status, _ := call(h, method, path, "127.0.0.1:8788", ""); status != 403 {
				t.Fatal(method, path, status)
			}
		}
	}
	for _, path := range []string{"/api/db/tasks/delete", "/api/runs", "/api/readonly/import", "/api/readonly/provider-configs"} {
		if status, body := call(h, "GET", path, "127.0.0.1:8788", ""); status != 404 || !strings.Contains(body, "unsupported") {
			t.Fatal(path, status, body)
		}
	}
	if status, _ := call(h, "GET", "/api/readonly/tasks?benchmark_id=missing", "127.0.0.1:8788", ""); status != 400 {
		t.Fatal(status)
	}
	if status, _ := call(h, "GET", "/api/readonly/tasks?benchmark_id=99", "127.0.0.1:8788", ""); status != 404 {
		t.Fatal(status)
	}
}
func TestSnapshotAndFolderUnchangedByOpenAndRequests(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "copied-snapshot.json")
	original := synthetic(t)
	if err := os.WriteFile(path, original, 0400); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	s, err := loadSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	h := handler(s, "127.0.0.1:8788")
	for i := 0; i < 10; i++ {
		for _, p := range []string{"/", "/api/readonly/models", "/api/readonly/tasks?benchmark_id=1", "/api/readonly/results", "/api/readonly/meta"} {
			call(h, "GET", p, "127.0.0.1:8788", "")
			call(h, "POST", p, "127.0.0.1:8788", "")
		}
	}
	afterBytes, _ := os.ReadFile(path)
	after, _ := os.Stat(path)
	entries, _ := os.ReadDir(dir)
	if !bytes.Equal(original, afterBytes) || !after.ModTime().Equal(before.ModTime()) || len(entries) != 1 {
		t.Fatal("read-only open modified snapshot or created data")
	}
	if len(s.Tasks) != 2 || s.Tasks[0]["name"] != "Zadanie 1" {
		t.Fatal("startup cleanup altered legacy task rows")
	}
}
func TestProjectionDoesNotExposeCredentialOrThinkingFields(t *testing.T) {
	var raw map[string]any
	if err := json.Unmarshal(synthetic(t), &raw); err != nil {
		t.Fatal(err)
	}
	model := raw["models"].([]any)[0].(map[string]any)
	model["api_key"] = "synthetic-secret"
	model["base_url"] = "http://user:synthetic-secret@localhost"
	raw["results"].([]any)[0].(map[string]any)["thinking_notes"] = "private-extra-fixture"
	b, _ := json.Marshal(raw)
	s, err := parseSnapshot(b)
	if err != nil {
		t.Fatal(err)
	}
	h := handler(s, "127.0.0.1:8788")
	for _, path := range []string{"/api/readonly/models", "/api/readonly/results"} {
		_, body := call(h, "GET", path, "127.0.0.1:8788", "")
		if strings.Contains(body, "synthetic-secret") || strings.Contains(body, "private-extra-fixture") || strings.Contains(body, "api_key") {
			t.Fatal(body)
		}
	}
}
func TestSnapshotRejectsInvalidDataWithoutPartialSuccess(t *testing.T) {
	for _, b := range [][]byte{[]byte("SQLite format 3\x00"), []byte(`{"version":"legacy"}`), append(synthetic(t), []byte(`{}`)...), bytes.Replace(synthetic(t), []byte(`"benchmark_id": 1`), []byte(`"benchmark_id": 99`), 1), bytes.Replace(synthetic(t), []byte(`"score": "100"`), []byte(`"score": 100`), 1)} {
		if _, err := parseSnapshot(b); err == nil {
			t.Fatal("invalid fixture accepted")
		}
	}
}
func TestHostOriginAndNullOriginBlocked(t *testing.T) {
	s, _ := parseSnapshot(synthetic(t))
	h := handler(s, "127.0.0.1:8788")
	for _, c := range []struct{ host, origin string }{{"evil.test:8788", ""}, {"127.0.0.1:8788", "https://evil.test"}, {"127.0.0.1:8788", "null"}} {
		if status, _ := call(h, "GET", "/api/readonly/models", c.host, c.origin); status != 403 {
			t.Fatal(c, status)
		}
	}
}
func TestExistingBuiltFrontendAndLocaleAssetsServed(t *testing.T) {
	s, _ := parseSnapshot(synthetic(t))
	h := handler(s, "127.0.0.1:8788")
	status, html := call(h, "GET", "/", "127.0.0.1:8788", "")
	if status != 200 || !strings.Contains(html, "Read-only snapshot") || !strings.Contains(html, "/assets/") {
		t.Fatal(status, html)
	}
	files, err := fs.ReadDir(assets, "web/assets")
	if err != nil {
		t.Fatal(err)
	}
	locales := 0
	for _, f := range files {
		if strings.HasSuffix(f.Name(), ".js") && !strings.HasPrefix(f.Name(), "readonly-") {
			locales++
		}
		if status, _ := call(h, "GET", "/assets/"+f.Name(), "127.0.0.1:8788", ""); status != 200 {
			t.Fatal(f.Name(), status)
		}
	}
	// Polish and English are bundled eagerly; other 56 locale chunks stay reusable.
	if locales < 56 {
		t.Fatalf("missing locale assets: %d", locales)
	}
	if status, _ := call(h, "GET", "/assets/", "127.0.0.1:8788", ""); status != 404 {
		t.Fatal("directory listing available")
	}
}
func TestImmutableMemorySnapshotAndHash(t *testing.T) {
	b := synthetic(t)
	s, _ := parseSnapshot(b)
	before, _ := json.Marshal(s)
	h := handler(s, "127.0.0.1:8788")
	sum := sha256.Sum256(b)
	if s.hash != fmt.Sprintf("%x", sum) {
		t.Fatal("hash mismatch")
	}
	for i := 0; i < 20; i++ {
		call(h, "GET", "/api/readonly/tasks?benchmark_id=1", "127.0.0.1:8788", "")
	}
	after, _ := json.Marshal(s)
	if !bytes.Equal(before, after) {
		t.Fatal("handler changed loaded data")
	}
}
func TestActualHTTPReadOnlyContract(t *testing.T) {
	s, _ := parseSnapshot(synthetic(t))
	var h http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { h.ServeHTTP(w, r) }))
	defer server.Close()
	h = handler(s, strings.TrimPrefix(server.URL, "http://"))
	response, err := server.Client().Get(server.URL + "/api/readonly/models")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	b, _ := io.ReadAll(response.Body)
	if response.StatusCode != 200 || !strings.Contains(string(b), "Fixture Model A") {
		t.Fatal(string(b))
	}
}
func TestRejectsMissingNullCollectionsAndMalformedFields(t *testing.T) {
	for _, collection := range []string{"models", "benchmarks", "tasks", "results", "runs"} {
		for _, omit := range []bool{false, true} {
			var raw map[string]any
			_ = json.Unmarshal(synthetic(t), &raw)
			if omit {
				delete(raw, collection)
			} else {
				raw[collection] = nil
			}
			b, _ := json.Marshal(raw)
			if _, err := parseSnapshot(b); err == nil {
				t.Fatalf("accepted invalid collection %s omit=%v", collection, omit)
			}
		}
	}
	for _, c := range []struct {
		kind, key string
		value     any
	}{{"benchmarks", "category", map[string]any{}}, {"models", "model_id", map[string]any{}}, {"models", "active", "true"}, {"benchmarks", "evaluation_checklist", map[string]any{}}, {"benchmarks", "evaluation_checklist", []any{map[string]any{}}}, {"benchmarks", "evaluation_rubric", map[string]any{}}, {"benchmarks", "evaluation_rubric", []any{map[string]any{"label": 12, "points": 1, "type": "checkbox"}}}, {"results", "duration_ms", "100"}, {"results", "notes", []any{}}, {"tasks", "attempts", 0}, {"runs", "name", map[string]any{}}} {
		var raw map[string]any
		_ = json.Unmarshal(synthetic(t), &raw)
		raw[c.kind].([]any)[0].(map[string]any)[c.key] = c.value
		b, _ := json.Marshal(raw)
		if _, err := parseSnapshot(b); err == nil {
			t.Fatalf("accepted invalid %s.%s", c.kind, c.key)
		}
	}
}
func TestExplicitEmptyCollectionsRemainValid(t *testing.T) {
	b := []byte(`{"version":"benchforge-readonly-snapshot-v1","label":"Explicit empty data","source_kind":"copied-export","evaluator_origin":"legacy","models":[],"benchmarks":[],"tasks":[],"results":[],"runs":[]}`)
	if _, err := parseSnapshot(b); err != nil {
		t.Fatal(err)
	}
}
func TestResponseNotesPreservedForHistoricalCodePresenceDisplay(t *testing.T) {
	var raw map[string]any
	_ = json.Unmarshal(synthetic(t), &raw)
	raw["results"].([]any)[0].(map[string]any)["notes"] = "function answer() { return 4 }"
	b, _ := json.Marshal(raw)
	s, err := parseSnapshot(b)
	if err != nil {
		t.Fatal(err)
	}
	if s.Results[0]["notes"] != "function answer() { return 4 }" {
		t.Fatal("historical display evidence lost")
	}
}

func TestLegacyRubricOptionalTypeAccepted(t *testing.T) {
	var raw map[string]any
	_ = json.Unmarshal(synthetic(t), &raw)
	raw["benchmarks"].([]any)[0].(map[string]any)["evaluation_rubric"] = []any{map[string]any{"label": "Correctness", "points": 1}}
	b, _ := json.Marshal(raw)
	if _, err := parseSnapshot(b); err != nil {
		t.Fatal(err)
	}
}
