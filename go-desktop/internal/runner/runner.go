// Package runner ports electron/runner.cjs: single-shot and streaming
// benchmark runs, retries with attempt penalty, aggregation, run sessions,
// manual batch submission, sandbox and tool-agent evaluation.
package runner

import (
	"context"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/providers"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
	"github.com/snakex21/benchforge/go-desktop/internal/toolagent"
)

type Obj = jsv.Obj

// Runner holds the dependencies of a benchmark run.
type Runner struct {
	Store    *db.Store
	Runtime  *sandbox.Runtime
	Policy   func() sandbox.Policy
	Provider func(mode string) (providers.Provider, error)
}

type evalOptions struct {
	repoRoots any
	policy    sandbox.Policy
}

func (r *Runner) evalOpts() evalOptions {
	return evalOptions{repoRoots: r.Store.Pref("repo_sandbox_roots"), policy: r.Policy()}
}

func (r *Runner) provider(mode any) (providers.Provider, error) {
	if r.Provider != nil {
		return r.Provider(jsv.Str(mode))
	}
	return providers.Get(jsv.Str(mode))
}

// EvaluateScore mirrors evaluateScore.
func (r *Runner) EvaluateScore(ctx context.Context, b Obj, response string, opts evalOptions) *Evaluation {
	if b["output_type"] == "maze" {
		return &Evaluation{NeedsVerify: true}
	}
	if strings.TrimSpace(response) == "" {
		return &Evaluation{Score: 0.0, Error: "The model finished generation without a response."}
	}
	if sb := r.EvaluateSandbox(ctx, b, response, opts); sb != nil {
		return sb
	}
	if cp := EvaluateCodePresence(b, response); cp != nil {
		return cp
	}
	if ot := jsv.Str(b["output_type"]); ot != "" && ot != "text" {
		return &Evaluation{IsManual: true}
	}
	if b["score_type"] == "boolean" {
		if s := EvaluateBoolean(b, response); s != "" {
			return &Evaluation{Score: s}
		}
		return &Evaluation{Error: "Could not evaluate the model response for a boolean benchmark."}
	}
	if v, ok := EvaluateNumeric(response); ok {
		return &Evaluation{Score: v}
	}
	return &Evaluation{Error: "Could not read a numeric score from the model response."}
}

