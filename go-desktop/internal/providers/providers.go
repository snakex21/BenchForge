// Package providers ports electron/providers/{api,manual}.cjs: an
// OpenAI-compatible chat-completions client (blocking + SSE streaming with
// <think> / reasoning_content separation) and the "manual" provider.
package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

const (
	TimeoutMessage   = "Timed out waiting for the model response."
	CancelledMessage = "Benchmark was cancelled by the user."
	ManualResponse   = "__MANUAL__"
	requestTimeout   = 120 * time.Second
	maxResponseBytes = 32 << 20
)

// Result is a completed model response.
type Result struct {
	Response     string
	TokensUsed   any // number or nil
	InputTokens  any
	OutputTokens any
}

// Handlers receive streamed text.
type Handlers struct {
	OnChunk         func(string)
	OnThinkingChunk func(string)
}

// Provider is implemented by the API and manual providers.
type Provider interface {
	SendPrompt(ctx context.Context, model jsv.Obj, prompt string, imageBase64 string) (Result, error)
	StreamPrompt(ctx context.Context, model jsv.Obj, prompt string, imageBase64 string, h Handlers) (Result, error)
	TestConnection(ctx context.Context, model jsv.Obj) (bool, string)
}

// Get returns the provider for a model mode.
func Get(mode string) (Provider, error) {
	switch mode {
	case "manual":
		return Manual{}, nil
	case "api":
		return &API{Client: DefaultClient}, nil
	default:
		return nil, fmt.Errorf("Nieobsługiwany tryb modelu: %s", mode)
	}
}

// DefaultClient never follows redirects to a different host with the
// Authorization header (net/http strips it on cross-host redirects).
var DefaultClient = &http.Client{}

// ---------- manual ----------

type Manual struct{}

func (Manual) SendPrompt(context.Context, jsv.Obj, string, string) (Result, error) {
	return Result{Response: ManualResponse}, nil
}
func (Manual) StreamPrompt(context.Context, jsv.Obj, string, string, Handlers) (Result, error) {
	return Result{Response: ManualResponse}, nil
}
func (Manual) TestConnection(context.Context, jsv.Obj) (bool, string) { return true, "" }

// ---------- API ----------

type API struct{ Client *http.Client }

func normalizeBaseURL(v any) string {
	return strings.TrimSuffix(strings.TrimSpace(jsv.Str(v)), "/")
}

// EstimateTokens is the JS estimateTokens (chars/4).
func EstimateTokens(parts ...string) any {
	text := strings.Join(nonEmpty(parts), "\n")
	if strings.TrimSpace(text) == "" {
		return nil
	}
	n := int64(math.Ceil(float64(len([]rune(text))) / 4))
	if n < 1 {
		n = 1
	}
	return n
}

