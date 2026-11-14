package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

//go:embed web/*
var webFiles embed.FS

type Manager struct {
	mu       sync.Mutex
	reports  map[string]Report
	active   string
	cancel   context.CancelFunc
	done     chan struct{}
	dir      string
	provider Provider
	label    string
	models   []string
}

func copyReport(r Report) Report {
	b, _ := json.Marshal(r)
	var c Report
	_ = json.Unmarshal(b, &c)
	return c
}
func atomicReport(dir string, r Report) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if len(b) > 16*1024*1024 {
		return errors.New("report exceeds 16 MiB safety limit")
	}
	f, err := os.CreateTemp(dir, ".report-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(dir, r.ID+".json"))
}
func newManager(dir string, p Provider, label string, models []string) (*Manager, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	m := &Manager{reports: map[string]Report{}, dir: dir, provider: p, label: label, models: models}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	// Retain at most the newest 20 reports in memory; older files remain on disk.
	sort.Slice(entries, func(i, j int) bool {
		a, _ := entries[i].Info()
		b, _ := entries[j].Info()
		if a == nil || b == nil {
			return entries[i].Name() > entries[j].Name()
		}
		return a.ModTime().After(b.ModTime())
	})
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if len(m.reports) >= 20 {
			break
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		if info.Size() > 16*1024*1024 {
			return nil, fmt.Errorf("report too large: %s", e.Name())
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		var r Report
		if err = json.Unmarshal(b, &r); err != nil {
			return nil, fmt.Errorf("read report %s: %w", e.Name(), err)
		}
		if r.Contract != Contract || r.ID+".json" != e.Name() {
			return nil, fmt.Errorf("invalid report identity: %s", e.Name())
		}
		if r.State == "running" {
			r.State = "interrupted"
			for i := range r.Results {
				if r.Results[i].State == "running" || r.Results[i].State == "queued" {
					r.Results[i].State = "skipped"
				}
			}
			summarize(&r)
			if err := atomicReport(dir, r); err != nil {
				return nil, err
			}
		}
		m.reports[r.ID] = r
	}
	return m, nil
}
func (m *Manager) start(req Request) (Report, error) {
	if err := validate(req); err != nil {
		return Report{}, err
	}
	allowed := map[string]bool{}
	for _, s := range m.models {
		allowed[s] = true
	}
	for _, s := range req.Models {
		if !allowed[s] {
			return Report{}, fmt.Errorf("model %q is not configured", s)
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active != "" {
		return Report{}, errors.New("a run is already active; wait or cancel it")
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return Report{}, err
	}
	r := newReport(hex.EncodeToString(b), req, m.label)
	if identified, ok := m.provider.(interface{ Endpoint() string }); ok {
		r.ProviderEndpoint = identified.Endpoint()
	}
	if err := atomicReport(m.dir, r); err != nil {
		return Report{}, fmt.Errorf("save initial report: %w", err)
	}
	if len(m.reports) >= 20 {
		var oldest string
		for id, x := range m.reports {
			if oldest == "" || x.Started.Before(m.reports[oldest].Started) {
				oldest = id
			}
		}
		delete(m.reports, oldest)
	}
	m.reports[r.ID] = copyReport(r)
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.active = r.ID
	m.done = make(chan struct{})
	done := m.done
	initial := copyReport(r)
	go func() {
		final := execute(ctx, r, m.provider, func(updated Report) error {
			m.mu.Lock()
			defer m.mu.Unlock()
			if err := atomicReport(m.dir, updated); err != nil {
				return err
			}
			m.reports[r.ID] = copyReport(updated)
			return nil
		})
		m.mu.Lock()
		m.reports[r.ID] = copyReport(final)
		m.active = ""
		m.cancel = nil
		m.mu.Unlock()
		cancel()
		close(done)
	}()
	return initial, nil
}
func (m *Manager) stop(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active != id || m.cancel == nil {
		return false
	}
	m.cancel()
	return true
}
func (m *Manager) close() {
	m.mu.Lock()
	done := m.done
	if m.cancel != nil {
		m.cancel()
	}
	m.mu.Unlock()
	if done != nil {
		<-done
	}
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, err string) {
	writeJSON(w, status, map[string]string{"error": err})
}
func (m *Manager) handler(host string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			fail(w, 405, "GET required")
			return
		}
		writeJSON(w, 200, map[string]any{"provider": m.label, "models": m.models, "contract": Contract})
	})
	mux.HandleFunc("/api/runs", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			m.mu.Lock()
			defer m.mu.Unlock()
			list := make([]Report, 0, len(m.reports))
			for _, x := range m.reports {
				list = append(list, x)
			}
			sort.Slice(list, func(i, j int) bool { return list[i].Started.After(list[j].Started) })
			writeJSON(w, 200, list)
			return
		}
		if r.Method != "POST" {
			fail(w, 405, "GET or POST required")
			return
		}
		var req Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			fail(w, 400, err.Error())
			return
		}
		if err := dec.Decode(&struct{}{}); err != io.EOF {
			fail(w, 400, "one JSON object required")
			return
		}
		report, err := m.start(req)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
		writeJSON(w, 202, report)
	})
	mux.HandleFunc("/api/runs/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, "/api/runs/")
		parts := strings.Split(rest, "/")
		id := parts[0]
		if len(parts) == 2 && parts[1] == "cancel" && r.Method == "POST" {
			if !m.stop(id) {
				fail(w, 409, "run is not active")
				return
			}
			writeJSON(w, 202, map[string]string{"state": "cancelling"})
			return
		}
		if len(parts) != 1 || r.Method != "GET" {
			fail(w, 405, "GET run or POST cancel required")
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		report, ok := m.reports[id]
		if !ok {
			fail(w, 404, "run not found")
			return
		}
		writeJSON(w, 200, report)
	})
	sub, _ := fs.Sub(webFiles, "web")
	mux.Handle("/", http.FileServer(http.FS(sub)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'")
		if r.Host != host {
			fail(w, 403, "invalid Host")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+host {
			fail(w, 403, "cross-origin requests are forbidden")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Content-Type") != "application/json" {
			fail(w, 415, "application/json required")
			return
		}
		mux.ServeHTTP(w, r)
	})
}
