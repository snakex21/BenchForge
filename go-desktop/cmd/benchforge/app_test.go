package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/bridge"
	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
)

type fakeHost struct {
	mu     sync.Mutex
	events []string
}

func (h *fakeHost) Emit(e string, _ any) { h.mu.Lock(); h.events = append(h.events, e); h.mu.Unlock() }
func (h *fakeHost) OnUI(fn func())       { fn() }
func (h *fakeHost) HWND() uintptr        { return 0 }
func (h *fakeHost) Quit()                {}

const testToken = "0123456789abcdef0123456789abcdef"

func newTestApp(t *testing.T) (*App, *bridge.Dispatcher, *[]string) {
	t.Helper()
	dir := t.TempDir()
	paths.SetDataDirForTests(dir)
	t.Cleanup(func() { paths.SetDataDirForTests("") })
	store, err := db.Open(filepath.Join(dir, "benchforge.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	host := &fakeHost{}
	app := NewApp("1.2.3", store, host)
	opened := &[]string{}
	app.ShellOpen = func(target string) error { *opened = append(*opened, target); return nil }
	app.SaveDialog = func(string, string, string, string) (string, bool, error) { return "", false, nil }
	app.OpenDialog = func(string, string, string) (string, bool, error) { return "", false, nil }
	app.Confirm = func(string, string) bool { return false }
	d := bridge.New(context.Background(), testToken)
	app.Register(d)
	return app, d, opened
}

func call(t *testing.T, d *bridge.Dispatcher, channel string, args ...any) (bool, any) {
	t.Helper()
	b, _ := json.Marshal(args)
	type res struct {
		ok bool
		v  any
	}
	ch := make(chan res, 1)
	if err := d.Invoke(testToken, 1, channel, string(b), func(_ int64, ok bool, v any) { ch <- res{ok, v} }); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-ch:
		// Round-trip through JSON like the real bridge does.
		raw, _ := json.Marshal(r.v)
		var out any
		_ = json.Unmarshal(raw, &out)
		return r.ok, out
	case <-time.After(10 * time.Second):
		t.Fatalf("%s timed out", channel)
		return false, nil
	}
}

// Every IPC channel exposed by electron/preload.cjs must exist in Go.
func TestAllPreloadChannelsRegistered(t *testing.T) {
	_, d, _ := newTestApp(t)
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "docs", "migration", "preload-contract-inventory.json"))
	if err != nil {
		t.Skip("inventory not available: ", err)
	}
	var inv struct {
		Request []string `json:"request_channels"`
		Events  []string `json:"event_channels"`
	}
	if err := json.Unmarshal(raw, &inv); err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, c := range d.Channels() {
		have[c] = true
	}
	var missing []string
	for _, c := range inv.Request {
		if !have[c] {
			missing = append(missing, c)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("channels not ported: %v", missing)
	}
	shim := bridge.InitScript("http://127.0.0.1:1", testToken, nil)
	for _, c := range append(inv.Request, inv.Events...) {
		if !strings.Contains(shim, "'"+c+"'") {
			t.Errorf("shim does not use channel/event %s", c)
		}
	}
}

func TestCoreFlowThroughBridge(t *testing.T) {
	_, d, _ := newTestApp(t)
	ok, meta := call(t, d, "app:get-meta")
	if !ok || meta.(map[string]any)["version"] != "1.2.3" {
		t.Fatalf("meta %v", meta)
	}
	ok, m := call(t, d, "db:models:add", map[string]any{"name": "M", "mode": "manual"})
	if !ok {
		t.Fatalf("add model: %v", m)
	}
	ok, b := call(t, d, "db:benchmarks:add", map[string]any{"name": "B", "category": "c", "prompt_template": "p", "score_type": "numeric"})
	if !ok {
		t.Fatalf("add benchmark: %v", b)
	}
	bid := b.(map[string]any)["id"]
	ok, task := call(t, d, "db:tasks:add", map[string]any{"benchmarkId": bid, "name": "T", "promptTemplate": "x", "scoreType": "numeric"})
	if !ok {
		t.Fatalf("add task: %v", task)
	}
	ok, res := call(t, d, "benchmark:submit-manual-batch", map[string]any{"modelId": m.(map[string]any)["id"], "benchmarkId": bid,
		"entries": []any{map[string]any{"taskId": task.(map[string]any)["id"], "response": "answer", "score": "70"}}, "finish": true})
	if !ok || res.(map[string]any)["ok"] != true {
		t.Fatalf("manual batch: %v", res)
	}
	if agg := res.(map[string]any)["aggregate"].(map[string]any); agg["score"] != "70" {
		t.Fatalf("aggregate %v", agg)
	}
	ok, results := call(t, d, "db:results:get")
	if !ok || len(results.([]any)) != 2 {
		t.Fatalf("results %v", results)
	}
}