func nonEmpty(parts []string) []string {
	out := []string{}
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

type usage struct {
	total, input, output any
}

func usageFrom(payload jsv.Obj) usage {
	u := jsv.AsObj(payload["usage"])
	if u == nil {
		u = jsv.Obj{}
	}
	in := jsv.Coalesce(u["prompt_tokens"], u["input_tokens"])
	out := jsv.Coalesce(u["completion_tokens"], u["output_tokens"])
	total := u["total_tokens"]
	if total == nil && (in != nil || out != nil) {
		total = jsv.Number(in) + jsv.Number(out)
	}
	return usage{total: total, input: in, output: out}
}

func buildMessages(prompt, image string) []any {
	if image == "" {
		return []any{map[string]any{"role": "user", "content": prompt}}
	}
	url := image
	if !strings.HasPrefix(image, "data:") {
		url = "data:image/png;base64," + image
	}
	return []any{map[string]any{"role": "user", "content": []any{
		map[string]any{"type": "image_url", "image_url": map[string]any{"url": url}},
		map[string]any{"type": "text", "text": prompt},
	}}}
}

func validateModel(model jsv.Obj) (string, error) {
	base := normalizeBaseURL(model["base_url"])
	if base == "" {
		return "", errors.New("Missing base_url for the API model.")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return "", errors.New("base_url must start with http:// or https://")
	}
	if !jsv.Truthy(model["model_id"]) {
		return "", errors.New("Missing model_id for the API model.")
	}
	return base, nil
}

// ReasoningLevels are the accepted values for the model_id "#effort=" suffix.
var ReasoningLevels = map[string]bool{"none": true, "minimal": true, "low": true, "medium": true, "high": true, "xhigh": true}

// SplitModelID separates an optional "#effort=<level>" suffix from model_id
// ("gpt-6-luna#effort=low" -> "gpt-6-luna", "low"). Model ids never contain
// '#', so ids without a valid suffix are returned unchanged.
func SplitModelID(v any) (id, effort string) {
	id = jsv.Str(v)
	i := strings.LastIndex(id, "#effort=")
	if i <= 0 {
		return id, ""
	}
	if lvl := strings.ToLower(strings.TrimSpace(id[i+len("#effort="):])); ReasoningLevels[lvl] {
		return id[:i], lvl
	}
	return id, ""
}

func isOpenAI(base string) bool {
	return strings.HasPrefix(base, "https://api.openai.com/")
}

// chatBody builds the chat-completions request. OpenAI's reasoning models
// reject max_tokens, so api.openai.com (and any server that asks for it,
// see postChat) gets max_completion_tokens, which also covers the reasoning
// tokens, hence the larger limit.
func chatBody(base string, model jsv.Obj, prompt, image string, stream, completionTokens bool) map[string]any {
	id, effort := SplitModelID(model["model_id"])
	body := map[string]any{"model": id, "messages": buildMessages(prompt, image)}
	if completionTokens || isOpenAI(base) {
		body["max_completion_tokens"] = 8192
	} else {
		body["max_tokens"] = 2048
	}
	if effort != "" {
		body["reasoning_effort"] = effort
	}
	if stream {
		body["stream"] = true
		if isOpenAI(base) {
			body["stream_options"] = map[string]any{"include_usage": true}
		}
	}
	return body
}

// postChat sends the request and retries once with max_completion_tokens
// when the server rejects max_tokens (OpenAI-style reasoning models behind
// a compatible proxy). On a non-2xx status it returns the parsed message.
func (a *API) postChat(ctx, parent context.Context, base string, model jsv.Obj, prompt, image string, stream bool) (*http.Response, error) {
	completion := false
	for attempt := 0; ; attempt++ {
		req, err := a.newRequest(ctx, http.MethodPost, base+"/chat/completions", chatBody(base, model, prompt, image, stream, completion), jsv.Str(model["api_key"]))
		if err != nil {
			return nil, err
		}
		resp, err := a.client().Do(req)
		if err != nil {
			return nil, mapCtxErr(ctx, parent, err)
		}
		if resp.StatusCode >= 200 && resp.StatusCode <= 299 {
			return resp, nil
		}
		msg := parseError(resp)
		resp.Body.Close()
		if attempt == 0 && !completion && resp.StatusCode == http.StatusBadRequest && strings.Contains(msg, "max_tokens") && strings.Contains(msg, "max_completion_tokens") {
			completion = true
			continue
		}
		return nil, errors.New(msg)
	}
}

func (a *API) client() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return DefaultClient
}

func (a *API) newRequest(ctx context.Context, method, url string, body any, apiKey string) (*http.Request, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	return req, nil
}

func parseError(resp *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var payload map[string]any
	if json.Unmarshal(b, &payload) == nil {
		if e := jsv.AsObj(payload["error"]); e != nil && jsv.Truthy(e["message"]) {
			return jsv.String(e["message"])
		}
		if jsv.Truthy(payload["message"]) {
			return jsv.String(payload["message"])
		}
	}
	if t := http.StatusText(resp.StatusCode); t != "" {
		return t
	}
	return resp.Status
}

func mapCtxErr(ctx, parent context.Context, err error) error {
	if parent.Err() != nil {
		return errors.New(CancelledMessage)
	}
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		return errors.New(TimeoutMessage)
	}
	return err
}

func (a *API) SendPrompt(parent context.Context, model jsv.Obj, prompt, image string) (Result, error) {
	base, err := validateModel(model)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(parent, requestTimeout)
	defer cancel()
	resp, err := a.postChat(ctx, parent, base, model, prompt, image, false)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	var payload jsv.Obj
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxResponseBytes)).Decode(&payload); err != nil {
		return Result{}, mapCtxErr(ctx, parent, fmt.Errorf("invalid JSON from model API: %w", err))
	}
	content := ""
	if choices := jsv.AsArr(payload["choices"]); len(choices) > 0 {
		if msg := jsv.AsObj(jsv.AsObj(choices[0])["message"]); msg != nil {
			content = jsv.Str(msg["content"])
		}
	}
	u := usageFrom(payload)
	tokens := u.total
	if tokens == nil {
		tokens = EstimateTokens(prompt, content)
	}
	return Result{Response: content, TokensUsed: tokens, InputTokens: u.input, OutputTokens: u.output}, nil
}

