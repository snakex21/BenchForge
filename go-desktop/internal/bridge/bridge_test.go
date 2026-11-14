package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type settled struct {
	id      int64
	ok      bool
	payload any
}

func collect() (Settler, func(time.Duration) []settled) {
	var mu sync.Mutex
	var out []settled
	ch := make(chan struct{}, 100)
	return func(id int64, ok bool, payload any) {
			mu.Lock()
			out = append(out, settled{id, ok, payload})
			mu.Unlock()
			ch <- struct{}{}
		}, func(d time.Duration) []settled {
			select {
			case <-ch:
			case <-time.After(d):
			}
			mu.Lock()
			defer mu.Unlock()
			return append([]settled(nil), out...)
		}
}

func newTestDispatcher() *Dispatcher {
	d := New(context.Background(), "0123456789abcdef0123456789abcdef")
	d.Handle("echo", func(ctx context.Context, a Args) (any, error) {
		o, err := a.Obj(0, false)
		if err != nil {
			return nil, err
		}
		id, err := ID(o, "id")
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": id}, nil
	})
	d.Handle("boom", func(ctx context.Context, a Args) (any, error) { panic("kaboom") })
	d.Handle("fail", func(ctx context.Context, a Args) (any, error) { return nil, errors.New("nope") })
	return d
}

func TestInvokeRejectsBadToken(t *testing.T) {
	d := newTestDispatcher()
	settle, _ := collect()
	for _, tok := range []string{"", "x", "0123456789abcdef0123456789abcdeX", "0123456789abcdef0123456789abcdef0"} {
		if err := d.Invoke(tok, 1, "echo", `[{"id":1}]`, settle); err == nil {
			t.Fatalf("token %q accepted", tok)
		}
	}
}

func TestInvokeValidatesAndDispatches(t *testing.T) {
	d := newTestDispatcher()
	tok := "0123456789abcdef0123456789abcdef"
	cases := []struct {
		name, channel, args string
		ok                  bool
		want                string
	}{
		{"valid", "echo", `[{"id":7}]`, true, ""},
		{"unknown channel", "db:drop-everything", `[]`, false, "Unknown channel"},
		{"bad json", "echo", `[{`, false, "Invalid arguments"},
		{"not an object", "echo", `["x"]`, false, "must be an object"},
		{"negative id", "echo", `[{"id":-1}]`, false, "positive integer"},
		{"fractional id", "echo", `[{"id":1.5}]`, false, "positive integer"},
		{"string id", "echo", `[{"id":"1; DROP TABLE"}]`, false, "positive integer"},
		{"handler error", "fail", `[]`, false, "nope"},
		{"handler panic", "boom", `[]`, false, "Internal error"},
	}
	for i, c := range cases {
		settle, wait := collect()
		if err := d.Invoke(tok, float64(i+1), c.channel, c.args, settle); err != nil {
			t.Fatalf("%s: invoke error %v", c.name, err)
		}
		got := wait(2 * time.Second)
		if len(got) != 1 || got[0].id != int64(i+1) || got[0].ok != c.ok {
			t.Fatalf("%s: got %+v", c.name, got)
		}
		if !c.ok {
			if s, _ := got[0].payload.(string); !strings.Contains(s, c.want) {
				t.Fatalf("%s: message %q", c.name, s)
			}
		}
	}
	d.Wait()
}

func TestInvokeRejectsOversizedAndBadIDs(t *testing.T) {
	d := newTestDispatcher()
	tok := "0123456789abcdef0123456789abcdef"
	settle, wait := collect()
	big := `["` + strings.Repeat("a", MaxArgsBytes) + `"]`
	if err := d.Invoke(tok, 1, "echo", big, settle); err != nil {
		t.Fatal(err)
	}
	if got := wait(time.Second); len(got) != 1 || got[0].ok {
		t.Fatalf("oversized: %+v", got)
	}
	if err := d.Invoke(tok, 1.5, "echo", `[]`, settle); err == nil {
		t.Fatal("fractional call id accepted")
	}
}

func TestDuplicateChannelPanics(t *testing.T) {
	d := newTestDispatcher()
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()
	d.Handle("echo", nil)
}

func TestInitScriptEscapesValues(t *testing.T) {
	s := InitScript("http://127.0.0.1:1", `tok"</script>`, map[string]string{"k": `v"'`})
	if strings.Contains(s, "__BF_TOKEN__") || strings.Contains(s, "__BF_ORIGIN__") || strings.Contains(s, "__BF_STORAGE__") {
		t.Fatal("placeholders not substituted")
	}
	if !strings.Contains(s, `"tok\"</script>"`) {
		t.Fatal("token must be a JSON string literal")
	}
	// Every preload API method the UI uses must be provided by the shim.
	for _, m := range []string{"getMeta", "checkForUpdates", "runBenchmarkStreaming", "onStreamEvent", "removeStreamListeners",
		"providerConfigs", "runSession", "submitManualBatch", "judgeEvaluate", "exportArtifactZip", "savePreference"} {
		if !strings.Contains(s, m) {
			t.Errorf("shim lacks %s", m)
		}
	}
}

func TestSettleAndEmitScripts(t *testing.T) {
	s := SettleScript(3, true, map[string]any{"x": "</script>"})
	if !strings.HasPrefix(s, "window.__bfSettle && window.__bfSettle(3,true,") {
		t.Fatalf("settle %q", s)
	}
	e := EmitScript("task:chunk", map[string]any{"text": "a\"b"})
	var v map[string]any
	payload := strings.TrimSuffix(strings.SplitN(e, `"task:chunk",`, 2)[1], ");")
	if err := json.Unmarshal([]byte(payload), &v); err != nil || v["text"] != "a\"b" {
		t.Fatalf("emit payload %q: %v", payload, err)
	}
	// Non-serialisable payloads are reported as failures instead of panicking.
	if s := SettleScript(1, true, map[string]any{"f": func() {}}); !strings.Contains(s, ",false,") {
		t.Fatalf("expected failure settle, got %q", s)
	}
}

func TestIDList(t *testing.T) {
	if _, err := IDList([]any{1.0, 2.0}, "ids", 5); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []any{"x", []any{0.0}, []any{"1"}, []any{1.0, 2.0, 3.0}} {
		if _, err := IDList(bad, "ids", 2); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
}
