package library

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// fakeFetcher serves canned bodies by URL; anything else fails.
type fakeFetcher struct {
	mu     sync.Mutex
	err    error
	bodies map[string][]byte
	hfRows []any
	calls  []string
}

func (f *fakeFetcher) Get(ctx context.Context, u string) ([]byte, error) {
	f.mu.Lock()
	f.calls = append(f.calls, u)
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.err != nil {
		return nil, f.err
	}
	if b, ok := f.bodies[u]; ok {
		return b, nil
	}
	if strings.HasPrefix(u, hfRowsBase+"?") && f.hfRows != nil {
		parsed, _ := url.Parse(u)
		q := parsed.Query()
		offset, _ := strconv.Atoi(q.Get("offset"))
		length, _ := strconv.Atoi(q.Get("length"))
		end := offset + length
		if end > len(f.hfRows) {
			end = len(f.hfRows)
		}
		var rows []any
		if offset < len(f.hfRows) {
			rows = f.hfRows[offset:end]
		} else {
			rows = []any{}
		}
		return json.Marshal(map[string]any{"rows": rows})
	}
	return nil, fmt.Errorf("unexpected url %s", u)
}

func readTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func onlineFetcher(t *testing.T) *fakeFetcher {
	t.Helper()
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(readTestdata(t, "humaneval.jsonl"))
	_ = zw.Close()
	var rows []any
	if err := json.Unmarshal(readTestdata(t, "hf_rows.json"), &rows); err != nil {
		t.Fatal(err)
	}
	return &fakeFetcher{
		bodies: map[string][]byte{
			humanEvalURL: gz.Bytes(),
			mbppURL:      readTestdata(t, "mbpp.jsonl"),
			gsm8kURL:     readTestdata(t, "gsm8k.jsonl"),
		},
		hfRows: rows,
	}
}