// thinkSplitter separates <think>...</think> sections across chunks.
type thinkSplitter struct{ inThink bool }

func (t *thinkSplitter) split(text string) (normal, thinking string) {
	var n, th strings.Builder
	rem := text
	for rem != "" {
		if t.inThink {
			end := strings.Index(rem, "</think>")
			if end == -1 {
				th.WriteString(rem)
				rem = ""
			} else {
				th.WriteString(rem[:end])
				rem = rem[end+len("</think>"):]
				t.inThink = false
			}
			continue
		}
		start := strings.Index(rem, "<think>")
		if start == -1 {
			n.WriteString(rem)
			rem = ""
		} else {
			n.WriteString(rem[:start])
			rem = rem[start+len("<think>"):]
			t.inThink = true
		}
	}
	return n.String(), th.String()
}

func (a *API) StreamPrompt(parent context.Context, model jsv.Obj, prompt, image string, h Handlers) (Result, error) {
	if parent.Err() != nil {
		return Result{}, errors.New(CancelledMessage)
	}
	base, err := validateModel(model)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(parent, requestTimeout)
	defer cancel()
	resp, err := a.postChat(ctx, parent, base, model, prompt, image, true)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()

	var full, fullThinking strings.Builder
	var usageTokens any
	var details *usage
	splitter := &thinkSplitter{}
	handle := func(data string) bool {
		if data == "[DONE]" {
			return true
		}
		var chunk jsv.Obj
		if json.Unmarshal([]byte(data), &chunk) != nil {
			return false
		}
		if u := jsv.AsObj(chunk["usage"]); u != nil && u["total_tokens"] != nil {
			usageTokens = u["total_tokens"]
			d := usageFrom(chunk)
			details = &d
		}
		var delta jsv.Obj
		if choices := jsv.AsArr(chunk["choices"]); len(choices) > 0 {
			delta = jsv.AsObj(jsv.AsObj(choices[0])["delta"])
		}
		if delta == nil {
			return false
		}
		if r := jsv.Str(jsv.Or(delta["reasoning_content"], delta["reasoning"], "")); r != "" {
			fullThinking.WriteString(r)
			if h.OnThinkingChunk != nil {
				h.OnThinkingChunk(r)
			}
		}
		token, thinking := splitter.split(jsv.Str(delta["content"]))
		if thinking != "" {
			fullThinking.WriteString(thinking)
			if h.OnThinkingChunk != nil {
				h.OnThinkingChunk(thinking)
			}
		}
		if token != "" {
			full.WriteString(token)
			if h.OnChunk != nil {
				h.OnChunk(token)
			}
		}
		return false
	}

	reader := bufio.NewReaderSize(io.LimitReader(resp.Body, maxResponseBytes), 64<<10)
	for {
		line, rerr := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimSpace(line[6:])
			if data != "" && handle(data) {
				break
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				break
			}
			return Result{}, mapCtxErr(ctx, parent, rerr)
		}
	}
	if parent.Err() != nil {
		return Result{}, errors.New(CancelledMessage)
	}
	tokens := usageTokens
	if tokens == nil {
		tokens = EstimateTokens(prompt, fullThinking.String(), full.String())
	}
	res := Result{Response: full.String(), TokensUsed: tokens}
	if details != nil {
		res.InputTokens, res.OutputTokens = details.input, details.output
	}
	return res, nil
}

func (a *API) TestConnection(parent context.Context, model jsv.Obj) (bool, string) {
	base := normalizeBaseURL(model["base_url"])
	if base == "" {
		return false, "Missing base_url for the API model."
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return false, "base_url must start with http:// or https://"
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	req, err := a.newRequest(ctx, http.MethodGet, base+"/models", nil, jsv.Str(model["api_key"]))
	if err != nil {
		return false, err.Error()
	}
	resp, err := a.client().Do(req)
	if err != nil {
		return false, mapCtxErr(ctx, parent, err).Error()
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return false, parseError(resp)
	}
	return true, ""
}
