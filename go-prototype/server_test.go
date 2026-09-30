package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitRun(t *testing.T, m *Manager) {
	t.Helper()
	m.mu.Lock()
	done := m.done
	m.mu.Unlock()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("run did not terminate")
	}
}
func TestManagerPersistReloadAndExclusiveRun(t *testing.T) {
	dir := t.TempDir()
	started := make(chan struct{})
	p := providerFunc(func(ctx context.Context, m, p string, s Settings) (Output, error) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-ctx.Done()
		return Output{}, ctx.Err()
	})
	m, err := newManager(dir, p, "test", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	r, err := m.start(fixture())
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, err = m.start(fixture()); err == nil {
		t.Fatal("parallel run permitted")
	}
	if !m.stop(r.ID) {
		t.Fatal("cancel failed")
	}
	waitRun(t, m)
	loaded, err := newManager(dir, Echo{}, "test", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.close()
	if loaded.reports[r.ID].State != "cancelled" || loaded.reports[r.ID].Summaries[0].Score != nil {
		t.Fatal(loaded.reports)
	}
	if _, err = os.Stat(filepath.Join(dir, r.ID+".json")); err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(dir, ".report-*"))
	if len(files) > 0 {
		t.Fatal("temp report leaked")
	}
}
func TestInterruptedReportIsNotMarkedComplete(t *testing.T) {
	dir := t.TempDir()
	r := newReport("saved", fixture(), "test")
	if err := atomicReport(dir, r); err != nil {
		t.Fatal(err)
	}
	m, err := newManager(dir, Echo{}, "test", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	if m.reports[r.ID].State != "interrupted" || m.reports[r.ID].Summaries[0].Score != nil {
		t.Fatal(m.reports)
	}
}
func TestAPIRejectsCrossOriginHostUnknownFieldsAndLegacy(t *testing.T) {
	m, _ := newManager(t.TempDir(), Echo{}, "offline", []string{"echo"})
	defer m.close()
	h := m.handler("127.0.0.1:8787")
	send := func(body, origin, host, ct string) int {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8787/api/runs", strings.NewReader(body))
		r.Host = host
		r.Header.Set("Content-Type", ct)
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	b, _ := json.Marshal(fixture())
	body := string(b)
	for _, c := range []struct {
		body, origin, host, ct string
		want                   int
	}{{body, "https://evil.example", "127.0.0.1:8787", "application/json", 403}, {body, "", "evil.example", "application/json", 403}, {body, "", "127.0.0.1:8787", "text/plain", 415}, {`{"unexpected":true}`, "", "127.0.0.1:8787", "application/json", 400}, {`[]`, "", "127.0.0.1:8787", "application/json", 400}, {body + body, "", "127.0.0.1:8787", "application/json", 400}} {
		if got := send(c.body, c.origin, c.host, c.ct); got != c.want {
			t.Fatalf("got %d want %d", got, c.want)
		}
	}
	if got := send(body, "http://127.0.0.1:8787", "127.0.0.1:8787", "application/json"); got != 202 {
		t.Fatal(got)
	}
	waitRun(t, m)
}
func TestAPIEndToEndEchoExport(t *testing.T) {
	m, _ := newManager(t.TempDir(), Echo{}, "offline", []string{"echo"})
	defer m.close()
	h := m.handler("127.0.0.1:8787")
	b, _ := json.Marshal(fixture())
	req := httptest.NewRequest("POST", "http://127.0.0.1:8787/api/runs", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 202 {
		t.Fatal(w.Body.String())
	}
	var initial Report
	_ = json.Unmarshal(w.Body.Bytes(), &initial)
	waitRun(t, m)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8787/api/runs/"+initial.ID, nil))
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	var final Report
	if err := json.Unmarshal(w.Body.Bytes(), &final); err != nil {
		t.Fatal(err)
	}
	if final.State != "completed" || len(final.Results) != 3 || final.Summaries[0].Passed != 2 {
		t.Fatal(final)
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8787/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "BenchForge") {
		t.Fatal("UI unavailable")
	}
}
func TestLocalAPIUsesUniformSettingsAndRealHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Error(r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["max_tokens"] != float64(256) || body["temperature"] != float64(0) || body["model"] != "local" {
			t.Error(body)
		}
		io.WriteString(w, `{"model":"actual-local-v2","system_fingerprint":"runtime123","choices":[{"message":{"content":"4"}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}`)
	}))
	defer server.Close()
	p := LocalAPI{BaseURL: server.URL + "/v1", Client: server.Client()}
	out, err := p.Generate(context.Background(), "local", "2+2", fixture().Settings)
	if err != nil || out.Text != "4" || out.ActualModel != "actual-local-v2" || out.SystemFingerprint != "runtime123" || out.InputTokens == nil || *out.InputTokens != 2 {
		t.Fatal(out, err)
	}
}
func TestLocalAPICancelAndBadResponses(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if strings.Contains(string(b), "wait") {
			<-r.Context().Done()
			return
		}
		io.WriteString(w, `{"choices":[]}`)
	}))
	defer server.Close()
	p := LocalAPI{server.URL, server.Client()}
	if _, err := p.Generate(context.Background(), "local", "bad", fixture().Settings); err == nil {
		t.Fatal("empty choices accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := p.Generate(ctx, "local", "wait", fixture().Settings); err == nil {
		t.Fatal("request was not cancelled")
	}
}
func TestEndpointSafety(t *testing.T) {
	for _, s := range []string{"https://api.example/v1", "http://192.168.1.1/v1", "http://user:pass@localhost/v1", "http://localhost/v1?key=secret"} {
		if _, err := localEndpoint(s); err == nil {
			t.Fatal(s)
		}
	}
	if _, err := localEndpoint("http://127.0.0.1:1234/v1"); err != nil {
		t.Fatal(err)
	}
}

func TestProviderEndpointPersistsAndExports(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"choices":[{"message":{"content":"4"}}]}`)
	}))
	defer server.Close()
	dir := t.TempDir()
	p := LocalAPI{server.URL + "/v1", server.Client()}
	m, err := newManager(dir, p, "local", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	r, err := m.start(fixture())
	if err != nil {
		t.Fatal(err)
	}
	waitRun(t, m)
	loaded, err := newManager(dir, Echo{}, "different", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.close()
	if r.ProviderEndpoint != p.BaseURL || loaded.reports[r.ID].ProviderEndpoint != p.BaseURL {
		t.Fatal("provider provenance lost")
	}
}

func TestLocalAPIBoundsOversizedResponse(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Repeat("x", 256*1024+1))
	}))
	defer s.Close()
	p := LocalAPI{s.URL, s.Client()}
	if _, err := p.Generate(context.Background(), "local", "4", fixture().Settings); err == nil || !strings.Contains(err.Error(), "256 KiB") {
		t.Fatal(err)
	}
}
