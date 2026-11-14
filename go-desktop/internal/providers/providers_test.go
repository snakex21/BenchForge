package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

func TestStreamPromptSplitsThinkingAndUsage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-x" || r.URL.Path != "/v1/chat/completions" {
			http.Error(w, `{"error":{"message":"bad request"}}`, 400)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != true || body["max_tokens"] != 2048.0 {
			http.Error(w, "bad body", 400)
			return
		}
		fl := w.(http.Flusher)
		for _, c := range []string{
			`{"choices":[{"delta":{"reasoning_content":"plan "}}]}`,
			`{"choices":[{"delta":{"content":"<think>inner"}}]}`,
			`{"choices":[{"delta":{"content":" more</think>Answer"}}]}`,
			`not json`,
			`{"choices":[{"delta":{"content":" 42"}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}`,
		} {
			fmt.Fprintf(w, "data: %s\r\n\r\n", c)
			fl.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer srv.Close()
	var chunks, thinking strings.Builder
	res, err := (&API{Client: srv.Client()}).StreamPrompt(context.Background(), jsv.Obj{"base_url": srv.URL + "/v1/", "model_id": "m", "api_key": "sk-x"}, "q", "",
		Handlers{OnChunk: func(s string) { chunks.WriteString(s) }, OnThinkingChunk: func(s string) { thinking.WriteString(s) }})
	if err != nil {
		t.Fatal(err)
	}
	if res.Response != "Answer 42" || chunks.String() != "Answer 42" {
		t.Fatalf("response %q chunks %q", res.Response, chunks.String())
	}
	if thinking.String() != "plan inner more" {
		t.Fatalf("thinking %q", thinking.String())
	}
	if jsv.Number(res.TokensUsed) != 7 || jsv.Number(res.InputTokens) != 3 || jsv.Number(res.OutputTokens) != 4 {
		t.Fatalf("usage %+v", res)
	}
}

func TestSendPromptErrorsAndValidation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		fmt.Fprint(w, `{"error":{"message":"Invalid API key"}}`)
	}))
	defer srv.Close()
	a := &API{Client: srv.Client()}
	if _, err := a.SendPrompt(context.Background(), jsv.Obj{"base_url": srv.URL, "model_id": "m"}, "q", ""); err == nil || err.Error() != "Invalid API key" {
		t.Fatalf("err %v", err)
	}
	for _, m := range []jsv.Obj{{"model_id": "m"}, {"base_url": "file:///etc", "model_id": "m"}, {"base_url": "http://x"}} {
		if _, err := a.SendPrompt(context.Background(), m, "q", ""); err == nil {
			t.Fatalf("model %v accepted", m)
		}
	}
	ok, msg := a.TestConnection(context.Background(), jsv.Obj{"base_url": srv.URL})
	if ok || msg != "Invalid API key" {
		t.Fatalf("test connection %v %q", ok, msg)
	}
}

func TestStreamCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	_, err := (&API{Client: srv.Client()}).StreamPrompt(ctx, jsv.Obj{"base_url": srv.URL, "model_id": "m"}, "q", "", Handlers{OnChunk: func(string) {}})
	if err == nil || err.Error() != CancelledMessage {
		t.Fatalf("err %v", err)
	}
}

func TestManualAndEstimate(t *testing.T) {
	r, _ := Manual{}.StreamPrompt(context.Background(), nil, "", "", Handlers{})
	if r.Response != ManualResponse {
		t.Fatal("manual")
	}
	if EstimateTokens("abcd", "abcde") != int64(3) || EstimateTokens("", " ") != nil {
		t.Fatal("estimate")
	}
	if _, err := Get("oauth"); err == nil {
		t.Fatal("unknown mode accepted")
	}
}

func TestSplitModelID(t *testing.T) {
	cases := map[string][2]string{
		"gpt-6-luna#effort=low":   {"gpt-6-luna", "low"},
		"gpt-6-luna#effort=XHIGH": {"gpt-6-luna", "xhigh"},
		"gpt-6-luna#effort=bogus": {"gpt-6-luna#effort=bogus", ""},
		"qwen3.6-35b@iq3_m":       {"qwen3.6-35b@iq3_m", ""},
		"#effort=low":             {"#effort=low", ""},
	}
	for in, want := range cases {
		id, eff := SplitModelID(in)
		if id != want[0] || eff != want[1] {
			t.Errorf("%q -> %q,%q want %v", in, id, eff, want)
		}
	}
}

func TestOpenAIBodyUsesCompletionTokensAndEffort(t *testing.T) {
	m := jsv.Obj{"model_id": "gpt-6-luna#effort=low"}
	b := chatBody("https://api.openai.com/v1", m, "hi", "", true, false)
	if b["model"] != "gpt-6-luna" || b["reasoning_effort"] != "low" || b["max_completion_tokens"] == nil || b["max_tokens"] != nil || b["stream_options"] == nil {
		t.Fatalf("openai body %v", b)
	}
	b = chatBody("http://127.0.0.1:1234/v1", jsv.Obj{"model_id": "local"}, "hi", "", true, false)
	if b["max_tokens"] != 2048 || b["max_completion_tokens"] != nil || b["reasoning_effort"] != nil || b["stream_options"] != nil {
		t.Fatalf("compatible body %v", b)
	}
}

func TestRetriesWithMaxCompletionTokens(t *testing.T) {
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		bodies = append(bodies, b)
		if _, ok := b["max_tokens"]; ok {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`))
	}))
	defer srv.Close()
	res, err := (&API{}).SendPrompt(context.Background(), jsv.Obj{"base_url": srv.URL, "model_id": "o-model"}, "hi", "")
	if err != nil || res.Response != "ok" || len(bodies) != 2 || bodies[1]["max_completion_tokens"] == nil {
		t.Fatalf("res=%+v err=%v bodies=%v", res, err, bodies)
	}
}
