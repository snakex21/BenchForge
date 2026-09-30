package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIndependentForeignPageCannotMutateOrInjectKeys(t *testing.T) {
	m, err := newManager(t.TempDir(), Echo{}, "offline", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	h := m.handler("127.0.0.1:8787")
	b, _ := json.Marshal(fixture())
	for _, c := range []struct {
		method, path, host, origin, ct, body string
		want                                 int
	}{
		{"POST", "/api/runs", "attacker.invalid:8787", "", "application/json", string(b), 403},
		{"POST", "/api/runs", "127.0.0.1:8787", "https://attacker.invalid", "application/json", string(b), 403},
		{"POST", "/api/runs", "127.0.0.1:8787", "null", "application/json", string(b), 403},
		{"POST", "/api/runs", "127.0.0.1:8787", "", "text/plain", string(b), 415},
		{"POST", "/api/runs", "127.0.0.1:8787", "", "application/x-www-form-urlencoded", string(b), 415},
		{"OPTIONS", "/api/runs", "127.0.0.1:8787", "https://attacker.invalid", "", "", 403},
		{"GET", "/api/runs/fake/cancel", "127.0.0.1:8787", "", "", "", 405},
		{"POST", "/api/runs", "127.0.0.1:8787", "", "application/json", strings.TrimSuffix(string(b), "}") + `,"api_key":"synthetic-secret"}`, 400},
	} {
		r := httptest.NewRequest(c.method, "http://127.0.0.1:8787"+c.path, strings.NewReader(c.body))
		r.Host = c.host
		r.Header.Set("Origin", c.origin)
		r.Header.Set("Content-Type", c.ct)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Fatalf("%+v got %d %s", c, w.Code, w.Body.String())
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("cross origin allowed")
		}
	}
	if m.active != "" || len(m.reports) != 0 {
		t.Fatal("mutation occurred")
	}
}
func TestIndependentNoCredentialOrRemoteEndpoints(t *testing.T) {
	for _, x := range []string{"https://api.openai.com/v1", "http://example.org/v1", "http://localhost/v1?api_key=synthetic", "http://user:synthetic@localhost/v1", "http://127.0.0.1/v1#secret", "http://0.0.0.0/v1", "http://[::]/v1"} {
		if _, err := localEndpoint(x); err == nil {
			t.Fatal("endpoint accepted", x)
		}
	}
}
func TestIndependentMalformedURLDiagnostic(t *testing.T) {
	_, err := localEndpoint("http://user:synthetic-secret@localhost/%zz")
	if err == nil {
		t.Fatal("malformed URL accepted")
	}
	if strings.Contains(err.Error(), "synthetic-secret") {
		t.Fatal("diagnostic exposed rejected credential")
	}
}
func TestIndependentForeignCancelCannotStopActiveRun(t *testing.T) {
	started := make(chan struct{})
	m, err := newManager(t.TempDir(), providerFunc(func(c context.Context, m, p string, s Settings) (Output, error) {
		select {
		case <-started:
		default:
			close(started)
		}
		<-c.Done()
		return Output{}, c.Err()
	}), "fake", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	req := fixture()
	req.Settings.TimeoutMS = 10000
	r, err := m.start(req)
	if err != nil {
		t.Fatal(err)
	}
	<-started
	h := m.handler("127.0.0.1:8787")
	for _, o := range []string{"https://attacker.invalid", "null"} {
		q := httptest.NewRequest("POST", "http://127.0.0.1:8787/api/runs/"+r.ID+"/cancel", strings.NewReader(`{}`))
		q.Header.Set("Origin", o)
		q.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, q)
		if w.Code != 403 {
			t.Fatal(w.Code)
		}
		select {
		case <-m.done:
			t.Fatal("foreign request cancelled run")
		default:
		}
	}
	if !m.stop(r.ID) {
		t.Fatal("authorized cleanup cancellation failed")
	}
	waitRun(t, m)
}
