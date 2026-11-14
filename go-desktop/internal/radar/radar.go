// Package radar is the Go port of electron/benchmarkRadar.cjs: it scans GitHub
// repositories for BenchForge beacons/manifests (benchforge.beacon,
// benchforge.json) and discovers repositories by GitHub topic.
//
// Only https URLs on github.com, www.github.com, raw.githubusercontent.com and
// api.github.com are ever fetched; redirects to other hosts are refused.
package radar

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTopic = "benchforge-pack"
	// MaxTextBytes caps any single downloaded manifest/benchmark file.
	MaxTextBytes   = 10 * 1024 * 1024
	cacheTTL       = 15 * time.Minute
	requestTimeout = 12 * time.Second
	maxCacheItems  = 512
	maxInputLength = 2048
	// maxRemoteEntries bounds how many benchmark files one manifest may pull.
	maxRemoteEntries = 200
	userAgent        = "BenchForge-Radar"
	acceptHeader     = "application/vnd.github+json, application/json, text/plain, */*"
)

var (
	defaultBeaconPaths   = []string{"benchforge.beacon", ".benchforge/benchforge.beacon", ".benchforge/beacon.json"}
	defaultManifestPaths = []string{"benchforge.json", ".benchforge/benchforge.json"}

	fetchHosts = map[string]bool{
		"github.com":                true,
		"www.github.com":            true,
		"raw.githubusercontent.com": true,
		"api.github.com":            true,
	}
)

// Fetcher performs a GET request. It returns the body and HTTP status; an
// error is returned only for transport failures or limit violations.
type Fetcher interface {
	Get(ctx context.Context, url string, headers map[string]string, maxBytes int64) ([]byte, int, error)
}

type httpFetcher struct {
	client *http.Client
}

// NewHTTPFetcher returns a Fetcher restricted to GitHub hosts. When client is
// nil a client with a 30s timeout is used. Redirects are only followed to the
// allowed GitHub hosts over https.
func NewHTTPFetcher(client *http.Client) Fetcher {
	var c http.Client
	if client != nil {
		c = *client
	} else {
		c.Timeout = 30 * time.Second
	}
	c.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if err := checkFetchURL(req.URL); err != nil {
			return fmt.Errorf("refusing redirect: %w", err)
		}
		return nil
	}
	return &httpFetcher{client: &c}
}

func (h *httpFetcher) Get(ctx context.Context, rawURL string, headers map[string]string, maxBytes int64) ([]byte, int, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, 0, err
	}
	if err := checkFetchURL(u); err != nil {
		return nil, 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, 0, err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, resp.StatusCode, nil
	}
	if maxBytes > 0 && resp.ContentLength > maxBytes {
		return nil, resp.StatusCode, fmt.Errorf("File too large (%d B). Limit: %d B.", resp.ContentLength, maxBytes)
	}
	reader := io.Reader(resp.Body)
	if maxBytes > 0 {
		reader = io.LimitReader(resp.Body, maxBytes+1)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	if maxBytes > 0 && int64(len(body)) > maxBytes {
		return nil, resp.StatusCode, fmt.Errorf("File too large (more than %d B). Limit: %d B.", maxBytes, maxBytes)
	}
	return body, resp.StatusCode, nil
}

// checkFetchURL allows only https requests to the GitHub hosts, without
// credentials or explicit ports.
func checkFetchURL(u *url.URL) error {
	if u == nil || !strings.EqualFold(u.Scheme, "https") {
		return errors.New("Radar may only fetch https:// URLs.")
	}
	if u.User != nil || u.Port() != "" {
		return errors.New("Radar refuses URLs with credentials or explicit ports.")
	}
	if !fetchHosts[strings.ToLower(u.Hostname())] {
		return fmt.Errorf("Radar may only fetch from GitHub hosts, not %s.", u.Hostname())
	}
	return nil
}

type cacheEntry struct {
	savedAt time.Time
	value   string
}

// Radar holds the shared 15-minute in-memory response cache.
type Radar struct {
	f     Fetcher
	mu    sync.Mutex
	cache map[string]cacheEntry
	now   func() time.Time
	env   func(string) string
}

// New creates a Radar using f (an HTTP fetcher when nil).
func New(f Fetcher) *Radar {
	if f == nil {
		f = NewHTTPFetcher(nil)
	}
	return &Radar{f: f, cache: map[string]cacheEntry{}, now: time.Now, env: os.Getenv}
}