func (r *Runner) runnableTasks(benchmarkID any, b Obj) ([]Obj, error) {
	tasks, err := r.Store.GetTasks(benchmarkID)
	if err != nil {
		return nil, err
	}
	var out []Obj
	for _, t := range tasks {
		if !IsStaleLegacyTask(t, b, len(tasks)) {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		pseudo := Obj{}
		for k, v := range b {
			pseudo[k] = v
		}
		pseudo["id"], pseudo["benchmark_id"], pseudo["name"], pseudo["order_index"] = nil, benchmarkID, b["name"], 0
		out = []Obj{pseudo}
	}
	return out, nil
}

func taskTitle(tasks []Obj, id any, index int) string {
	for _, t := range tasks {
		if t["id"] != nil && jsv.Number(t["id"]) == jsv.Number(id) && id != nil {
			if n := jsv.Str(t["name"]); n != "" {
				return n
			}
		}
	}
	return "Zadanie " + jsv.FormatNumber(float64(index+1))
}

func scoreLabel(v any) string {
	if v == nil {
		return "—"
	}
	return jsv.String(v)
}

func buildNotes(results []Obj, tasks []Obj) string {
	if len(results) == 1 {
		return jsv.Str(results[0]["response"])
	}
	parts := make([]string, len(results))
	for i, res := range results {
		parts[i] = "## " + jsv.FormatNumber(float64(i+1)) + ". " + taskTitle(tasks, res["task_id"], i) + "\nWynik: " + scoreLabel(res["score"]) + "\n\n" + jsv.Str(res["response"])
	}
	return strings.Join(parts, "\n\n---\n\n")
}

func buildThinking(results []Obj, tasks []Obj) any {
	var with []Obj
	for _, res := range results {
		if strings.TrimSpace(jsv.Str(res["thinking"])) != "" {
			with = append(with, res)
		}
	}
	if len(with) == 0 {
		return nil
	}
	if len(results) == 1 {
		return jsv.Or(with[0]["thinking"], nil)
	}
	parts := make([]string, len(results))
	for i, res := range results {
		th := jsv.Str(res["thinking"])
		if th == "" {
			th = "_No saved thinking._"
		}
		parts[i] = "## " + jsv.FormatNumber(float64(i+1)) + ". " + taskTitle(tasks, res["task_id"], i) + "\n\n" + th
	}
	return strings.Join(parts, "\n\n---\n\n")
}

func sandboxNote(ev *Evaluation) string {
	if ev == nil || ev.Sandbox == nil {
		return ""
	}
	return "## Sandbox evaluation\n\n```json\n" + jsv.JSONIndent(ev.Sandbox) + "\n```"
}

func scoresOf(results []Obj) []any {
	out := make([]any, len(results))
	for i, r := range results {
		out[i] = r["score"]
	}
	return out
}

func errOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func attemptsOf(o Obj) int {
	a := jsv.Number(jsv.Or(o["attempts"], 1.0))
	if math.IsNaN(a) || a < 1 {
		return 1
	}
	if a > 100 {
		return 100
	}
	return int(a)
}

func imageFor(o Obj) string {
	if o["output_type"] == "maze" {
		return jsv.Str(o["reference_image"])
	}
	return ""
}

// RunBenchmark mirrors runBenchmark (non-streaming single prompt).
func (r *Runner) RunBenchmark(ctx context.Context, modelID, benchmarkID any) (Obj, error) {
	empty := func(msg string) Obj {
		return Obj{"results": []any{}, "summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "error": msg}
	}
	model, err := r.Store.GetEffectiveModelConfig(modelID)
	if err != nil {
		return nil, err
	}
	if model == nil {
		return empty("Model was not found."), nil
	}
	b, err := r.Store.GetBenchmarkByID(benchmarkID)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return empty("Benchmark was not found."), nil
	}
	if strings.TrimSpace(jsv.Str(b["prompt_template"])) == "" {
		return empty("Benchmark has no prompt_template"), nil
	}
	p, err := r.provider(model["mode"])
	if err != nil {
		return nil, err
	}
	opts := r.evalOpts()
	attempts := attemptsOf(b)
	for attempt := 1; attempt <= attempts; attempt++ {
		start := time.Now()
		res, err := p.SendPrompt(ctx, model, jsv.Str(b["prompt_template"]), imageFor(b))
		if err != nil {
			return nil, err
		}
		dur := time.Since(start).Milliseconds()
		if res.Response == providers.ManualResponse {
			return Obj{"results": []any{Obj{"benchmark_id": benchmarkID, "score": nil, "response": nil, "is_manual": true, "error": nil, "attempt_number": attempt}},
				"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "error": nil}, nil
		}
		ev := r.EvaluateScore(ctx, b, res.Response, opts)
		if ev.IsManual || ev.NeedsVerify {
			return Obj{"results": []any{Obj{"benchmark_id": benchmarkID, "score": nil, "response": res.Response, "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "duration_ms": dur, "is_manual": true, "needs_verify": ev.NeedsVerify, "error": nil, "attempt_number": attempt}},
				"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "error": nil}, nil
		}
		if ev.Error != "" && attempt < attempts {
			continue
		}
		sv := ev.Score
		if sv == nil {
			sv = 0.0
		}
		score := NormalizeBenchmarkScore(b, sv, attempt, attempts)
		var thinking any
		if n := sandboxNote(ev); n != "" {
			thinking = n
		}
		created, err := r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "score": score, "notes": res.Response, "thinking_notes": thinking, "attempt_number": float64(attempt), "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "duration_ms": float64(dur)})
		if err != nil {
			return nil, err
		}
		avg := jsv.Number(score)
		if math.IsNaN(avg) {
			avg = 0
		}
		return Obj{"results": []any{Obj{"benchmark_id": benchmarkID, "result_id": created["id"], "score": jsv.String(score), "response": res.Response, "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "estimated_cost_usd": created["estimated_cost_usd"], "duration_ms": dur, "is_manual": false, "error": nil, "attempt_number": attempt}},
			"summary": Obj{"total": 1, "completed": 1, "avgScore": avg}, "error": nil}, nil
	}
	return empty("Could not start the benchmark."), nil
}

// RunStreaming mirrors runBenchmarkStreaming. send delivers UI events.
func (r *Runner) RunStreaming(ctx context.Context, modelID, benchmarkID any, send func(string, Obj), sessionID any, taskIDs []any) Obj {
	fail := func(msg string) Obj {
		return Obj{"results": []any{}, "summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "error": msg}
	}
	model, err1 := r.Store.GetEffectiveModelConfig(modelID)
	b, err2 := r.Store.GetBenchmarkByID(benchmarkID)
	if err := errors.Join(err1, err2); err != nil {
		send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": err.Error()})
		return fail(err.Error())
	}
	if model == nil || b == nil {
		msg := "Benchmark was not found."
		if model == nil {
			msg = "Model was not found."
		}
		send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": msg})
		return fail(msg)
	}
	requested := map[float64]bool{}
	for _, id := range taskIDs {
		requested[jsv.Number(id)] = true
	}
	all, err := r.runnableTasks(benchmarkID, b)
	if err != nil {
		send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": err.Error()})
		return fail(err.Error())
	}
	var tasks []Obj
	for _, t := range all {
		if len(requested) == 0 || requested[jsv.Number(t["id"])] {
			tasks = append(tasks, t)
		}
	}
	for _, t := range tasks {
		if strings.TrimSpace(jsv.Str(t["prompt_template"])) == "" {
			msg := "Benchmark has no prompt_template"
			send("task:error", Obj{"benchmarkId": benchmarkID, "error": msg})
			send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": msg})
			return fail(msg)
		}
	}

	var existing Obj
	if jsv.Truthy(sessionID) {
		existing, _ = r.Store.GetRunSession(sessionID)
	}
	session := existing
	if session == nil {
		session, err = r.Store.CreateRunSession(Obj{"model_id": modelID, "benchmark_ids": []any{benchmarkID}, "current_benchmark_id": benchmarkID, "completed_task_ids": []any{}})
		if err != nil {
			send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": err.Error()})
			return fail(err.Error())
		}
	}
	sid := session["id"]

	out, runErr := r.streamTasks(ctx, model, b, modelID, benchmarkID, tasks, existing, session, send)
	if runErr == nil {
		return out
	}
	msg := runErr.Error()
	if ctx.Err() != nil {
		msg = providers.CancelledMessage
		_, _ = r.Store.CancelRunSession(sid)
		send("benchmark:aborted", Obj{})
	} else {
		_, _ = r.Store.CancelRunSession(sid)
		send("task:error", Obj{"benchmarkId": benchmarkID, "error": msg})
		send("benchmark:done", Obj{"summary": Obj{"total": 1, "completed": 0, "avgScore": nil}, "results": []any{}, "error": msg})
	}
	return fail(msg)
}

func (r *Runner) streamTasks(ctx context.Context, model, b Obj, modelID, benchmarkID any, tasks []Obj, existing, session Obj, send func(string, Obj)) (Obj, error) {
	sid := session["id"]
	if ctx.Err() != nil {
		return nil, errors.New(providers.CancelledMessage)
	}
	if _, err := r.Store.UpdateRunSession(sid, Obj{"current_benchmark_id": benchmarkID, "current_task_id": nil, "status": "running"}); err != nil {
		return nil, err
	}
	p, err := r.provider(model["mode"])
	if err != nil {
		return nil, err
	}
	opts := r.evalOpts()
	startedAt := jsv.Str(session["started_at"])

	var results []Obj
	completedIDs := []any{}
	completedSet := map[float64]bool{}
	if existing != nil {
		seen := map[float64]bool{}
		for _, id := range jsv.AsArr(existing["completed_task_ids"]) {
			n := jsv.Number(id)
			inRun := false
			for _, t := range tasks {
				if t["id"] != nil && jsv.Number(t["id"]) == n {
					inRun = true
				}
			}
			if !inRun || seen[n] {
				continue
			}
			seen[n] = true
			saved, err := r.Store.GetLatestTaskResult(modelID, benchmarkID, id, startedAt)
			if err != nil {
				return nil, err
			}
			if saved == nil {
				continue
			}
			results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": id, "result_id": saved["id"], "score": jsv.String(saved["score"]), "response": saved["notes"], "thinking": saved["thinking_notes"], "tokens_used": saved["tokens_used"], "duration_ms": saved["duration_ms"], "is_manual": false, "error": nil, "attempt_number": jsv.Or(saved["attempt_number"], 1), "restored": true})
			completedIDs = append(completedIDs, id)
			completedSet[n] = true
		}
	}
	markDone := func(t Obj) error {
		if t["id"] != nil && !completedSet[jsv.Number(t["id"])] {
			completedIDs = append(completedIDs, t["id"])
			completedSet[jsv.Number(t["id"])] = true
		}
		_, err := r.Store.UpdateRunSession(sid, Obj{"completed_task_ids": completedIDs, "current_task_id": t["id"]})
		return err
	}

	for _, task := range tasks {
		if task["id"] != nil && completedSet[jsv.Number(task["id"])] {
			continue
		}
		if _, err := r.Store.UpdateRunSession(sid, Obj{"current_benchmark_id": benchmarkID, "current_task_id": task["id"], "status": "running"}); err != nil {
			return nil, err
		}
		attempts := attemptsOf(task)
		var totalMs int64
		thinking := ""
		for attempt := 1; attempt <= attempts; attempt++ {
			if ctx.Err() != nil {
				return nil, errors.New(providers.CancelledMessage)
			}
			start := time.Now()
			if toolagent.IsToolTask(task, b) {
				bb := Obj{}
				for k, v := range b {
					bb[k] = v
				}
				bb["id"] = benchmarkID
				ar, err := toolagent.Run(ctx, p, model, bb, task, r.Runtime, r.Store.Pref("mcp_servers"), send)
				if err != nil {
					return nil, err
				}
				dur := time.Since(start).Milliseconds()
				totalMs += dur
				var score any = ar.Score
				if task["score_type"] != "boolean" {
					score = 0.0
					if ar.Verification["passed"] == true {
						score = 100.0
					}
				}
				created, err := r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "task_id": task["id"], "run_session_id": sid, "score": score, "notes": ar.Response, "thinking_notes": ar.Thinking, "attempt_number": float64(attempt), "tokens_used": ar.TokensUsed, "duration_ms": float64(totalMs)})
				if err != nil {
					return nil, err
				}
				var e any
				if ar.Verification["passed"] != true {
					e = jsv.Or(ar.Verification["reason"], nil)
				}
				results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": task["id"], "result_id": created["id"], "score": jsv.String(score), "response": ar.Response, "thinking": ar.Thinking, "tokens_used": ar.TokensUsed, "duration_ms": totalMs, "is_manual": false, "error": e, "attempt_number": attempt})
				if err := markDone(task); err != nil {
					return nil, err
				}
				send("task:done", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "sessionId": sid, "score": jsv.String(score), "response": ar.Response, "thinking": ar.Thinking, "attemptNumber": attempt, "is_manual": false, "resultId": created["id"], "tokensUsed": ar.TokensUsed, "durationMs": dur, "totalDurationMs": totalMs, "error": e, "toolWorkdir": ar.Workdir, "toolVerification": ar.Verification})
				break
			}
			res, err := p.StreamPrompt(ctx, model, jsv.Str(task["prompt_template"]), imageFor(task), providers.Handlers{
				OnChunk: func(text string) {
					send("task:chunk", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "text": text, "attemptNumber": attempt})
				},
				OnThinkingChunk: func(text string) {
					thinking += text
					send("task:thinking-chunk", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "text": text, "attemptNumber": attempt})
				},
			})
			if err != nil {
				return nil, err
			}
			dur := time.Since(start).Milliseconds()
			totalMs += dur
			if res.Response == providers.ManualResponse {
				results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": task["id"], "score": nil, "response": nil, "thinking": thinking, "tokens_used": res.TokensUsed, "duration_ms": dur, "is_manual": true, "error": nil, "attempt_number": attempt})
				send("task:done", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "sessionId": sid, "score": nil, "response": nil, "attemptNumber": attempt, "is_manual": true, "tokensUsed": res.TokensUsed, "durationMs": dur, "totalDurationMs": totalMs})
				break
			}
			ev := r.EvaluateScore(ctx, task, res.Response, opts)
			if ev.NeedsVerify {
				results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": task["id"], "score": nil, "response": res.Response, "thinking": thinking, "tokens_used": res.TokensUsed, "duration_ms": dur, "is_manual": false, "needs_verify": true, "error": nil, "attempt_number": attempt})
				send("task:needs-maze-verify", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "sessionId": sid, "modelId": modelID, "modelResponse": res.Response, "referenceImage": task["reference_image"], "passCondition": task["pass_condition"], "attemptNumber": attempt, "tokensUsed": res.TokensUsed, "durationMs": dur, "totalDurationMs": totalMs})
				break
			}
			if ev.IsManual {
				results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": task["id"], "score": nil, "response": res.Response, "thinking": thinking, "tokens_used": res.TokensUsed, "duration_ms": dur, "is_manual": true, "error": nil, "attempt_number": attempt})
				send("task:done", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "sessionId": sid, "score": nil, "response": res.Response, "attemptNumber": attempt, "is_manual": true, "output_type": task["output_type"], "tokensUsed": res.TokensUsed, "durationMs": dur, "totalDurationMs": totalMs})
				break
			}
			if ev.Error != "" && attempt < attempts {
				send("task:retry", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "attempt": attempt + 1, "maxAttempts": attempts, "durationMs": dur, "totalDurationMs": totalMs})
				continue
			}
			sv := ev.Score
			if sv == nil {
				sv = 0.0
			}
			score := NormalizeBenchmarkScore(task, sv, attempt, attempts)
			th := thinking
			if note := sandboxNote(ev); note != "" {
				th = thinking + "\n\n" + note
			}
			var thv any = th
			if th == "" {
				thv = ""
			}
			created, err := r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "task_id": task["id"], "run_session_id": sid, "score": score, "notes": res.Response, "thinking_notes": thv, "attempt_number": float64(attempt), "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "duration_ms": float64(totalMs)})
			if err != nil {
				return nil, err
			}
			results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": task["id"], "result_id": created["id"], "score": jsv.String(score), "response": res.Response, "thinking": thv, "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "estimated_cost_usd": created["estimated_cost_usd"], "duration_ms": totalMs, "is_manual": false, "error": errOrNil(ev.Error), "attempt_number": attempt})
			if err := markDone(task); err != nil {
				return nil, err
			}
			var thOut any
			if th != "" {
				thOut = th
			}
			send("task:done", Obj{"benchmarkId": benchmarkID, "taskId": task["id"], "sessionId": sid, "score": jsv.String(score), "response": res.Response, "thinking": thOut, "attemptNumber": attempt, "is_manual": false, "resultId": created["id"], "tokensUsed": res.TokensUsed, "durationMs": dur, "totalDurationMs": totalMs, "error": errOrNil(ev.Error), "sandbox": ev.Sandbox})
			break
		}
	}

	var completed []Obj
	for _, res := range results {
		if res["is_manual"] == true || res["needs_verify"] == true || res["score"] == nil {
			continue
		}
		completed = append(completed, res)
	}
	agg := AggregateBenchmarkScore(b, scoresOf(completed))
	var aggregate Obj
	if agg != nil {
		sum := func(k string) float64 {
			t := 0.0
			for _, c := range completed {
				if f := jsv.Number(c[k]); !math.IsNaN(f) {
					t += f
				}
			}
			return t
		}
		orNil := func(f float64) any {
			if f == 0 {
				return nil
			}
			return f
		}
		var err error
		aggregate, err = r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "task_id": nil, "run_session_id": sid, "score": agg,
			"notes": buildNotes(completed, tasks), "thinking_notes": buildThinking(completed, tasks), "attempt_number": 1.0,
			"tokens_used": orNil(sum("tokens_used")), "input_tokens": orNil(sum("input_tokens")), "output_tokens": orNil(sum("output_tokens")), "duration_ms": orNil(sum("duration_ms"))})
		if err != nil {
			return nil, err
		}
	}
	var avg any
	if agg != nil {
		if b["score_type"] == "boolean" {
			avg = 0
			if agg == "tak" {
				avg = 1
			}
		} else {
			avg = jsv.Number(agg)
		}
	}
	if _, err := r.Store.FinishRunSession(sid); err != nil {
		return nil, err
	}
	summary := Obj{"total": len(tasks), "completed": len(completed), "avgScore": avg}
	if aggregate != nil {
		results = append(results, Obj{"benchmark_id": benchmarkID, "task_id": nil, "result_id": aggregate["id"], "score": jsv.String(agg), "response": aggregate["notes"], "thinking": aggregate["thinking_notes"], "tokens_used": aggregate["tokens_used"], "input_tokens": aggregate["input_tokens"], "output_tokens": aggregate["output_tokens"], "estimated_cost_usd": aggregate["estimated_cost_usd"], "duration_ms": aggregate["duration_ms"], "is_manual": false, "error": nil, "attempt_number": 1, "aggregate": true})
	}
	if results == nil {
		results = []Obj{}
	}
	send("benchmark:done", Obj{"summary": summary, "results": results, "error": nil})
	return Obj{"results": results, "summary": summary, "error": nil}, nil
}

