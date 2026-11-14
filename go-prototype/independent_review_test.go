package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIndependentLateSuccessIsTimeout(t *testing.T) {
	req := fixture()
	req.Settings.TimeoutMS = 10
	req.Suite.Tasks = req.Suite.Tasks[:1]
	p := providerFunc(func(c context.Context, m, p string, s Settings) (Output, error) {
		<-c.Done()
		return Output{Text: "4"}, nil
	})
	r := execute(context.Background(), newReport("x", req, "fake"), p, discard)
	if r.Results[0].State != "timeout" || r.Summaries[0].Score != nil {
		t.Fatal(r)
	}
}
func TestIndependentCancelAfterFirstCommittedResult(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	n := 0
	p := providerFunc(func(c context.Context, m, p string, s Settings) (Output, error) { n++; return Output{Text: p}, nil })
	save := func(r Report) error {
		if r.Results[0].State == "passed" {
			cancel()
		}
		return nil
	}
	r := execute(ctx, newReport("x", fixture(), "fake"), p, save)
	if n != 1 || r.State != "cancelled" || r.Results[0].State != "passed" || r.Results[1].State != "skipped" || r.Summaries[0].Score != nil {
		t.Fatal(r)
	}
}
func TestIndependentPostResultStorageFailureStopsNextCall(t *testing.T) {
	calls := 0
	p := providerFunc(func(c context.Context, m, p string, s Settings) (Output, error) { calls++; return Output{Text: p}, nil })
	r := execute(context.Background(), newReport("x", fixture(), "fake"), p, func(r Report) error {
		if r.Results[0].State == "passed" {
			return errors.New("fixture disk failure")
		}
		return nil
	})
	if calls != 1 || r.State != "storage_error" {
		t.Fatal(r)
	}
}
func TestIndependentFullProvenanceReload(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"model":"actual-revision","system_fingerprint":"fake-runtime","choices":[{"message":{"content":"4"}}]}`)
	}))
	defer s.Close()
	dir := t.TempDir()
	m, err := newManager(dir, LocalAPI{s.URL + "/v1", s.Client()}, "local", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer m.close()
	r, err := m.start(fixture())
	if err != nil {
		t.Fatal(err)
	}
	waitRun(t, m)
	b, err := os.ReadFile(filepath.Join(dir, r.ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk Report
	if err = json.Unmarshal(b, &disk); err != nil {
		t.Fatal(err)
	}
	loaded, err := newManager(dir, Echo{}, "changed", []string{"echo"})
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.close()
	got := loaded.reports[r.ID]
	if disk.ProviderEndpoint != s.URL+"/v1" || got.ProviderEndpoint != disk.ProviderEndpoint || got.Results[0].Output.ActualModel != "actual-revision" || got.Results[0].Output.SystemFingerprint != "fake-runtime" {
		t.Fatal(got)
	}
}
func TestIndependentRedirectNoFollow(t *testing.T) {
	calls := 0
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		io.WriteString(w, `{"choices":[{"message":{"content":"4"}}]}`)
	}))
	defer target.Close()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer s.Close()
	p := LocalAPI{s.URL, &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := p.Generate(ctx, "fake", "4", fixture().Settings); err == nil || calls != 0 {
		t.Fatal("redirect followed", err, calls)
	}
}
