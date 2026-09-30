package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"time"
)

const snapshotVersion = "benchforge-readonly-snapshot-v1"

//go:embed web/* examples/synthetic.json
var assets embed.FS

type row map[string]any
type snapshot struct {
	Version         string `json:"version"`
	Label           string `json:"label"`
	SourceKind      string `json:"source_kind"`
	EvaluatorOrigin string `json:"evaluator_origin"`
	Models          []row  `json:"models"`
	Benchmarks      []row  `json:"benchmarks"`
	Tasks           []row  `json:"tasks"`
	Results         []row  `json:"results"`
	Runs            []row  `json:"runs"`
	hash            string
}

var fields = map[string][]string{
	"models":     strings.Fields("id name mode provider model_id active input_price_per_1m output_price_per_1m pricing_source pricing_model_id pricing_updated_at created_at"),
	"benchmarks": strings.Fields("id name category description suite_name prompt_template score_type expected_answer pass_condition evaluation_checklist evaluation_rubric attempts output_type created_at"),
	"tasks":      strings.Fields("id benchmark_id name prompt_template score_type expected_answer pass_condition evaluation_checklist evaluation_rubric attempts order_index output_type created_at"),
	"results":    strings.Fields("id model_id benchmark_id task_id run_session_id score notes attempt_number tokens_used input_tokens output_tokens estimated_cost_usd duration_ms run_at"),
	"runs":       strings.Fields("id name started_at finished_at status"),
}

func integer(value any) (int64, bool) {
	n, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	i, err := n.Int64()
	return i, err == nil && i > 0 && i <= 9007199254740991
}

var requiredFields = map[string][]string{
	"models":     strings.Fields("id name mode active created_at"),
	"benchmarks": strings.Fields("id name category prompt_template score_type attempts output_type created_at"),
	"tasks":      strings.Fields("id benchmark_id name prompt_template score_type attempts order_index output_type created_at"),
	"results":    strings.Fields("id model_id benchmark_id score attempt_number run_at"),
	"runs":       strings.Fields("id started_at status"),
}