// SubmitManualBatch mirrors submitManualBatch.
func (r *Runner) SubmitManualBatch(ctx context.Context, payload Obj) (Obj, error) {
	if payload == nil {
		payload = Obj{}
	}
	modelID, benchmarkID := payload["modelId"], payload["benchmarkId"]
	entries := jsv.AsArr(payload["entries"])
	model, err := r.Store.GetModelByID(modelID)
	if err != nil {
		return nil, err
	}
	b, err := r.Store.GetBenchmarkByID(benchmarkID)
	if err != nil {
		return nil, err
	}
	if model == nil {
		return Obj{"ok": false, "error": "Model was not found.", "results": []any{}}, nil
	}
	if b == nil {
		return Obj{"ok": false, "error": "Benchmark was not found.", "results": []any{}}, nil
	}
	if len(entries) == 0 {
		return Obj{"ok": false, "error": "No responses in the manual batch.", "results": []any{}}, nil
	}
	if len(entries) > 1000 {
		return Obj{"ok": false, "error": "Too many responses in the manual batch (max 1000).", "results": []any{}}, nil
	}
	tasks, err := r.runnableTasks(benchmarkID, b)
	if err != nil {
		return nil, err
	}
	var session Obj
	if sid := jsv.Or(payload["runSessionId"], payload["sessionId"]); jsv.Truthy(sid) {
		session, _ = r.Store.GetRunSession(sid)
	}
	if session == nil {
		if session, err = r.Store.CreateRunSession(Obj{"model_id": modelID, "benchmark_ids": []any{benchmarkID}, "current_benchmark_id": benchmarkID, "completed_task_ids": []any{}}); err != nil {
			return nil, err
		}
	}
	sid := session["id"]
	opts := r.evalOpts()
	completed := []any{}
	completedSet := map[float64]bool{}
	for _, id := range jsv.AsArr(session["completed_task_ids"]) {
		n := jsv.Number(id)
		if !completedSet[n] {
			completedSet[n] = true
			completed = append(completed, n)
		}
	}
	var batch []Obj
	if _, err := r.Store.UpdateRunSession(sid, Obj{"current_benchmark_id": benchmarkID, "status": "running"}); err != nil {
		return nil, err
	}
	for _, raw := range entries {
		entry := jsv.AsObj(raw)
		if entry == nil {
			entry = Obj{}
		}
		task := resolveBatchTask(entry, tasks)
		response := strings.TrimSpace(jsv.String(jsv.Coalesce(entry["response"], entry["answer"], entry["patch"], entry["diff"], "")))
		if task == nil {
			batch = append(batch, Obj{"ok": false, "taskId": jsv.Coalesce(entry["taskId"], entry["task_id"]), "error": "task_id was not found in this benchmark."})
			continue
		}
		taskID := jsv.Or(task["id"], nil)
		if response == "" {
			batch = append(batch, Obj{"ok": false, "taskId": taskID, "error": "Empty response in the manual batch."})
			continue
		}
		if _, err := r.Store.UpdateRunSession(sid, Obj{"current_benchmark_id": benchmarkID, "current_task_id": taskID, "status": "running"}); err != nil {
			return nil, err
		}
		ev := r.EvaluateScore(ctx, task, response, opts)
		provided := NormalizeProvidedScore(jsv.Coalesce(entry["score"], entry["result"], entry["passed"]), task["score_type"])
		candidate := provided
		if candidate == nil && !ev.NeedsVerify && ev.Score != nil {
			candidate = ev.Score
		}
		if candidate == nil {
			msg := ev.Error
			switch {
			case ev.NeedsVerify:
				msg = "This task requires separate manual verification."
			case ev.IsManual:
				msg = `Could not evaluate automatically. Add score="0-100" or score="tak/nie" to the answer block.`
			case msg == "":
				msg = "Could not evaluate the response from the manual batch."
			}
			batch = append(batch, Obj{"ok": false, "taskId": taskID, "response": response, "error": msg})
			continue
		}
		score := NormalizeBenchmarkScore(task, candidate, 1, 1)
		var parts []string
		if provided != nil {
			parts = append(parts, "Manual batch provided score: "+jsv.String(provided))
		}
		if ev.Error != "" {
			parts = append(parts, "Evaluation note: "+ev.Error)
		}
		if n := sandboxNote(ev); n != "" {
			parts = append(parts, n)
		}
		var thinking any
		if len(parts) > 0 {
			thinking = strings.Join(parts, "\n\n")
		}
		created, err := r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "task_id": taskID, "run_session_id": sid, "score": score, "notes": response, "thinking_notes": thinking, "attempt_number": 1.0, "tokens_used": nil, "duration_ms": nil})
		if err != nil {
			batch = append(batch, Obj{"ok": false, "taskId": taskID, "response": response, "error": err.Error()})
			continue
		}
		if taskID != nil && !completedSet[jsv.Number(taskID)] {
			completedSet[jsv.Number(taskID)] = true
			completed = append(completed, jsv.Number(taskID))
		}
		if _, err := r.Store.UpdateRunSession(sid, Obj{"completed_task_ids": completed, "current_task_id": taskID}); err != nil {
			return nil, err
		}
		batch = append(batch, Obj{"ok": true, "taskId": taskID, "resultId": created["id"], "score": jsv.String(score), "response": response, "error": errOrNil(ev.Error)})
	}
	var ids []float64
	for _, t := range tasks {
		if jsv.Truthy(t["id"]) {
			ids = append(ids, jsv.Number(t["id"]))
		}
	}
	allDone := len(ids) > 0
	for _, id := range ids {
		if !completedSet[id] {
			allDone = false
		}
	}
	anyOK := false
	for _, x := range batch {
		if x["ok"] == true {
			anyOK = true
		}
	}
	if len(ids) == 0 {
		allDone = anyOK
	}
	var aggregate any
	finish := jsv.Truthy(payload["finish"])
	if finish && allDone && len(ids) > 0 {
		var done []Obj
		for _, t := range tasks {
			if !jsv.Truthy(t["id"]) {
				continue
			}
			saved, err := r.Store.GetLatestTaskResult(modelID, benchmarkID, t["id"], jsv.Str(session["started_at"]))
			if err != nil {
				return nil, err
			}
			if saved != nil {
				done = append(done, Obj{"benchmark_id": benchmarkID, "task_id": saved["task_id"], "result_id": saved["id"], "score": saved["score"], "response": saved["notes"], "thinking": saved["thinking_notes"], "tokens_used": saved["tokens_used"], "duration_ms": saved["duration_ms"]})
			}
		}
		if agg := AggregateBenchmarkScore(b, scoresOf(done)); agg != nil {
			ar, err := r.Store.AddResult(Obj{"model_id": modelID, "benchmark_id": benchmarkID, "task_id": nil, "run_session_id": sid, "score": agg, "notes": buildNotes(done, tasks), "thinking_notes": buildThinking(done, tasks), "attempt_number": 1.0, "tokens_used": nil, "duration_ms": nil})
			if err != nil {
				return nil, err
			}
			aggregate = Obj{"resultId": ar["id"], "score": jsv.String(agg)}
		}
		if _, err := r.Store.FinishRunSession(sid); err != nil {
			return nil, err
		}
	} else if finish && allDone {
		if _, err := r.Store.FinishRunSession(sid); err != nil {
			return nil, err
		}
	}
	anyFail := false
	for _, x := range batch {
		if x["ok"] != true {
			anyFail = true
		}
	}
	var errMsg any
	if anyFail {
		errMsg = "Some manual batch responses were not saved."
	}
	if batch == nil {
		batch = []Obj{}
	}
	return Obj{"ok": anyOK, "sessionId": sid, "completedTaskIds": completed, "results": batch, "aggregate": aggregate, "error": errMsg}, nil
}

func resolveBatchTask(entry Obj, tasks []Obj) Obj {
	raw := jsv.Coalesce(entry["taskId"], entry["task_id"], entry["id"])
	if raw == nil || raw == "" {
		if len(tasks) == 1 {
			return tasks[0]
		}
		return nil
	}
	n := jsv.Number(raw)
	if math.IsNaN(n) || math.IsInf(n, 0) {
		if len(tasks) == 1 {
			return tasks[0]
		}
		return nil
	}
	if n != 0 {
		for _, t := range tasks {
			if t["id"] != nil && jsv.Number(t["id"]) == n {
				return t
			}
		}
		return nil
	}
	for _, t := range tasks {
		if !jsv.Truthy(t["id"]) {
			return t
		}
	}
	if len(tasks) == 1 {
		return tasks[0]
	}
	return nil
}
