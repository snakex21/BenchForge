// Package library is the Go port of electron/benchmarkLibrary.cjs: the
// built-in benchmark catalog plus downloaders/converters for public datasets
// (HumanEval, MBPP, GSM8K, SWE-bench family) with offline fallback packs.
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
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	humanEvalURL = "https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz"
	mbppURL      = "https://raw.githubusercontent.com/google-research/google-research/master/mbpp/mbpp.jsonl"
	gsm8kURL     = "https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl"
	hfRowsBase   = "https://datasets-server.huggingface.co/rows"

	userAgent = "BenchForge benchmark library"
	// MaxBodyBytes caps every downloaded body (and the decompressed HumanEval file).
	MaxBodyBytes = 64 << 20
	// requestTimeout bounds a single HTTP request made by the default fetcher.
	requestTimeout = 90 * time.Second
)

type swebenchDataset struct {
	dataset, config, split, name, suiteName string
}

var swebenchDatasets = map[string]swebenchDataset{
	"swebench-lite":         {"princeton-nlp/SWE-bench_Lite", "default", "test", "SWE-bench Lite", "SWE-bench Lite"},
	"swebench-full":         {"princeton-nlp/SWE-bench", "default", "test", "SWE-bench Full", "SWE-bench Full"},
	"swebench-verified":     {"princeton-nlp/SWE-bench_Verified", "default", "test", "SWE-bench Verified", "SWE-bench Verified"},
	"swebench-multilingual": {"SWE-bench/SWE-bench_Multilingual", "default", "test", "SWE-bench Multilingual", "SWE-bench Multilingual"},
	"swebench-multimodal":   {"SWE-bench/SWE-bench_Multimodal", "default", "test", "SWE-bench Multimodal", "SWE-bench Multimodal"},
}

// Fetcher downloads a URL. It returns the body for 2xx responses and an error otherwise.
type Fetcher interface {
	Get(ctx context.Context, url string) ([]byte, error)
}

type httpFetcher struct {
	client *http.Client
}

// NewHTTPFetcher returns a Fetcher backed by client (a client with a timeout is
// created when nil). Requests carry the "BenchForge benchmark library"
// User-Agent and bodies are limited to MaxBodyBytes.
func NewHTTPFetcher(client *http.Client) Fetcher {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return &httpFetcher{client: client}
}

func (h *httpFetcher) Get(ctx context.Context, rawURL string) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("invalid download URL: %s", rawURL)
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return nil, errors.New(resp.Status) // e.g. "404 Not Found", like `${status} ${statusText}`
	}
	if resp.ContentLength > MaxBodyBytes {
		return nil, fmt.Errorf("response too large (%d B). Limit: %d B", resp.ContentLength, MaxBodyBytes)
	}
	return readLimited(resp.Body, MaxBodyBytes)
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response too large. Limit: %d B", limit)
	}
	return body, nil
}

// decodeText mimics Response.text(): UTF-8 decoding with a leading BOM removed.
func decodeText(b []byte) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	return strings.ToValidUTF8(string(b), "�")
}

func parseJSONL(text string) ([]any, error) {
	records := []any{}
	for _, line := range strings.Split(text, "\n") {
		line = jsTrim(line)
		if line == "" {
			continue
		}
		var v any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			return nil, err
		}
		records = append(records, v)
	}
	return records, nil
}

