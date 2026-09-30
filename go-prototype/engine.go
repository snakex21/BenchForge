package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const Contract = "benchforge-text-v1"

type Task struct {
	ID       string `json:"id"`
	Prompt   string `json:"prompt"`
	Mode     string `json:"mode"`
	Expected string `json:"expected"`
}
type Suite struct {
	Version string `json:"version"`
	ID      string `json:"id"`
	Tasks   []Task `json:"tasks"`
}
type Settings struct {
	TimeoutMS   int     `json:"timeout_ms"`
	MaxTokens   int     `json:"max_tokens"`
	Temperature float64 `json:"temperature"`
}
type Request struct {
	Suite    Suite    `json:"suite"`
	Models   []string `json:"models"`
	Settings Settings `json:"settings"`
}
type Output struct {
	ActualModel       string `json:"actual_model,omitempty"`
	SystemFingerprint string `json:"system_fingerprint,omitempty"`
	Text              string `json:"text"`
	InputTokens       *int   `json:"input_tokens,omitempty"`
	OutputTokens      *int   `json:"output_tokens,omitempty"`
}
type Provider interface {
	Generate(context.Context, string, string, Settings) (Output, error)
}
type Result struct {
	TaskID     string `json:"task_id"`
	Model      string `json:"model"`
	State      string `json:"state"`
	Output     Output `json:"output"`
	DurationMS int64  `json:"duration_ms"`
	Error      string `json:"error,omitempty"`
}
type Summary struct {
	Model    string   `json:"model"`
	Planned  int      `json:"planned"`
	Passed   int      `json:"passed"`
	Failed   int      `json:"failed"`
	Errors   int      `json:"errors"`
	Complete bool     `json:"complete"`
	Score    *float64 `json:"score_percent"`
}
type Report struct {
	ProviderEndpoint string     `json:"provider_endpoint,omitempty"`
	ID               string     `json:"id"`
	Contract         string     `json:"contract"`
	SuiteHash        string     `json:"suite_hash"`
	Request          Request    `json:"request"`
	Provider         string     `json:"provider"`
	State            string     `json:"state"`
	Started          time.Time  `json:"started"`
	Finished         *time.Time `json:"finished,omitempty"`
	Results          []Result   `json:"results"`
	Summaries        []Summary  `json:"summaries"`
	Error            string     `json:"error,omitempty"`
}

func validate(req Request) error {
	if req.Suite.Version != Contract {
		return fmt.Errorf("unsupported suite contract: use %s; legacy benchmarks require explicit conversion", Contract)
	}
	if strings.TrimSpace(req.Suite.ID) == "" || len(req.Suite.Tasks) == 0 || len(req.Suite.Tasks) > 64 {
		return errors.New("suite requires ID and 1..64 tasks")
	}
	if len(req.Models) == 0 || len(req.Models) > 8 {
		return errors.New("select 1..8 models")
	}
	if req.Settings.TimeoutMS < 10 || req.Settings.TimeoutMS > 120000 || req.Settings.MaxTokens < 1 || req.Settings.MaxTokens > 8192 || req.Settings.Temperature < 0 || req.Settings.Temperature > 2 {
		return errors.New("invalid timeout, max_tokens, or temperature")
	}
	seen := map[string]bool{}
	for _, t := range req.Suite.Tasks {
		if strings.TrimSpace(t.ID) == "" || seen[t.ID] || strings.TrimSpace(t.Prompt) == "" || strings.TrimSpace(t.Expected) == "" || len(t.Prompt) > 65536 || len(t.Expected) > 65536 {
			return errors.New("tasks require unique IDs, prompt and expected answer (at most 64 KiB each)")
		}
		if t.Mode != "exact" && t.Mode != "contains" {
			return fmt.Errorf("unsupported evaluation mode %q", t.Mode)
		}
		seen[t.ID] = true
	}
	seen = map[string]bool{}
	for _, m := range req.Models {
		if strings.TrimSpace(m) == "" || seen[m] {
			return errors.New("models must be nonempty and unique")
		}
		seen[m] = true
	}
	return nil
}
func newReport(id string, req Request, provider string) Report {
	b, _ := json.Marshal(req.Suite)
	sum := sha256.Sum256(b)
	r := Report{ID: id, Contract: Contract, SuiteHash: hex.EncodeToString(sum[:]), Request: req, Provider: provider, State: "running", Started: time.Now().UTC()}
	// Sequential, task-major order. Rotate first model to avoid always warming the same model first.
	// The actual order is persisted. This is not a claim of statistical fairness on a tiny suite.
	for i, t := range req.Suite.Tasks {
		for j := range req.Models {
			m := req.Models[(i+j)%len(req.Models)]
			r.Results = append(r.Results, Result{TaskID: t.ID, Model: m, State: "queued"})
		}
	}
	summarize(&r)
	return r
}
func summarize(r *Report) {
	r.Summaries = nil
	for _, m := range r.Request.Models {
		s := Summary{Model: m, Planned: len(r.Request.Suite.Tasks)}
		for _, v := range r.Results {
			if v.Model != m {
				continue
			}
			switch v.State {
			case "passed":
				s.Passed++
			case "failed":
				s.Failed++
			case "error", "timeout":
				s.Errors++
			}
		}
		s.Complete = s.Passed+s.Failed == s.Planned
		if s.Complete {
			x := 100 * float64(s.Passed) / float64(s.Planned)
			s.Score = &x
		}
		r.Summaries = append(r.Summaries, s)
	}
}
func execute(ctx context.Context, r Report, p Provider, save func(Report) error) Report {
	finish := func(state string) Report {
		now := time.Now().UTC()
		r.Finished = &now
		r.State = state
		summarize(&r)
		if err := save(r); err != nil {
			r.State = "storage_error"
			r.Error = err.Error()
		}
		return r
	}
	for i := range r.Results {
		if ctx.Err() != nil {
			for j := i; j < len(r.Results); j++ {
				r.Results[j].State = "skipped"
			}
			return finish("cancelled")
		}
		t := r.Request.Suite.Tasks[i/len(r.Request.Models)]
		r.Results[i].State = "running"
		if err := save(r); err != nil {
			r.Error = err.Error()
			return finish("storage_error")
		}
		sub, cancel := context.WithTimeout(ctx, time.Duration(r.Request.Settings.TimeoutMS)*time.Millisecond)
		begin := time.Now()
		out, err := p.Generate(sub, r.Results[i].Model, t.Prompt, r.Request.Settings)
		elapsed := time.Since(begin).Milliseconds()
		subErr := sub.Err()
		cancel()
		result := &r.Results[i]
		result.Output = out
		result.DurationMS = elapsed
		switch {
		case ctx.Err() != nil:
			result.State = "cancelled"
			result.Error = "cancelled by user"
		case errors.Is(subErr, context.DeadlineExceeded):
			result.State = "timeout"
			result.Error = "provider request timed out"
		case err != nil:
			result.State = "error"
			result.Error = err.Error()
		default:
			text := strings.TrimSpace(out.Text)
			expected := strings.TrimSpace(t.Expected)
			passed := text != "" && (t.Mode == "exact" && text == expected || t.Mode == "contains" && strings.Contains(text, expected))
			result.State = "failed"
			if passed {
				result.State = "passed"
			}
		}
		summarize(&r)
		if err := save(r); err != nil {
			r.Error = err.Error()
			return finish("storage_error")
		}
	}
	if ctx.Err() != nil {
		return finish("cancelled")
	}
	for _, v := range r.Results {
		if v.State == "error" || v.State == "timeout" {
			return finish("completed_with_errors")
		}
	}
	return finish("completed")
}
