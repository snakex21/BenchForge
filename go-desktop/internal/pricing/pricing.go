// Package pricing ports electron/pricing.cjs (OpenRouter price cache).
package pricing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

const (
	ModelsURL          = "https://openrouter.ai/api/v1/models"
	cacheKey           = "pricing_openrouter_cache"
	updatedKey         = "pricing_openrouter_updated_at"
	autoRefreshKey     = "pricing_auto_refresh_enabled"
	intervalKey        = "pricing_refresh_interval_hours"
	defaultIntervalHrs = 24.0
)

var localProviders = map[string]bool{"lmstudio": true, "ollama": true, "vllm": true}

var providerPrefixes = map[string][]string{
	"openai": {"openai"}, "anthropic": {"anthropic"}, "google-gemini": {"google", "google-gemini"}, "deepseek": {"deepseek"},
	"qwen": {"qwen", "alibaba"}, "minimax": {"minimax"}, "moonshot": {"moonshotai", "moonshot", "kimi"}, "zhipuai": {"z-ai", "zhipuai", "glm"},
	"baidu": {"baidu"}, "xiaomi": {"xiaomi"}, "yi": {"01-ai", "yi"}, "openrouter": {}, "groq": {"groq"}, "together": {"meta-llama", "together"},
	"fireworks": {"fireworks"}, "mistral": {"mistralai", "mistral"}, "cohere": {"cohere"}, "perplexity": {"perplexity"}, "ai21": {"ai21"},
}

var sepRe = regexp.MustCompile(`[:_\s]+`)

// NormalizeID mirrors normalizeId.
func NormalizeID(v any) string {
	s := strings.ToLower(strings.TrimSpace(jsv.Str(v)))
	s = strings.TrimPrefix(s, "models/")
	return sepRe.ReplaceAllString(s, "-")
}

func candidates(model jsv.Obj) []string {
	id, name := NormalizeID(model["model_id"]), NormalizeID(model["name"])
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	add(id)
	add(name)
	provider := jsv.Str(model["provider"])
	for _, p := range providerPrefixes[provider] {
		if id != "" {
			add(p + "/" + id)
		}
		if name != "" {
			add(p + "/" + name)
		}
	}
	return out
}

// Find mirrors findPricingForModel.
func Find(model jsv.Obj, pricing []jsv.Obj) jsv.Obj {
	cands := candidates(model)
	if len(cands) == 0 {
		return nil
	}
	byID := map[string]jsv.Obj{}
	for _, p := range pricing {
		k := NormalizeID(p["id"])
		if _, ok := byID[k]; !ok {
			byID[k] = p
		}
	}
	for _, c := range cands {
		if p, ok := byID[c]; ok {
			return p
		}
	}
	id := NormalizeID(model["model_id"])
	if id == "" {
		return nil
	}
	for _, p := range pricing {
		if strings.HasSuffix(NormalizeID(p["id"]), "/"+id) {
			return p
		}
	}
	return nil
}

func parseModel(item jsv.Obj) jsv.Obj {
	pr := jsv.AsObj(item["pricing"])
	prompt, completion := math.NaN(), math.NaN()
	if pr != nil && pr["prompt"] != nil {
		prompt = jsv.Number(pr["prompt"])
	}
	if pr != nil && pr["completion"] != nil {
		completion = jsv.Number(pr["completion"])
	}
	fin := func(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }
	if !fin(prompt) && !fin(completion) {
		return nil
	}
	var in, out any
	if fin(prompt) {
		in = jsv.ToFixed(prompt*1_000_000, 8)
	}
	if fin(completion) {
		out = jsv.ToFixed(completion*1_000_000, 8)
	}
	return jsv.Obj{"id": item["id"], "name": jsv.Or(item["name"], item["id"]), "input_price_per_1m": in, "output_price_per_1m": out, "context_length": jsv.Or(item["context_length"], nil)}
}

// Service owns pricing refreshes.
type Service struct {
	Store  *db.Store
	Client *http.Client
	URL    string
}