// safeLimit mirrors safeLimit(value, fallback, max) from the JS module.
func safeLimit(value any, fallback, max int) int {
	numeric := jsNumberOf(value)
	limitCap := 500
	if max > 0 {
		limitCap = max
	}
	if math.IsNaN(numeric) || math.IsInf(numeric, 0) || numeric <= 0 {
		return maxInt(1, minInt(limitCap, fallback))
	}
	f := math.Min(float64(limitCap), math.Floor(numeric))
	return maxInt(1, int(f))
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func fetchHFRows(ctx context.Context, f Fetcher, ds swebenchDataset, limit int) ([]any, error) {
	rows := []any{}
	const batchSize = 100
	for offset := 0; offset < limit; offset += batchSize {
		length := minInt(batchSize, limit-offset)
		q := "dataset=" + url.QueryEscape(ds.dataset) +
			"&config=" + url.QueryEscape(ds.config) +
			"&split=" + url.QueryEscape(ds.split) +
			"&offset=" + strconv.Itoa(offset) +
			"&length=" + strconv.Itoa(length)
		body, err := f.Get(ctx, hfRowsBase+"?"+q)
		if err != nil {
			return nil, err
		}
		var payload any
		if err := json.Unmarshal([]byte(decodeText(body)), &payload); err != nil {
			return nil, err
		}
		batch, _ := field(payload, "rows").([]any)
		rows = append(rows, batch...)
		if len(batch) < length {
			break
		}
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("HuggingFace rows response is empty for %s", ds.dataset)
	}
	return rows, nil
}

func fetchJSONL(ctx context.Context, f Fetcher, u string) ([]any, error) {
	body, err := f.Get(ctx, u)
	if err != nil {
		return nil, err
	}
	return parseJSONL(decodeText(body))
}

func gunzip(b []byte) ([]byte, error) {
	// Tolerate a transport that already decompressed the payload.
	if len(b) < 2 || b[0] != 0x1f || b[1] != 0x8b {
		return b, nil
	}
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return readLimited(zr, MaxBodyBytes)
}

func downloadOnline(ctx context.Context, f Fetcher, id string, limit int, item enriched) (map[string]any, error) {
	switch id {
	case "humaneval":
		gz, err := f.Get(ctx, humanEvalURL)
		if err != nil {
			return nil, err
		}
		raw, err := gunzip(gz)
		if err != nil {
			return nil, err
		}
		records, err := parseJSONL(strings.ToValidUTF8(string(raw), "�"))
		if err != nil {
			return nil, err
		}
		return convertHumanEval(records, limit)
	case "mbpp":
		records, err := fetchJSONL(ctx, f, mbppURL)
		if err != nil {
			return nil, err
		}
		return convertMbpp(records, limit)
	case "gsm8k":
		records, err := fetchJSONL(ctx, f, gsm8kURL)
		if err != nil {
			return nil, err
		}
		return convertGsm8k(records, limit)
	}
	if ds, ok := swebenchDatasets[id]; ok {
		rows, err := fetchHFRows(ctx, f, ds, limit)
		if err != nil {
			return nil, err
		}
		category := "Kod"
		if id == "swebench-multimodal" {
			category = "Wizja"
		}
		return convertSwebenchRows(rows, limit, swebenchOptions{Name: ds.name, SuiteName: ds.suiteName, Category: category, Description: item.item.Description})
	}
	return fallbackPack(id, limit), nil
}

// DownloadPack mirrors downloadBenchmarkPack(id, options). options may carry
// "limit". Network/parse failures produce the built-in fallback pack with
// fromFallback=true and an "error" message; an unknown id returns an error.
func DownloadPack(ctx context.Context, f Fetcher, id string, options map[string]any) (map[string]any, error) {
	raw, ok := findCatalog(id)
	if !ok {
		return nil, fmt.Errorf("Unknown benchmark pack: %s", id)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if f == nil {
		f = NewHTTPFetcher(nil)
	}
	item := enrich(raw)
	var limitValue any = undef
	if options != nil {
		if v, present := options["limit"]; present {
			limitValue = v
		}
	}
	limit := safeLimit(limitValue,
		firstNonZero(item.recommendedLimit, item.defaultLimit, 50),
		firstNonZero(item.totalTasks, item.defaultLimit, 500))

	bench, err := downloadOnline(ctx, f, id, limit, item)
	if err != nil {
		return map[string]any{
			"ok":           true,
			"fromFallback": true,
			"pack":         item.toMap(),
			"error":        err.Error(),
			"benchmarks":   []any{fallbackPack(id, limit)},
		}, nil
	}
	return map[string]any{
		"ok":           true,
		"fromFallback": false,
		"pack":         item.toMap(),
		"benchmarks":   []any{bench},
	}, nil
}