func (r *Radar) getCached(key string, force bool) (string, bool) {
	if force {
		return "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.cache[key]
	if !ok {
		return "", false
	}
	if r.now().Sub(e.savedAt) > cacheTTL {
		delete(r.cache, key)
		return "", false
	}
	return e.value, true
}

func (r *Radar) setCached(key, value string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if len(r.cache) >= maxCacheItems {
		var oldestKey string
		var oldest time.Time
		for k, e := range r.cache {
			if now.Sub(e.savedAt) > cacheTTL {
				delete(r.cache, k)
				continue
			}
			if oldestKey == "" || e.savedAt.Before(oldest) {
				oldestKey, oldest = k, e.savedAt
			}
		}
		if len(r.cache) >= maxCacheItems && oldestKey != "" {
			delete(r.cache, oldestKey)
		}
	}
	r.cache[key] = cacheEntry{savedAt: now, value: value}
}

type options struct {
	token        string
	forceRefresh bool
}

func validToken(s string) bool {
	if len(s) > 1024 {
		return false
	}
	for _, c := range s {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	return true
}

func (r *Radar) resolveOptions(payload map[string]any, token string) options {
	candidates := []string{token}
	if s, ok := field(payload, "token").(string); ok {
		candidates = append(candidates, s)
	}
	if s, ok := field(payload, "githubToken").(string); ok {
		candidates = append(candidates, s)
	}
	candidates = append(candidates, r.env("GITHUB_TOKEN"), r.env("GH_TOKEN"))
	opts := options{forceRefresh: truthy(field(payload, "forceRefresh"))}
	for _, c := range candidates {
		c = strings.TrimSpace(c)
		if c != "" {
			if validToken(c) {
				opts.token = c
			}
			break
		}
	}
	return opts
}

func (r *Radar) fetchText(ctx context.Context, rawURL string, opts options) (string, error) {
	key := "text:" + rawURL
	if v, ok := r.getCached(key, opts.forceRefresh); ok {
		return v, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("Invalid URL: %s", rawURL)
	}
	if err := checkFetchURL(u); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	headers := map[string]string{"User-Agent": userAgent, "Accept": acceptHeader}
	if opts.token != "" {
		headers["Authorization"] = "Bearer " + opts.token
	}
	body, status, err := r.f.Get(ctx, rawURL, headers, MaxTextBytes)
	if err != nil {
		return "", err
	}
	if status < 200 || status > 299 {
		return "", fmt.Errorf("%d %s", status, http.StatusText(status))
	}
	if len(body) > MaxTextBytes {
		return "", fmt.Errorf("File too large (%d B). Limit: %d B.", len(body), MaxTextBytes)
	}
	text := strings.ToValidUTF8(string(bytes.TrimPrefix(body, []byte{0xEF, 0xBB, 0xBF})), "�")
	r.setCached(key, text)
	return text, nil
}

func (r *Radar) fetchJSON(ctx context.Context, rawURL string, opts options) (any, error) {
	text, err := r.fetchText(ctx, rawURL, opts)
	if err != nil {
		return nil, err
	}
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, err
	}
	return v, nil
}

// ---------------------------------------------------------------------------
// GitHub URL handling

var (
	safePathRe = regexp.MustCompile(`^[\w./@+\- ]+$`)
	ownerRe    = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`)
	repoRe     = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	sha256Re   = regexp.MustCompile(`^sha256[:=-]`)
)

func normalizePath(value string) string {
	return strings.ReplaceAll(strings.TrimLeft(value, "/"), `\`, "/")
}

func isSafeGithubPath(value string) bool {
	p := normalizePath(value)
	if p == "" || strings.Contains(p, "..") {
		return false
	}
	return safePathRe.MatchString(p)
}

func validRef(ref string) bool {
	if ref == "" || len(ref) > 255 || strings.Contains(ref, "..") || strings.HasPrefix(ref, "/") || strings.Contains(ref, `\`) {
		return false
	}
	for _, c := range ref {
		if c < 0x20 || c == 0x7f {
			return false
		}
	}
	return true
}

type ghURL struct {
	owner, repo, ref string
	hasRef           bool
	path             string
	raw              bool
	repoURL          string
}

func pathSegments(u *url.URL) ([]string, error) {
	var out []string
	for _, seg := range strings.Split(u.EscapedPath(), "/") {
		if seg == "" {
			continue
		}
		dec, err := url.PathUnescape(seg)
		if err != nil {
			return nil, fmt.Errorf("Invalid URL path: %v", err)
		}
		out = append(out, dec)
	}
	return out, nil
}

func parseGithubURL(input string) (ghURL, error) {
	value := jsTrim(input)
	if value == "" {
		return ghURL{}, errors.New("Podaj URL repozytorium GitHub albo raw URL.")
	}
	if len(value) > maxInputLength {
		return ghURL{}, errors.New("URL is too long.")
	}
	normalized := value
	if !strings.HasPrefix(value, "http") {
		normalized = "https://github.com/" + strings.TrimLeft(value, "/")
	}
	u, err := url.Parse(normalized)
	if err != nil || u.Host == "" {
		return ghURL{}, fmt.Errorf("Invalid URL: %s", value)
	}
	if u.Scheme != "https" {
		return ghURL{}, errors.New("Only https:// GitHub URLs are supported.")
	}
	if u.User != nil || u.Port() != "" {
		return ghURL{}, errors.New("GitHub URL must not contain credentials or a port.")
	}
	host := strings.ToLower(u.Hostname())
	segs, err := pathSegments(u)
	if err != nil {
		return ghURL{}, err
	}
	at := func(i int) string {
		if i < len(segs) {
			return segs[i]
		}
		return ""
	}
	rest := func(i int) string {
		if i < len(segs) {
			return strings.Join(segs[i:], "/")
		}
		return ""
	}

	var g ghURL
	switch host {
	case "raw.githubusercontent.com":
		g = ghURL{owner: at(0), repo: at(1), ref: at(2), hasRef: true, path: rest(3), raw: true}
		if g.owner == "" || g.repo == "" || g.ref == "" {
			return ghURL{}, errors.New("Niepoprawny raw.githubusercontent.com URL.")
		}
	case "github.com", "www.github.com":
		owner := at(0)
		repo := at(1)
		if len(repo) >= 4 && strings.EqualFold(repo[len(repo)-4:], ".git") {
			repo = repo[:len(repo)-4]
		}
		if owner == "" || repo == "" {
			return ghURL{}, errors.New("Niepoprawny URL repozytorium GitHub.")
		}
		g = ghURL{owner: owner, repo: repo}
		if mode := at(2); mode == "blob" || mode == "tree" {
			g.ref = at(3)
			g.hasRef = g.ref != ""
			g.path = rest(4)
			g.raw = mode == "blob"
		}
	default:
		return ghURL{}, errors.New("Radar currently supports only github.com.")
	}
	if !ownerRe.MatchString(g.owner) || !repoRe.MatchString(g.repo) || g.repo == "." || g.repo == ".." {
		return ghURL{}, errors.New("Niepoprawny URL repozytorium GitHub.")
	}
	if g.hasRef && !validRef(g.ref) {
		return ghURL{}, fmt.Errorf("Unsafe git ref: %s", g.ref)
	}
	g.repoURL = "https://github.com/" + g.owner + "/" + g.repo
	return g, nil
}

func rawURL(owner, repo, ref, filePath string) (string, error) {
	if !isSafeGithubPath(filePath) {
		return "", fmt.Errorf("Unsafe path in manifest: %s", filePath)
	}
	if !validRef(ref) {
		return "", fmt.Errorf("Unsafe git ref: %s", ref)
	}
	parts := strings.Split(normalizePath(filePath), "/")
	for i, p := range parts {
		parts[i] = encodeURIComponent(p)
	}
	encRef := strings.ReplaceAll(encodeURIComponent(ref), "%2F", "/")
	return "https://raw.githubusercontent.com/" + owner + "/" + repo + "/" + encRef + "/" + strings.Join(parts, "/"), nil
}

func (r *Radar) tryFetchRaw(ctx context.Context, owner, repo, ref, filePath string, opts options) (string, bool) {
	u, err := rawURL(owner, repo, ref, filePath)
	if err != nil {
		return "", false
	}
	text, err := r.fetchText(ctx, u, opts)
	if err != nil {
		return "", false
	}
	return text, true
}

// ---------------------------------------------------------------------------
// Manifest parsing / validation

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func normalizeSha256(value string) string {
	return sha256Re.ReplaceAllString(strings.ToLower(jsTrim(value)), "")
}

func verifyChecksum(text string, expected any, label string) error {
	normalized := normalizeSha256(jsString(or(expected, "")))
	if normalized == "" {
		return nil
	}
	if actual := sha256Hex(text); actual != normalized {
		return fmt.Errorf("Checksum mismatch for %s. Expected %s, got %s.", label, normalized, actual)
	}
	return nil
}

func parseMaybeJSON(text, label string) (any, error) {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, fmt.Errorf("Niepoprawny JSON w %s: %v", label, err)
	}
	return v, nil
}

func defaultBeacon() map[string]any {
	return map[string]any{"type": "benchforge-beacon", "manifest": "benchforge.json"}
}

func parseBeacon(text string) any {
	trimmed := jsTrim(text)
	if trimmed == "" {
		return defaultBeacon()
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err == nil {
		if isObject(parsed) {
			return parsed
		}
		return defaultBeacon()
	}
	for _, line := range strings.Split(trimmed, "\n") {
		line = jsTrim(line)
		if line != "" && !strings.HasPrefix(line, "#") {
			return map[string]any{"type": "benchforge-beacon", "manifest": line}
		}
	}
	return defaultBeacon()
}

func normalizeBenchmarkPayload(payload any) []any {
	switch p := payload.(type) {
	case []any:
		return p
	case map[string]any:
		if b, ok := p["benchmarks"].([]any); ok {
			return b
		}
		if truthy(field(p, "name")) || truthy(field(p, "prompt_template")) || truthy(field(p, "tasks")) {
			return []any{p}
		}
	}
	return []any{}
}

func validScoreType(v any) bool {
	switch x := v.(type) {
	case undefinedT, nil:
		return true
	case string:
		return x == "" || x == "numeric" || x == "boolean"
	}
	return false
}

func validOutputType(v any) bool {
	switch x := v.(type) {
	case undefinedT, nil:
		return true
	case string:
		if x == "" {
			return true
		}
	}
	switch jsString(v) {
	case "text", "markdown", "html", "svg", "maze":
		return true
	}
	return false
}

func validatePack(manifest map[string]any, benchmarks []any) map[string]any {
	errs := []string{}
	warnings := []string{}
	if t := field(manifest, "type"); truthy(t) && t != "benchforge-pack" {
		warnings = append(warnings, fmt.Sprintf("Manifest type is '%s', expected 'benchforge-pack'.", jsString(t)))
	}
	if !truthy(field(manifest, "name")) && !truthy(field(manifest, "title")) {
		warnings = append(warnings, "Manifest should include name/title.")
	}
	if !truthy(field(manifest, "version")) {
		warnings = append(warnings, "Manifest should include version for update checks.")
	}
	if len(benchmarks) == 0 {
		errs = append(errs, "Manifest must resolve to at least one benchmark.")
	}
	for index, benchmark := range benchmarks {
		label := fmt.Sprintf("benchmark[%d]", index)
		if !isObject(benchmark) {
			errs = append(errs, label+" is not an object.")
			continue
		}
		if jsTrim(jsString(or(field(benchmark, "name"), ""))) == "" {
			errs = append(errs, label+".name is required.")
		}
		if !validScoreType(field(benchmark, "score_type")) {
			errs = append(errs, label+".score_type must be numeric or boolean.")
		}
		if !validOutputType(field(benchmark, "output_type")) {
			errs = append(errs, label+".output_type is invalid.")
		}
		tasks, _ := field(benchmark, "tasks").([]any)
		hasPrompt := jsTrim(jsString(or(field(benchmark, "prompt_template"), ""))) != ""
		if !hasPrompt && len(tasks) == 0 {
			errs = append(errs, label+" must include prompt_template or non-empty tasks.")
		}
		if !truthy(field(benchmark, "category")) {
			warnings = append(warnings, label+".category is missing; BenchForge will default it during import.")
		}
		for taskIndex, task := range tasks {
			taskLabel := fmt.Sprintf("%s.tasks[%d]", label, taskIndex)
			if !isObject(task) {
				errs = append(errs, taskLabel+" is not an object.")
				continue
			}
			if jsTrim(jsString(or(field(task, "name"), ""))) == "" {
				warnings = append(warnings, taskLabel+".name is missing; BenchForge will generate a name during import.")
			}
			if jsTrim(jsString(or(field(task, "prompt_template"), field(task, "promptTemplate"), ""))) == "" {
				errs = append(errs, taskLabel+".prompt_template is required.")
			}
			if !validScoreType(field(task, "score_type")) {
				errs = append(errs, taskLabel+".score_type must be numeric or boolean.")
			}
			if !validOutputType(field(task, "output_type")) {
				errs = append(errs, taskLabel+".output_type is invalid.")
			}
		}
	}
	return map[string]any{"ok": len(errs) == 0, "errors": errs, "warnings": warnings}
}

type manifestContext struct {
	owner, repo, ref, manifestPath string
	checksums                      map[string]any
	opts                           options
	remoteLoads                    int
}

func (c *manifestContext) checksumFor(p string) any {
	return or(field(c.checksums, normalizePath(p)), field(c.checksums, p))
}

func resolveManifestURL(filePath string, c *manifestContext) (string, error) {
	value := jsTrim(filePath)
	if len(value) >= 8 && strings.EqualFold(value[:8], "https://") {
		u, err := url.Parse(value)
		if err != nil || u.Host == "" {
			return "", fmt.Errorf("Invalid URL: %s", value)
		}
		host := strings.ToLower(u.Hostname())
		if host != "raw.githubusercontent.com" && host != "github.com" && host != "www.github.com" {
			return "", errors.New("Manifest may download benchmarks only from GitHub/Raw GitHub.")
		}
		if u.User != nil || u.Port() != "" {
			return "", errors.New("Manifest may download benchmarks only from GitHub/Raw GitHub.")
		}
		if host == "raw.githubusercontent.com" {
			return value, nil
		}
		parsed, err := parseGithubURL(value)
		if err != nil {
			return "", err
		}
		if !parsed.raw || !parsed.hasRef || parsed.path == "" {
			return "", fmt.Errorf("GitHub link must point to a file: %s", value)
		}
		return rawURL(parsed.owner, parsed.repo, parsed.ref, parsed.path)
	}
	if !isSafeGithubPath(value) {
		return "", fmt.Errorf("Unsafe path in manifest: %s", value)
	}
	baseDir := ""
	if i := strings.LastIndex(c.manifestPath, "/"); i >= 0 {
		baseDir = c.manifestPath[:i]
	}
	relative := value
	if baseDir != "" {
		relative = baseDir + "/" + value
	}
	return rawURL(c.owner, c.repo, c.ref, normalizePath(relative))
}

func (r *Radar) loadRemote(ctx context.Context, filePath string, expected any, c *manifestContext) ([]any, error) {
	c.remoteLoads++
	if c.remoteLoads > maxRemoteEntries {
		return nil, fmt.Errorf("Manifest references too many benchmark files (limit %d).", maxRemoteEntries)
	}
	u, err := resolveManifestURL(filePath, c)
	if err != nil {
		return nil, err
	}
	text, err := r.fetchText(ctx, u, c.opts)
	if err != nil {
		return nil, err
	}
	if err := verifyChecksum(text, expected, filePath); err != nil {
		return nil, err
	}
	parsed, err := parseMaybeJSON(text, filePath)
	if err != nil {
		return nil, err
	}
	return normalizeBenchmarkPayload(parsed), nil
}

func (r *Radar) loadBenchmarkEntry(ctx context.Context, entry any, c *manifestContext) ([]any, error) {
	if s, ok := entry.(string); ok {
		return r.loadRemote(ctx, s, c.checksumFor(s), c)
	}
	if !isObject(entry) {
		return []any{}, nil
	}
	if b := field(entry, "benchmark"); truthy(b) && isObject(b) {
		return []any{b}, nil
	}
	if bs, ok := field(entry, "benchmarks").([]any); ok && !truthy(field(entry, "path")) && !truthy(field(entry, "source")) && !truthy(field(entry, "url")) {
		return bs, nil
	}
	filePath := or(field(entry, "path"), field(entry, "source"), field(entry, "file"), field(entry, "url"))
	if s, ok := filePath.(string); ok && jsTrim(s) != "" {
		expected := or(field(entry, "sha256"), field(entry, "checksum"), c.checksumFor(s))
		return r.loadRemote(ctx, s, expected, c)
	}
	if truthy(field(entry, "name")) || truthy(field(entry, "prompt_template")) || truthy(field(entry, "tasks")) {
		return []any{entry}, nil
	}
	return []any{}, nil
}

func (r *Radar) buildPackFromManifest(ctx context.Context, manifest any, manifestPath string, g ghURL, ref string, beaconPath any, opts options) (map[string]any, error) {
	var mo map[string]any
	switch m := manifest.(type) {
	case map[string]any:
		mo = m
	case []any:
		mo = map[string]any{"benchmarks": m}
	default:
		return nil, errors.New("Manifest must be a JSON object.")
	}
	checksums, _ := mo["checksums"].(map[string]any)
	if checksums == nil {
		checksums = map[string]any{}
	}
	c := &manifestContext{owner: g.owner, repo: g.repo, ref: ref, manifestPath: manifestPath, checksums: checksums, opts: opts}
	entries, _ := mo["benchmarks"].([]any)
	benchmarks := []any{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		loaded, err := r.loadBenchmarkEntry(ctx, entry, c)
		if err != nil {
			return nil, err
		}
		benchmarks = append(benchmarks, loaded...)
	}
	if len(benchmarks) == 0 && (truthy(field(mo, "name")) || truthy(field(mo, "prompt_template")) || truthy(field(mo, "tasks"))) {
		benchmarks = append(benchmarks, normalizeBenchmarkPayload(mo)...)
	}
	if len(benchmarks) == 0 {
		return nil, errors.New("Manifest does not contain any benchmarks to import.")
	}
	taskCount := 0
	for _, b := range benchmarks {
		if tasks, ok := field(b, "tasks").([]any); ok {
			taskCount += len(tasks)
		} else {
			taskCount++
		}
	}
	optStr := func(key string) any {
		if v := field(mo, key); truthy(v) {
			return jsString(v)
		}
		return nil
	}
	homepage := g.repoURL
	if v := field(mo, "homepage"); truthy(v) {
		homepage = jsString(v)
	}
	return map[string]any{
		"ok":             true,
		"id":             fmt.Sprintf("%s/%s#%s:%s", g.owner, g.repo, ref, manifestPath),
		"owner":          g.owner,
		"repo":           g.repo,
		"ref":            ref,
		"name":           jsString(or(field(mo, "name"), field(mo, "title"), g.owner+"/"+g.repo)),
		"description":    jsString(or(field(mo, "description"), "BenchForge beacon from "+g.owner+"/"+g.repo)),
		"version":        optStr("version"),
		"author":         optStr("author"),
		"license":        optStr("license"),
		"source":         g.owner + "/" + g.repo,
		"repoUrl":        g.repoURL,
		"homepage":       homepage,
		"manifestPath":   manifestPath,
		"beaconPath":     beaconPath,
		"benchmarks":     benchmarks,
		"benchmarkCount": len(benchmarks),
		"taskCount":      taskCount,
		"validation":     validatePack(mo, benchmarks),
		"cachedAt":       time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}, nil
}

// ---------------------------------------------------------------------------
// Public API

// Scan mirrors scanBenchmarkBeacon. payload: url (or repo/repository), forceRefresh.
func (r *Radar) Scan(ctx context.Context, payload map[string]any, token string) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	opts := r.resolveOptions(payload, token)
	return r.scan(ctx, payload, opts)
}

func (r *Radar) scan(ctx context.Context, payload map[string]any, opts options) (map[string]any, error) {
	input := or(field(payload, "url"), field(payload, "repo"), field(payload, "repository"))
	var inputStr string
	switch v := input.(type) {
	case string:
		inputStr = v
	case undefinedT, nil, bool, float64:
		if truthy(v) {
			return nil, errors.New("URL must be a string.")
		}
	default:
		return nil, errors.New("URL must be a string.")
	}
	g, err := parseGithubURL(inputStr)
	if err != nil {
		return nil, err
	}
	ref := g.ref
	if !g.hasRef {
		meta, err := r.fetchJSON(ctx, "https://api.github.com/repos/"+g.owner+"/"+g.repo, opts)
		if err != nil {
			return nil, err
		}
		ref = "main"
		if s, ok := field(meta, "default_branch").(string); ok && s != "" {
			ref = s
		}
		if !validRef(ref) {
			return nil, fmt.Errorf("Unsafe git ref: %s", ref)
		}
	}

	if g.raw && g.path != "" {
		u, err := rawURL(g.owner, g.repo, ref, g.path)
		if err != nil {
			return nil, err
		}
		text, err := r.fetchText(ctx, u, opts)
		if err != nil {
			return nil, err
		}
		manifest, err := parseMaybeJSON(text, g.path)
		if err != nil {
			return nil, err
		}
		return r.buildPackFromManifest(ctx, manifest, g.path, g, ref, nil, opts)
	}

	candidates := defaultBeaconPaths
	if g.path != "" {
		candidates = []string{normalizePath(g.path)}
	}
	var beacon any
	var beaconPath any
	for _, candidate := range candidates {
		text, ok := r.tryFetchRaw(ctx, g.owner, g.repo, ref, candidate, opts)
		if !ok {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			continue
		}
		beacon = parseBeacon(text)
		beaconPath = candidate
		break
	}

	var manifestCandidates []string
	if m := field(beacon, "manifest"); truthy(m) {
		manifestCandidates = append(manifestCandidates, normalizePath(jsString(m)))
	}
	manifestCandidates = append(manifestCandidates, defaultManifestPaths...)
	seen := map[string]bool{}
	for _, manifestPath := range manifestCandidates {
		if seen[manifestPath] {
			continue
		}
		seen[manifestPath] = true
		text, ok := r.tryFetchRaw(ctx, g.owner, g.repo, ref, manifestPath, opts)
		if !ok {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			continue
		}
		manifest, err := parseMaybeJSON(text, manifestPath)
		if err != nil {
			return nil, err
		}
		return r.buildPackFromManifest(ctx, manifest, manifestPath, g, ref, beaconPath, opts)
	}
	return nil, fmt.Errorf("No benchforge.beacon or benchforge.json found in %s/%s.", g.owner, g.repo)
}

// Discover mirrors discoverBenchmarkBeacons. payload: topic, limit, forceRefresh.
func (r *Radar) Discover(ctx context.Context, payload map[string]any, token string) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	opts := r.resolveOptions(payload, token)

	rawTopic := or(field(payload, "topic"), defaultTopic)
	topicStr, ok := rawTopic.(string)
	if !ok {
		return nil, errors.New("Topic must be a string.")
	}
	topic := jsTrim(topicStr)
	if len(topic) >= 6 && strings.EqualFold(topic[:6], "topic:") {
		topic = topic[6:]
	}
	if topic == "" {
		topic = defaultTopic
	}
	if len(topic) > 100 {
		return nil, errors.New("Topic is too long.")
	}

	limitNum := jsNumberOf(or(field(payload, "limit"), float64(12)))
	if math.IsNaN(limitNum) {
		limitNum = 12
	}
	limit := int(math.Max(1, math.Min(30, math.Floor(limitNum))))

	searchURL := "https://api.github.com/search/repositories?q=topic:" + encodeURIComponent(topic) + "&sort=updated&order=desc&per_page=" + strconv.Itoa(limit)
	search, err := r.fetchJSON(ctx, searchURL, opts)
	if err != nil {
		return nil, err
	}
	searchObj, ok := search.(map[string]any)
	if !ok {
		return nil, errors.New("Unexpected GitHub search response.")
	}
	items, _ := searchObj["items"].([]any)
	if len(items) > limit {
		items = items[:limit]
	}
	packs := []any{}
	errs := []any{}
	for _, repo := range items {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		fullName := field(repo, "full_name")
		if !truthy(fullName) {
			continue
		}
		name := jsString(fullName)
		pack, err := r.scan(ctx, map[string]any{"url": "https://github.com/" + name}, opts)
		if err != nil {
			errs = append(errs, map[string]any{"repo": name, "error": err.Error()})
			continue
		}
		packs = append(packs, pack)
	}

	var total any = len(packs)
	if tc := field(searchObj, "total_count"); truthy(tc) {
		n := jsNumberOf(tc)
		switch {
		case math.IsNaN(n) || math.IsInf(n, 0):
			total = nil
		case n == math.Trunc(n) && math.Abs(n) < 1<<53:
			total = int64(n)
		default:
			total = n
		}
	}
	return map[string]any{"ok": true, "topic": topic, "total": total, "packs": packs, "errors": errs}, nil
}
