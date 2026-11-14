package radar

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixture struct {
	Status int    `json:"status"`
	Body   string `json:"body"`
}

type call struct {
	url     string
	headers map[string]string
	hasDL   bool
}

type fakeFetcher struct {
	mu       sync.Mutex
	fixtures map[string]fixture
	calls    []call
	override func(url string) ([]byte, int, error)
}

func (f *fakeFetcher) Get(ctx context.Context, u string, headers map[string]string, maxBytes int64) ([]byte, int, error) {
	_, hasDL := ctx.Deadline()
	f.mu.Lock()
	f.calls = append(f.calls, call{url: u, headers: headers, hasDL: hasDL})
	f.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, 0, err
	}
	if f.override != nil {
		return f.override(u)
	}
	fx, ok := f.fixtures[u]
	if !ok {
		return []byte("Not Found"), 404, nil
	}
	return []byte(fx.Body), fx.Status, nil
}

func (f *fakeFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

type goldenScenario struct {
	Kind    string         `json:"kind"`
	Payload map[string]any `json:"payload"`
	Result  map[string]any `json:"result"`
	Error   *string        `json:"error"`
}

type goldenFile struct {
	Fixtures  map[string]fixture `json:"fixtures"`
	Scenarios []goldenScenario   `json:"scenarios"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "radar_golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func newTestRadar(f Fetcher) *Radar {
	r := New(f)
	r.env = func(string) string { return "" }
	return r
}

func normalizeResult(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	stripCachedAt(out)
	return out
}

func stripCachedAt(v any) {
	switch x := v.(type) {
	case map[string]any:
		delete(x, "cachedAt")
		for _, e := range x {
			stripCachedAt(e)
		}
	case []any:
		for _, e := range x {
			stripCachedAt(e)
		}
	}
}

func TestGoldenParityWithJS(t *testing.T) {
	g := loadGolden(t)
	if len(g.Scenarios) == 0 {
		t.Fatal("empty golden")
	}
	for i, sc := range g.Scenarios {
		name := fmt.Sprintf("%d_%s_%v", i, sc.Kind, sc.Payload)
		t.Run(name, func(t *testing.T) {
			r := newTestRadar(&fakeFetcher{fixtures: g.Fixtures})
			var res map[string]any
			var err error
			if sc.Kind == "scan" {
				res, err = r.Scan(context.Background(), sc.Payload, "")
			} else {
				res, err = r.Discover(context.Background(), sc.Payload, "")
			}
			if sc.Error != nil {
				if err == nil || err.Error() != *sc.Error {
					t.Fatalf("want error %q, got %v (res=%v)", *sc.Error, err, res)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got := normalizeResult(t, res)
			want := normalizeResult(t, sc.Result)
			if !reflect.DeepEqual(got, want) {
				gb, _ := json.MarshalIndent(got, "", " ")
				wb, _ := json.MarshalIndent(want, "", " ")
				t.Fatalf("mismatch\n go: %s\n js: %s", gb, wb)
			}
			if sc.Kind == "scan" {
				if _, ok := res["cachedAt"].(string); !ok {
					t.Error("cachedAt missing")
				}
			}
		})
	}
}

func TestParseGithubURL(t *testing.T) {
	valid := []struct {
		in                     string
		owner, repo, ref, path string
		hasRef, raw            bool
	}{
		{"acme/bench", "acme", "bench", "", "", false, false},
		{"/acme/bench/", "acme", "bench", "", "", false, false},
		{"https://github.com/acme/bench.GIT", "acme", "bench", "", "", false, false},
		{"https://WWW.GitHub.com/acme/bench", "acme", "bench", "", "", false, false},
		{"https://github.com/acme/bench/tree/dev/docs/x", "acme", "bench", "dev", "docs/x", true, false},
		{"https://github.com/acme/bench/blob/main/a b.json", "acme", "bench", "main", "a b.json", true, true},
		{"https://github.com/acme/bench/tree", "acme", "bench", "", "", false, false},
		{"https://github.com/acme/bench/issues/1", "acme", "bench", "", "", false, false},
		{"https://raw.githubusercontent.com/acme/bench/v1.2/x/y.json", "acme", "bench", "v1.2", "x/y.json", true, true},
		{"https://raw.githubusercontent.com/acme/bench/main", "acme", "bench", "main", "", true, true},
	}
	for _, c := range valid {
		g, err := parseGithubURL(c.in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", c.in, err)
			continue
		}
		if g.owner != c.owner || g.repo != c.repo || g.ref != c.ref || g.path != c.path || g.hasRef != c.hasRef || g.raw != c.raw {
			t.Errorf("%q: got %+v", c.in, g)
		}
		if g.repoURL != "https://github.com/"+c.owner+"/"+c.repo {
			t.Errorf("%q: repoURL %s", c.in, g.repoURL)
		}
	}

	invalid := []string{
		"",
		"   ",
		"http://github.com/acme/bench",
		"https://gitlab.com/acme/bench",
		"https://github.com.evil.com/acme/bench",
		"https://evil.com/github.com/acme/bench",
		"https://user:pw@github.com/acme/bench",
		"https://github.com:8443/acme/bench",
		"https://github.com/acme",
		"https://github.com/ac%2Fme/bench",
		"https://github.com/-acme/bench",
		"https://github.com/acme/..",
		"https://github.com/acme/be<nch",
		"https://raw.githubusercontent.com/acme/bench",
		"https://raw.githubusercontent.com/acme/bench/..%2F..%2Fx/file.json",
		"https://github.com/acme/bench/tree/a..b/x",
		"ftp://github.com/acme/bench",
		"https://" + strings.Repeat("a", 3000),
	}
	for _, in := range invalid {
		if g, err := parseGithubURL(in); err == nil {
			t.Errorf("%q: expected error, got %+v", in, g)
		}
	}
}

func TestSafeGithubPathAndRawURL(t *testing.T) {
	cases := map[string]bool{
		"benchforge.json":         true,
		"/packs/a.json":           true,
		`packs\win.json`:          true,
		"dir/@scope/a+b-c d.json": true,
		"../secret":               false,
		"a/../../b":               false,
		"a/..":                    false,
		"":                        false,
		"/":                       false,
		"a?b=c":                   false,
		"a#frag":                  false,
		"https://evil.com/x":      false,
		"a%2e%2e/b":               false,
		"zażółć.json":             false,
	}
	for p, want := range cases {
		if got := isSafeGithubPath(p); got != want {
			t.Errorf("isSafeGithubPath(%q)=%v want %v", p, got, want)
		}
	}
	u, err := rawURL("acme", "bench", "feature/x y", "dir/a b.json")
	if err != nil {
		t.Fatal(err)
	}
	if u != "https://raw.githubusercontent.com/acme/bench/feature/x%20y/dir/a%20b.json" {
		t.Errorf("rawURL=%s", u)
	}
	if _, err := rawURL("acme", "bench", "main", "../x"); err == nil || err.Error() != "Unsafe path in manifest: ../x" {
		t.Errorf("expected unsafe error, got %v", err)
	}
}

func TestResolveManifestURL(t *testing.T) {
	c := &manifestContext{owner: "acme", repo: "bench", ref: "main", manifestPath: "packs/benchforge.json"}
	cases := []struct {
		in, want, err string
	}{
		{"a.json", "https://raw.githubusercontent.com/acme/bench/main/packs/a.json", ""},
		{"https://raw.githubusercontent.com/o/r/main/x.json", "https://raw.githubusercontent.com/o/r/main/x.json", ""},
		{"https://github.com/o/r/blob/dev/x.json", "https://raw.githubusercontent.com/o/r/dev/x.json", ""},
		{"https://github.com/o/r/tree/dev/x", "", "GitHub link must point to a file: https://github.com/o/r/tree/dev/x"},
		{"https://evil.com/x.json", "", "Manifest may download benchmarks only from GitHub/Raw GitHub."},
		{"https://api.github.com/repos/o/r", "", "Manifest may download benchmarks only from GitHub/Raw GitHub."},
		{"https://raw.githubusercontent.com:444/o/r/main/x.json", "", "Manifest may download benchmarks only from GitHub/Raw GitHub."},
		{"http://raw.githubusercontent.com/o/r/main/x.json", "", "Unsafe path in manifest: http://raw.githubusercontent.com/o/r/main/x.json"},
		{"../x.json", "", "Unsafe path in manifest: ../x.json"},
	}
	for _, cs := range cases {
		got, err := resolveManifestURL(cs.in, c)
		if cs.err != "" {
			if err == nil || err.Error() != cs.err {
				t.Errorf("%q: want error %q got %v", cs.in, cs.err, err)
			}
			continue
		}
		if err != nil || got != cs.want {
			t.Errorf("%q: got %q, %v", cs.in, got, err)
		}
	}
}

func TestChecksum(t *testing.T) {
	text := `{"name":"x"}`
	sum := sha256Hex(text)
	for _, expected := range []any{sum, "sha256:" + sum, "SHA256-" + strings.ToUpper(sum), " sha256=" + sum + " ", nil, "", undef} {
		if err := verifyChecksum(text, expected, "x.json"); err != nil {
			t.Errorf("expected %v to verify: %v", expected, err)
		}
	}
	err := verifyChecksum(text+" ", sum, "x.json")
	want := fmt.Sprintf("Checksum mismatch for x.json. Expected %s, got %s.", sum, sha256Hex(text+" "))
	if err == nil || err.Error() != want {
		t.Errorf("got %v", err)
	}
}

func TestChecksumMismatchRejectsScan(t *testing.T) {
	bench := `{"name":"B","prompt_template":"p"}`
	f := &fakeFetcher{fixtures: map[string]fixture{
		"https://raw.githubusercontent.com/o/r/main/benchforge.json": {200, `{"name":"P","checksums":{"b.json":"sha256:` + strings.Repeat("ab", 32) + `"},"benchmarks":["b.json"]}`},
		"https://raw.githubusercontent.com/o/r/main/b.json":          {200, bench},
	}}
	_, err := newTestRadar(f).Scan(context.Background(), map[string]any{"url": "https://github.com/o/r/tree/main"}, "")
	if err == nil || !strings.HasPrefix(err.Error(), "Checksum mismatch for b.json.") {
		t.Fatalf("got %v", err)
	}
}

func TestManifestValidation(t *testing.T) {
	v := validatePack(map[string]any{"type": "benchforge-pack", "name": "x", "version": "1"}, []any{
		map[string]any{"name": " ", "score_type": "percent", "output_type": "pdf", "category": "Kod"},
		map[string]any{"name": "ok", "prompt_template": "p", "category": "Kod", "output_type": []any{"svg"}},
		nil,
	})
	errs := v["errors"].([]string)
	want := []string{
		"benchmark[0].name is required.",
		"benchmark[0].score_type must be numeric or boolean.",
		"benchmark[0].output_type is invalid.",
		"benchmark[0] must include prompt_template or non-empty tasks.",
		"benchmark[2] is not an object.",
	}
	if !reflect.DeepEqual(errs, want) || v["ok"] != false {
		t.Errorf("errors=%v", errs)
	}
	if w := v["warnings"].([]string); len(w) != 0 {
		t.Errorf("warnings=%v", w)
	}
	ok := validatePack(map[string]any{"name": "x", "version": "1"}, []any{map[string]any{"name": "a", "prompt_template": "p", "category": "c"}})
	if ok["ok"] != true || len(ok["errors"].([]string)) != 0 {
		t.Errorf("expected valid: %v", ok)
	}
}

func TestRejectsNonGithubHosts(t *testing.T) {
	f := &fakeFetcher{}
	r := newTestRadar(f)
	for _, u := range []string{"https://evil.com/x", "http://raw.githubusercontent.com/o/r/main/x", "https://raw.githubusercontent.com:8080/o/r/main/x", "https://u:p@api.github.com/x", "file:///etc/passwd"} {
		if _, err := r.fetchText(context.Background(), u, options{}); err == nil {
			t.Errorf("%s: expected rejection", u)
		}
	}
	if f.callCount() != 0 {
		t.Errorf("fetcher must not be called for rejected hosts")
	}

	hf := NewHTTPFetcher(nil).(*httpFetcher)
	if _, _, err := hf.Get(context.Background(), "https://example.com/", nil, 10); err == nil {
		t.Error("http fetcher must reject non-GitHub host")
	}
	evil, _ := url.Parse("https://evil.example/x")
	if err := hf.client.CheckRedirect(&http.Request{URL: evil}, []*http.Request{{}}); err == nil {
		t.Error("redirect to non-GitHub host must be refused")
	}
	good, _ := url.Parse("https://raw.githubusercontent.com/o/r/main/x")
	if err := hf.client.CheckRedirect(&http.Request{URL: good}, []*http.Request{{}}); err != nil {
		t.Errorf("redirect within GitHub refused: %v", err)
	}

	if _, err := r.Scan(context.Background(), map[string]any{"url": "https://bitbucket.org/o/r"}, ""); err == nil || err.Error() != "Radar currently supports only github.com." {
		t.Errorf("got %v", err)
	}
	if _, err := r.Scan(context.Background(), map[string]any{"url": 42.0}, ""); err == nil {
		t.Error("expected type error for numeric url")
	}
}

func TestSizeLimitAndTimeout(t *testing.T) {
	f := &fakeFetcher{override: func(string) ([]byte, int, error) {
		return make([]byte, MaxTextBytes+1), 200, nil
	}}
	r := newTestRadar(f)
	_, err := r.fetchText(context.Background(), "https://raw.githubusercontent.com/o/r/main/x", options{})
	if err == nil || !strings.HasPrefix(err.Error(), "File too large") {
		t.Fatalf("got %v", err)
	}
	if !f.calls[0].hasDL {
		t.Error("request context must carry a deadline")
	}
}

func TestCacheHitAndForceRefresh(t *testing.T) {
	g := loadGolden(t)
	f := &fakeFetcher{fixtures: g.Fixtures}
	r := newTestRadar(f)
	ctx := context.Background()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r.now = func() time.Time { return now }

	const metaURL = "https://api.github.com/repos/acme/plain"
	// hits returns successful (fixture-backed) fetches made since call index `from`;
	// 404 misses are never cached (same as the JS), so they are ignored here.
	hits := func(from int) []string {
		f.mu.Lock()
		defer f.mu.Unlock()
		var out []string
		for _, c := range f.calls[from:] {
			if fx, ok := f.fixtures[c.url]; ok && fx.Status == 200 {
				out = append(out, c.url)
			}
		}
		return out
	}
	scan := func(force bool) []string {
		from := f.callCount()
		if _, err := r.Scan(ctx, map[string]any{"url": "acme/plain", "forceRefresh": force}, ""); err != nil {
			t.Fatal(err)
		}
		return hits(from)
	}

	if first := scan(false); len(first) != 3 || first[0] != metaURL {
		t.Fatalf("first scan hits=%v", first)
	}
	if again := scan(false); len(again) != 0 {
		t.Errorf("cached scan refetched %v", again)
	}
	if forced := scan(true); len(forced) != 4 || forced[0] != metaURL {
		t.Errorf("forceRefresh should bypass the cache, hits=%v", forced)
	}
	now = now.Add(cacheTTL + time.Second)
	if expired := scan(false); len(expired) != 3 || expired[0] != metaURL {
		t.Errorf("expired cache should refetch, hits=%v", expired)
	}
}

func TestConcurrentScansShareCache(t *testing.T) {
	g := loadGolden(t)
	r := newTestRadar(&fakeFetcher{fixtures: g.Fixtures})
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			url := "acme/plain"
			if i%2 == 0 {
				url = "acme/bench"
			}
			if _, err := r.Scan(context.Background(), map[string]any{"url": url, "forceRefresh": i%3 == 0}, ""); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
}

func TestCacheBounded(t *testing.T) {
	r := newTestRadar(&fakeFetcher{})
	for i := 0; i < maxCacheItems*2; i++ {
		r.setCached(fmt.Sprintf("k%d", i), "v")
	}
	if len(r.cache) > maxCacheItems {
		t.Errorf("cache grew to %d", len(r.cache))
	}
}

func TestDiscover(t *testing.T) {
	g := loadGolden(t)
	f := &fakeFetcher{fixtures: g.Fixtures}
	r := newTestRadar(f)
	res, err := r.Discover(context.Background(), map[string]any{"limit": 5}, "")
	if err != nil {
		t.Fatal(err)
	}
	if res["topic"] != "benchforge-pack" || res["total"] != int64(42) {
		t.Errorf("topic/total: %v %v", res["topic"], res["total"])
	}
	packs := res["packs"].([]any)
	if len(packs) != 1 || packs[0].(map[string]any)["id"] != "acme/bench#trunk:packs/manifest.json" {
		t.Errorf("packs=%v", packs)
	}
	errs := res["errors"].([]any)
	var repos []string
	for _, e := range errs {
		repos = append(repos, e.(map[string]any)["repo"].(string))
	}
	sort.Strings(repos)
	if !reflect.DeepEqual(repos, []string{"acme/badsum", "acme/none"}) {
		t.Errorf("errors=%v", errs)
	}

	cases := []struct {
		payload map[string]any
		perPage string
	}{
		{map[string]any{"limit": 100.0}, "30"},
		{map[string]any{"limit": -4.0}, "1"},
		{map[string]any{"limit": "abc"}, "12"},
		{map[string]any{"limit": "7"}, "7"},
		{map[string]any{}, "12"},
	}
	for _, c := range cases {
		ff := &fakeFetcher{override: func(string) ([]byte, int, error) { return []byte(`{"total_count":0,"items":[]}`), 200, nil }}
		res, err := newTestRadar(ff).Discover(context.Background(), c.payload, "")
		if err != nil {
			t.Fatal(err)
		}
		u, _ := url.Parse(ff.calls[0].url)
		if u.Host != "api.github.com" || u.Query().Get("per_page") != c.perPage || u.Query().Get("q") != "topic:benchforge-pack" {
			t.Errorf("%v: url %s", c.payload, ff.calls[0].url)
		}
		if res["total"] != 0 {
			t.Errorf("total=%v", res["total"])
		}
	}
	if _, err := r.Discover(context.Background(), map[string]any{"topic": 5.0}, ""); err == nil {
		t.Error("expected error for non-string topic")
	}
	if _, err := r.Discover(context.Background(), map[string]any{"topic": strings.Repeat("x", 200)}, ""); err == nil {
		t.Error("expected error for long topic")
	}
}

func TestTokenHeaders(t *testing.T) {
	f := &fakeFetcher{override: func(string) ([]byte, int, error) { return []byte(`{"items":[]}`), 200, nil }}
	r := newTestRadar(f)
	if _, err := r.Discover(context.Background(), nil, "  tok123 "); err != nil {
		t.Fatal(err)
	}
	h := f.calls[0].headers
	if h["Authorization"] != "Bearer tok123" || h["User-Agent"] != "BenchForge-Radar" || !strings.Contains(h["Accept"], "application/vnd.github+json") {
		t.Errorf("headers=%v", h)
	}

	f2 := &fakeFetcher{override: f.override}
	r2 := New(f2)
	r2.env = func(k string) string {
		if k == "GH_TOKEN" {
			return "envtok"
		}
		return ""
	}
	if _, err := r2.Discover(context.Background(), map[string]any{"forceRefresh": true}, ""); err != nil {
		t.Fatal(err)
	}
	if f2.calls[0].headers["Authorization"] != "Bearer envtok" {
		t.Errorf("env token not used: %v", f2.calls[0].headers)
	}

	f3 := &fakeFetcher{override: f.override}
	if _, err := newTestRadar(f3).Discover(context.Background(), map[string]any{"forceRefresh": true}, "bad\r\ntoken"); err != nil {
		t.Fatal(err)
	}
	if _, has := f3.calls[0].headers["Authorization"]; has {
		t.Error("token with control characters must be dropped")
	}
}

func TestCancelledContext(t *testing.T) {
	g := loadGolden(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := newTestRadar(&fakeFetcher{fixtures: g.Fixtures}).Scan(ctx, map[string]any{"url": "https://github.com/acme/top/tree/v1"}, "")
	if err == nil {
		t.Fatal("expected error on cancelled context")
	}
}
