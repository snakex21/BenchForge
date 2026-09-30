package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type Echo struct{}

func (Echo) Generate(ctx context.Context, model, prompt string, settings Settings) (Output, error) {
	if err := ctx.Err(); err != nil {
		return Output{}, err
	}
	return Output{Text: prompt}, nil
}

func (p LocalAPI) Endpoint() string { return p.BaseURL }

type LocalAPI struct {
	BaseURL string
	Client  *http.Client
}

func localEndpoint(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("invalid local endpoint URL")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || !(u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()) {
		return "", errors.New("this prototype accepts only an HTTP loopback model endpoint without credentials/query")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func (p LocalAPI) Generate(ctx context.Context, model, prompt string, s Settings) (Output, error) {
	body, err := json.Marshal(map[string]any{"model": model, "messages": []map[string]string{{"role": "user", "content": prompt}}, "temperature": s.Temperature, "max_tokens": s.MaxTokens, "stream": false})
	if err != nil {
		return Output{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.BaseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Output{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.Client.Do(req)
	if err != nil {
		return Output{}, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 256*1024+1))
	if err != nil {
		return Output{}, err
	}
	if len(b) > 256*1024 {
		return Output{}, errors.New("model response exceeds 256 KiB")
	}
	if resp.StatusCode != http.StatusOK {
		return Output{}, fmt.Errorf("model endpoint HTTP %d", resp.StatusCode)
	}
	var data struct {
		Model       string `json:"model"`
		Fingerprint string `json:"system_fingerprint"`
		Choices     []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			Input  *int `json:"prompt_tokens"`
			Output *int `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(b, &data); err != nil {
		return Output{}, fmt.Errorf("invalid model response: %w", err)
	}
	if len(data.Choices) == 0 {
		return Output{}, errors.New("model response has no choices")
	}
	return Output{ActualModel: data.Model, SystemFingerprint: data.Fingerprint, Text: data.Choices[0].Message.Content, InputTokens: data.Usage.Input, OutputTokens: data.Usage.Output}, nil
}