func in(value string, choices ...string) bool {
	for _, choice := range choices {
		if value == choice {
			return true
		}
	}
	return false
}
func validateField(kind, key string, value any) bool {
	if value == nil {
		return true
	} // Required fields are checked separately.
	if kind == "models" && key == "model_id" {
		_, ok := value.(string)
		return ok
	}
	switch key {
	case "active":
		_, ok := value.(bool)
		return ok
	case "id", "benchmark_id", "model_id", "task_id", "run_session_id":
		_, ok := integer(value)
		return ok
	case "attempts", "attempt_number", "order_index", "tokens_used", "input_tokens", "output_tokens", "duration_ms":
		n, ok := value.(json.Number)
		if !ok {
			return false
		}
		v, err := n.Int64()
		minimum := int64(0)
		if key == "attempts" || key == "attempt_number" {
			minimum = 1
		}
		return err == nil && v >= minimum && v <= 9007199254740991
	case "input_price_per_1m", "output_price_per_1m", "estimated_cost_usd":
		n, ok := value.(json.Number)
		if !ok {
			return false
		}
		v, err := n.Float64()
		return err == nil && !math.IsInf(v, 0) && !math.IsNaN(v) && v >= 0
	case "evaluation_checklist":
		items, ok := value.([]any)
		if !ok {
			return false
		}
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return false
			}
		}
		return true
	case "evaluation_rubric":
		items, ok := value.([]any)
		if !ok {
			return false
		}
		for _, item := range items {
			r, ok := item.(map[string]any)
			if !ok {
				return false
			}
			label, ok := r["label"].(string)
			if !ok || label == "" {
				return false
			}
			if rawType, present := r["type"]; present {
				typ, ok := rawType.(string)
				if !ok || !in(typ, "checkbox", "scale", "auto_sandbox") {
					return false
				}
			}
			for k, v := range r {
				switch k {
				case "id", "label", "type", "description":
					if _, ok := v.(string); !ok {
						return false
					}
				case "points", "min", "max":
					n, ok := v.(json.Number)
					if !ok {
						return false
					}
					f, err := n.Float64()
					if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
						return false
					}
				default:
					return false
				}
			}
			if _, ok := r["points"]; !ok {
				return false
			}
		}
		return true
	default:
		v, ok := value.(string)
		if !ok {
			return false
		}
		switch key {
		case "mode":
			return in(v, "api", "manual")
		case "score_type":
			return in(v, "numeric", "boolean")
		case "output_type":
			return in(v, "text", "html", "svg", "markdown", "maze")
		default:
			return true
		}
	}
}
func projectRows(rows []row, kind string) ([]row, error) {
	out := make([]row, 0, len(rows))
	ids := map[int64]bool{}
	if len(rows) > 10000 {
		return nil, fmt.Errorf("too many %s", kind)
	}
	for _, input := range rows {
		id, ok := integer(input["id"])
		if !ok || ids[id] {
			return nil, fmt.Errorf("%s require unique positive safe integer IDs", kind)
		}
		ids[id] = true
		for _, key := range requiredFields[kind] {
			if input[key] == nil {
				return nil, fmt.Errorf("%s require non-null %s", kind, key)
			}
		}
		r := row{}
		for _, key := range fields[kind] {
			if value, ok := input[key]; ok {
				if !validateField(kind, key, value) {
					return nil, fmt.Errorf("invalid %s field type: %s", kind, key)
				}
				r[key] = value
			}
		}
		if kind == "models" || kind == "benchmarks" || kind == "tasks" {
			if name, ok := r["name"].(string); !ok || strings.TrimSpace(name) == "" {
				return nil, fmt.Errorf("%s require names", kind)
			}
		}
		if kind == "benchmarks" || kind == "tasks" {
			if r["score_type"] != "numeric" && r["score_type"] != "boolean" {
				return nil, fmt.Errorf("invalid %s score_type", kind)
			}
			if _, ok := r["prompt_template"].(string); !ok {
				return nil, fmt.Errorf("%s require prompt_template", kind)
			}
		}
		if kind == "results" {
			if _, ok := r["score"].(string); !ok {
				return nil, errors.New("historical result score must be a string")
			}
		}
		out = append(out, r)
	}
	return out, nil
}
func parseSnapshot(b []byte) (snapshot, error) {
	if len(b) > 16*1024*1024 {
		return snapshot{}, errors.New("snapshot exceeds 16 MiB")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	d.DisallowUnknownFields()
	var s snapshot
	if err := d.Decode(&s); err != nil {
		return s, errors.New("invalid snapshot JSON/schema")
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return s, errors.New("snapshot must contain one JSON object")
	}
	if s.Version != snapshotVersion || strings.TrimSpace(s.Label) == "" || strings.TrimSpace(s.EvaluatorOrigin) == "" || (s.SourceKind != "synthetic" && s.SourceKind != "copied-export") {
		return s, errors.New("snapshot requires supported version, label, source_kind and evaluator_origin")
	}
	if s.Models == nil || s.Benchmarks == nil || s.Tasks == nil || s.Results == nil || s.Runs == nil {
		return s, errors.New("all five snapshot collections must be explicit arrays; null or omitted is invalid")
	}
	groups := []struct {
		name string
		rows *[]row
	}{{"models", &s.Models}, {"benchmarks", &s.Benchmarks}, {"tasks", &s.Tasks}, {"results", &s.Results}, {"runs", &s.Runs}}
	for _, group := range groups {
		safe, err := projectRows(*group.rows, group.name)
		if err != nil {
			return s, err
		}
		*group.rows = safe
	}
	models := map[int64]bool{}
	benchmarks := map[int64]bool{}
	tasks := map[int64]int64{}
	for _, r := range s.Models {
		id, _ := integer(r["id"])
		models[id] = true
	}
	for _, r := range s.Benchmarks {
		id, _ := integer(r["id"])
		benchmarks[id] = true
	}
	for _, r := range s.Tasks {
		id, _ := integer(r["id"])
		b, ok := integer(r["benchmark_id"])
		if !ok || !benchmarks[b] {
			return s, errors.New("task references missing benchmark")
		}
		tasks[id] = b
	}
	for _, r := range s.Results {
		m, mok := integer(r["model_id"])
		b, bok := integer(r["benchmark_id"])
		if !mok || !bok || !models[m] || !benchmarks[b] {
			return s, errors.New("result references missing model or benchmark")
		}
		if r["task_id"] != nil {
			task, ok := integer(r["task_id"])
			if !ok || tasks[task] != b {
				return s, errors.New("result references missing or unrelated task")
			}
		}
	}
	sum := sha256.Sum256(b)
	s.hash = hex.EncodeToString(sum[:])
	return s, nil
}
func loadSnapshot(path string) (snapshot, error) {
	if path == "" {
		b, err := assets.ReadFile("examples/synthetic.json")
		if err != nil {
			return snapshot{}, err
		}
		return parseSnapshot(b)
	}
	f, err := os.Open(path)
	if err != nil {
		return snapshot{}, errors.New("cannot open the selected snapshot")
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 16*1024*1024+1))
	if err != nil {
		return snapshot{}, errors.New("cannot read the selected snapshot")
	}
	return parseSnapshot(b)
}
func jsonReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, status int, message string) {
	jsonReply(w, status, map[string]string{"error": message})
}
func handler(s snapshot, host string) http.Handler {
	web, _ := fs.Sub(assets, "web")
	files := http.FileServer(http.FS(web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Existing React charts use inline styles; scripts remain same-origin only.
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
		if r.Host != host {
			apiError(w, 403, "invalid Host")
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+host {
			apiError(w, 403, "cross-origin request rejected")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			apiError(w, 403, "read-only mode: all mutations are disabled")
			return
		}
		switch r.URL.Path {
		case "/api/readonly/meta":
			jsonReply(w, 200, map[string]any{"version": s.Version, "read_only": true, "label": s.Label, "source_kind": s.SourceKind, "evaluator_origin": s.EvaluatorOrigin, "snapshot_sha256": s.hash, "capabilities": []string{"models.read", "benchmarks.read", "tasks.read", "results.read", "runs.read", "statistics.view"}})
		case "/api/readonly/models":
			jsonReply(w, 200, s.Models)
		case "/api/readonly/benchmarks":
			jsonReply(w, 200, s.Benchmarks)
		case "/api/readonly/tasks":
			id, err := strconv.ParseInt(r.URL.Query().Get("benchmark_id"), 10, 64)
			if err != nil || id < 1 {
				apiError(w, 400, "positive benchmark_id required")
				return
			}
			out := []row{}
			found := false
			for _, b := range s.Benchmarks {
				bid, _ := integer(b["id"])
				if bid == id {
					found = true
					break
				}
			}
			if !found {
				apiError(w, 404, "benchmark not found")
				return
			}
			for _, t := range s.Tasks {
				b, _ := integer(t["benchmark_id"])
				if b == id {
					out = append(out, t)
				}
			}
			jsonReply(w, 200, out)
		case "/api/readonly/results":
			jsonReply(w, 200, s.Results)
		case "/api/readonly/runs":
			jsonReply(w, 200, s.Runs)
		default:
			if strings.HasPrefix(r.URL.Path, "/api/") {
				apiError(w, 404, "unsupported read-only capability")
				return
			}
			if r.URL.Path == "/" {
				r.URL.Path = "/readonly.html"
			}
			if strings.HasSuffix(r.URL.Path, "/") {
				http.NotFound(w, r)
				return
			}
			files.ServeHTTP(w, r)
		}
	})
}
func main() {
	address := flag.String("listen", "127.0.0.1:8788", "loopback listener")
	path := flag.String("snapshot", "", "optional copied JSON snapshot, never a SQLite DB; default is embedded synthetic data")
	flag.Parse()
	host, _, err := net.SplitHostPort(*address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("listen must be loopback IP:port")
	}
	s, err := loadSnapshot(*path)
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Handler: handler(s, listener.Addr().String()), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	log.Printf("BenchForge read-only snapshot: http://%s (%s)", listener.Addr(), s.SourceKind)
	if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Print(err)
	}
}