func TestBridgeValidation(t *testing.T) {
	_, d, opened := newTestApp(t)
	bad := []struct {
		channel string
		args    []any
	}{
		{"db:models:add", []any{map[string]any{"name": "x", "mode": "shell"}}},
		{"db:models:add", []any{map[string]any{"name": "x", "mode": "api", "base_url": "file:///C:/Windows"}}},
		{"db:models:update", []any{map[string]any{"id": "1 OR 1=1", "data": map[string]any{}}}},
		{"db:benchmarks:add", []any{map[string]any{"name": "x", "category": "c", "score_type": "evil"}}},
		{"db:tasks:reorder", []any{map[string]any{"benchmarkId": 1, "orderedIds": []any{"1"}}}},
		{"db:preference:set", []any{"sandbox_host_optin", true}},
		{"db:import-all", []any{"not an object"}},
		{"files:save-text", []any{map[string]any{"extension": "exe\\..\\x", "content": "x"}}},
		{"updates:check", []any{map[string]any{"repo": "attacker/repo"}}},
		{"updates:download", []any{map[string]any{"repo": "attacker/repo"}}},
		{"updates:apply-portable", []any{map[string]any{"repo": "attacker/repo"}}},
	}
	for _, c := range bad {
		if ok, v := call(t, d, c.channel, c.args...); ok {
			t.Errorf("%s %v accepted: %v", c.channel, c.args, v)
		}
	}
	// open-external: HTTPS only, nothing opened otherwise.
	for _, u := range []string{"http://example.com", "file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "ms-settings:"} {
		_, v := call(t, d, "app:open-external", u)
		if v.(map[string]any)["ok"] != false {
			t.Errorf("%s allowed", u)
		}
	}
	_, v := call(t, d, "app:open-external", "https://github.com/snakex21/BenchForge")
	if v.(map[string]any)["ok"] != true || len(*opened) != 1 {
		t.Fatalf("https link: %v %v", v, *opened)
	}
	// open-path is confined to data/artifacts.
	for _, p := range []string{"../../Windows", `C:\Windows`, "benchforge.db"} {
		_, v := call(t, d, "files:open-path", p)
		if v.(map[string]any)["ok"] != false {
			t.Errorf("open-path %s allowed", p)
		}
	}
}

func TestDockerToggleNeedsConfirmation(t *testing.T) {
	app, d, _ := newTestApp(t)
	if _, v := call(t, d, "db:preference:get", "sandbox_use_docker"); v != true {
		t.Fatalf("Docker must be the default, got %v", v)
	}
	// User declines the warning: stays on Docker.
	if ok, _ := call(t, d, "db:preference:set", "sandbox_use_docker", false); ok {
		t.Fatal("declined confirmation must fail")
	}
	if app.policy().Mode() != "docker" {
		t.Fatal("still docker")
	}
	// User accepts: host execution enabled explicitly.
	app.Confirm = func(string, string) bool { return true }
	if ok, v := call(t, d, "db:preference:set", "sandbox_use_docker", false); !ok {
		t.Fatalf("accepted confirmation failed: %v", v)
	}
	if app.policy().Mode() != "host" {
		t.Fatalf("mode %s", app.policy().Mode())
	}
	// Re-enabling Docker clears the opt-in.
	call(t, d, "db:preference:set", "sandbox_use_docker", true)
	if app.policy().Mode() != "docker" || app.Store.Pref("sandbox_host_optin") != false {
		t.Fatal("opt-in must be cleared")
	}
}

func TestStorageSnapshotPersists(t *testing.T) {
	_, d, _ := newTestApp(t)
	if ok, v := call(t, d, "internal:storage-sync", map[string]any{"benchforge-ui": `{"state":{"theme":"light"}}`, "bad": 5}); !ok {
		t.Fatal(v)
	}
	got := loadStorage()
	if got["benchforge-ui"] == "" || got["bad"] != "" {
		t.Fatalf("snapshot %v", got)
	}
}