type golden struct {
	List    []any          `json:"list"`
	Offline map[string]any `json:"offline"`
	Online  map[string]any `json:"online"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(readTestdata(t, "golden.json.gz")))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func roundTrip(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// firstDiff returns a path to the first difference between two decoded JSON values.
func firstDiff(path string, a, b any) string {
	switch av := a.(type) {
	case map[string]any:
		bv, ok := b.(map[string]any)
		if !ok {
			return path + ": type mismatch"
		}
		keys := map[string]bool{}
		for k := range av {
			keys[k] = true
		}
		for k := range bv {
			keys[k] = true
		}
		sorted := make([]string, 0, len(keys))
		for k := range keys {
			sorted = append(sorted, k)
		}
		sort.Strings(sorted)
		for _, k := range sorted {
			x, okA := av[k]
			y, okB := bv[k]
			if okA != okB {
				return fmt.Sprintf("%s.%s: present go=%v js=%v", path, k, okA, okB)
			}
			if d := firstDiff(path+"."+k, x, y); d != "" {
				return d
			}
		}
		return ""
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return fmt.Sprintf("%s: array mismatch go=%v js=%v", path, a, b)
		}
		for i := range av {
			if d := firstDiff(fmt.Sprintf("%s[%d]", path, i), av[i], bv[i]); d != "" {
				return d
			}
		}
		return ""
	}
	if !reflect.DeepEqual(a, b) {
		return fmt.Sprintf("%s:\n go=%#v\n js=%#v", path, a, b)
	}
	return ""
}

func optionsForKey(t *testing.T, key string) (string, map[string]any) {
	t.Helper()
	id, limitJSON, ok := strings.Cut(key, "|")
	if !ok {
		t.Fatalf("bad key %q", key)
	}
	if limitJSON == "undefined" {
		return id, map[string]any{}
	}
	var limit any
	if err := json.Unmarshal([]byte(limitJSON), &limit); err != nil {
		t.Fatal(err)
	}
	return id, map[string]any{"limit": limit}
}

func TestGoldenParityWithJS(t *testing.T) {
	g := loadGolden(t)
	ctx := context.Background()

	if d := firstDiff("list", roundTrip(t, ListPacks()), g.List); d != "" {
		t.Errorf("ListPacks differs from JS: %s", d)
	}

	offline := &fakeFetcher{err: errors.New("network down")}
	for key, want := range g.Offline {
		id, opts := optionsForKey(t, key)
		got, err := DownloadPack(ctx, offline, id, opts)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if d := firstDiff(key, roundTrip(t, got), want); d != "" {
			t.Errorf("offline %s differs: %s", key, d)
		}
	}

	for key, want := range g.Online {
		id, opts := optionsForKey(t, key)
		got, err := DownloadPack(ctx, onlineFetcher(t), id, opts)
		if err != nil {
			t.Fatalf("%s: %v", key, err)
		}
		if d := firstDiff(key, roundTrip(t, got), want); d != "" {
			t.Errorf("online %s differs: %s", key, d)
		}
	}
	if len(g.Offline) == 0 || len(g.Online) == 0 {
		t.Fatal("golden file is empty")
	}
}

func TestListPacksMatchesCatalog(t *testing.T) {
	packs := ListPacks()
	if len(packs) != 47 { // electron/benchmarkLibrary.cjs CATALOG has 47 entries
		t.Fatalf("expected 47 packs, got %d", len(packs))
	}
	seen := map[string]bool{}
	for i, p := range packs {
		id := p["id"].(string)
		if id != catalog[i].ID {
			t.Errorf("pack %d id=%s want %s", i, id, catalog[i].ID)
		}
		if seen[id] {
			t.Errorf("duplicate id %s", id)
		}
		seen[id] = true
		total := p["totalTasks"].(int)
		if p["defaultLimit"].(int) > total || p["recommendedLimit"].(int) > total || total <= 0 {
			t.Errorf("%s: inconsistent limits %v", id, p)
		}
		_, hasHomepage := p["homepage"]
		if hasHomepage != (catalog[i].Homepage != "") {
			t.Errorf("%s: homepage presence mismatch", id)
		}
	}
	want := map[string]int{"humaneval": 164, "truthfulqa-mini": 4, "swebench-pro": 4, "mmlu-mini": 6, "rag-mini": 3}
	for _, p := range packs {
		if n, ok := want[p["id"].(string)]; ok && p["totalTasks"].(int) != n {
			t.Errorf("%s totalTasks=%v want %d", p["id"], p["totalTasks"], n)
		}
	}
}

func TestEveryFallbackPackHasTasks(t *testing.T) {
	for _, item := range catalog {
		t.Run(item.ID, func(t *testing.T) {
			b := fallbackPack(item.ID, 1000)
			tasks, ok := b["tasks"].([]map[string]any)
			if !ok || len(tasks) == 0 {
				t.Fatalf("no tasks")
			}
			for _, task := range tasks {
				if task["name"] == "" || task["prompt_template"] == "" {
					t.Errorf("empty task fields: %v", task)
				}
				if pc, ok := task["pass_condition"].(string); ok && strings.HasPrefix(pc, "{") && !json.Valid([]byte(pc)) {
					t.Errorf("invalid pass_condition JSON: %s", pc)
				}
			}
			one := fallbackPack(item.ID, 1)
			if n := len(one["tasks"].([]map[string]any)); n != 1 {
				t.Errorf("limit 1 produced %d tasks", n)
			}
		})
	}
}

func TestConvertersKeyFields(t *testing.T) {
	he, err := convertHumanEval([]any{map[string]any{
		"task_id": "HumanEval/0", "entry_point": " f ", "prompt": "def f():", "test": "assert f() <2 & 1", "canonical_solution": "  return 1\n",
	}}, 5)
	if err != nil {
		t.Fatal(err)
	}
	task := he["tasks"].([]map[string]any)[0]
	if task["name"] != "HumanEval/0 — f" {
		t.Errorf("name %q", task["name"])
	}
	wantPC := `{"mode":"code_presence","required":["f"],"sandbox":{"language":"python","source":"HumanEval","task_id":"HumanEval/0","entry_point":"f","tests":["assert f() <2 & 1"],"canonical_solution":"  return 1\n"}}`
	if task["pass_condition"] != wantPC {
		t.Errorf("pass_condition\n got %s\nwant %s", task["pass_condition"], wantPC)
	}
	if he["name"] != "HumanEval (1)" {
		t.Errorf("benchmark name %q", he["name"])
	}

	mb, _ := convertMbpp([]any{map[string]any{"task_id": float64(11), "text": "Write it", "test_list": []any{`assert remove_Occ("a","b") == ""`}}}, 5)
	mt := mb["tasks"].([]map[string]any)[0]
	if mt["name"] != "MBPP 11 — remove_Occ" {
		t.Errorf("mbpp name %q", mt["name"])
	}
	wantMB := `{"mode":"code_presence","required":["remove_Occ"],"sandbox":{"language":"python","source":"MBPP","task_id":11,"entry_point":"remove_Occ","tests":["assert remove_Occ(\"a\",\"b\") == \"\""],"test_setup_code":null,"reference_code":null}}`
	if mt["pass_condition"] != wantMB {
		t.Errorf("mbpp pass_condition\n got %s\nwant %s", mt["pass_condition"], wantMB)
	}

	gs, _ := convertGsm8k([]any{map[string]any{"question": "Q?", "answer": "x\n#### 1,000"}}, 5)
	gt := gs["tasks"].([]map[string]any)[0]
	if gt["name"] != "GSM8K 1 — 1000" || gt["pass_condition"] != "Poprawna odpowiedź to 1000." || gt["score_type"] != "boolean" {
		t.Errorf("gsm task %v", gt)
	}
	if !reflect.DeepEqual(gt["evaluation_checklist"], []string{"Odpowiedź końcowa zawiera 1000."}) {
		t.Errorf("gsm checklist %v", gt["evaluation_checklist"])
	}
}

func TestNetworkFailureFallsBack(t *testing.T) {
	f := &fakeFetcher{err: errors.New("dial tcp: no route")}
	for _, id := range []string{"humaneval", "mbpp", "gsm8k", "swebench-lite", "swebench-verified"} {
		res, err := DownloadPack(context.Background(), f, id, map[string]any{"limit": 2})
		if err != nil {
			t.Fatal(err)
		}
		if res["fromFallback"] != true || res["error"] != "dial tcp: no route" || res["ok"] != true {
			t.Errorf("%s: %v", id, res)
		}
		if n := len(res["benchmarks"].([]any)); n != 1 {
			t.Errorf("%s: %d benchmarks", id, n)
		}
	}
	// Curated packs never hit the network and are not marked as fallback.
	res, _ := DownloadPack(context.Background(), f, "bbh-mini", nil)
	if res["fromFallback"] != false {
		t.Errorf("bbh-mini should not be fallback: %v", res)
	}
	if _, has := res["error"]; has {
		t.Error("unexpected error key")
	}
}

func TestCancelledContextFallsBack(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err := DownloadPack(ctx, onlineFetcher(t), "gsm8k", nil)
	if err != nil {
		t.Fatal(err)
	}
	if res["fromFallback"] != true {
		t.Errorf("expected fallback on cancelled ctx")
	}
}

func TestUnknownPack(t *testing.T) {
	_, err := DownloadPack(context.Background(), &fakeFetcher{}, "nope", nil)
	if err == nil || err.Error() != "Unknown benchmark pack: nope" {
		t.Fatalf("got %v", err)
	}
}

func TestSafeLimit(t *testing.T) {
	cases := []struct {
		value         any
		fallback, max int
		want          int
	}{
		{undef, 40, 164, 40},
		{nil, 40, 164, 40},
		{float64(0), 40, 164, 40},
		{float64(-3), 40, 164, 40},
		{math.NaN(), 40, 164, 40},
		{math.Inf(1), 40, 164, 40},
		{float64(7.9), 40, 164, 7},
		{float64(1e9), 40, 164, 164},
		{"12", 40, 164, 12},
		{" 0x10 ", 40, 164, 16},
		{"abc", 40, 164, 40},
		{"", 40, 164, 40},
		{true, 40, 164, 1},
		{[]any{float64(5)}, 40, 164, 5},
		{5, 40, 0, 5},
		{float64(900), 40, 0, 500},
		{float64(0.5), 40, 164, 1},
		{undef, 1000, 6, 6},
	}
	for i, c := range cases {
		if got := safeLimit(c.value, c.fallback, c.max); got != c.want {
			t.Errorf("case %d safeLimit(%v,%d,%d)=%d want %d", i, c.value, c.fallback, c.max, got, c.want)
		}
	}
}

func TestJSNumberAndStringify(t *testing.T) {
	nums := map[float64]string{1: "1", -2.5: "-2.5", 1e21: "1e+21", 1e20: "100000000000000000000", 1e-7: "1e-7", 0.000001: "0.000001", 123.456: "123.456", 1.5e-10: "1.5e-10"}
	for f, want := range nums {
		if got := jsNumber(f); got != want {
			t.Errorf("jsNumber(%v)=%s want %s", f, got, want)
		}
	}
	got := stringify(obj{{"a", "<&>\u2028\x01\"\\"}, {"skip", undef}, {"n", []any{undef, nil, float64(2)}}})
	want := "{\"a\":\"<&>\u2028\\u0001\\\"\\\\\",\"n\":[null,null,2]}"
	if got != want {
		t.Errorf("stringify\n got %s\nwant %s", got, want)
	}
}

func TestGzipPassthrough(t *testing.T) {
	plain := []byte(`{"a":1}`)
	out, err := gunzip(plain)
	if err != nil || !bytes.Equal(out, plain) {
		t.Fatalf("passthrough failed: %v", err)
	}
	if _, err := gunzip([]byte{0x1f, 0x8b, 0, 0}); err == nil {
		t.Fatal("expected error for corrupt gzip")
	}
}