func New(store *db.Store) *Service {
	return &Service{Store: store, Client: &http.Client{Timeout: 30 * time.Second}, URL: ModelsURL}
}

func (s *Service) fetch(ctx context.Context) ([]jsv.Obj, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.URL, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", "BenchForge pricing refresh")
	resp, err := s.Client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, "", fmt.Errorf("%d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	var payload jsv.Obj
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&payload); err != nil {
		return nil, "", err
	}
	var models []jsv.Obj
	for _, item := range jsv.AsArr(payload["data"]) {
		if m := parseModel(jsv.AsObj(item)); m != nil {
			models = append(models, m)
		}
	}
	if len(models) == 0 {
		return nil, "", errors.New("OpenRouter pricing response contains no models")
	}
	updated := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if err := s.Store.SavePreference(cacheKey, models); err != nil {
		return nil, "", err
	}
	if err := s.Store.SavePreference(updatedKey, updated); err != nil {
		return nil, "", err
	}
	return models, updated, nil
}

func (s *Service) cached() ([]jsv.Obj, any) {
	var out []jsv.Obj
	for _, m := range jsv.AsArr(s.Store.Pref(cacheKey)) {
		if o := jsv.AsObj(m); o != nil {
			out = append(out, o)
		}
	}
	upd := s.Store.Pref(updatedKey)
	if _, ok := upd.(string); !ok {
		upd = nil
	}
	return out, upd
}

func (s *Service) apply(pricing []jsv.Obj, updated string) (int, int, error) {
	models, err := s.Store.GetModels()
	if err != nil {
		return 0, 0, err
	}
	matched := 0
	for _, m := range models {
		if m["mode"] != "api" || localProviders[jsv.Str(m["provider"])] {
			continue
		}
		p := Find(m, pricing)
		if p == nil {
			continue
		}
		if _, err := s.Store.UpdateModel(m["id"], jsv.Obj{"input_price_per_1m": p["input_price_per_1m"], "output_price_per_1m": p["output_price_per_1m"],
			"pricing_source": "openrouter", "pricing_model_id": p["id"], "pricing_updated_at": updated}); err != nil {
			return 0, 0, err
		}
		matched++
	}
	return matched, len(models), nil
}

// Refresh mirrors refreshOpenRouterPricing({apply:true}).
func (s *Service) Refresh(ctx context.Context) (jsv.Obj, error) {
	models, updated, err := s.fetch(ctx)
	if err != nil {
		return nil, err
	}
	matched, total, err := s.apply(models, updated)
	if err != nil {
		return nil, err
	}
	return jsv.Obj{"ok": true, "source": "openrouter", "updatedAt": updated, "modelCount": len(models), "matched": matched, "totalModels": total}, nil
}

func (s *Service) intervalHours() float64 {
	v := jsv.Number(jsv.Or(s.Store.Pref(intervalKey), defaultIntervalHrs))
	if math.IsNaN(v) {
		return defaultIntervalHrs
	}
	return v
}

// RefreshIfStale mirrors refreshOpenRouterPricingIfStale.
func (s *Service) RefreshIfStale(ctx context.Context) (jsv.Obj, error) {
	if s.Store.Pref(autoRefreshKey) == false {
		return jsv.Obj{"skipped": true, "reason": "disabled"}, nil
	}
	_, upd := s.cached()
	if u, ok := upd.(string); ok {
		if t, err := time.Parse(time.RFC3339, u); err == nil && time.Since(t) < time.Duration(math.Max(1, s.intervalHours())*float64(time.Hour)) {
			return jsv.Obj{"skipped": true, "reason": "fresh", "updatedAt": u}, nil
		}
	}
	return s.Refresh(ctx)
}

// Status mirrors getPricingStatus.
func (s *Service) Status() jsv.Obj {
	models, upd := s.cached()
	return jsv.Obj{"source": "openrouter", "modelCount": len(models), "updatedAt": upd, "autoRefresh": s.Store.Pref(autoRefreshKey) != false, "intervalHours": s.intervalHours()}
}
