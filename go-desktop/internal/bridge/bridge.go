// Package bridge connects the unchanged React UI to Go. It replaces
// electron/preload.cjs + ipcMain: shim.js recreates window.benchforge /
// window.db on top of a single webview binding, and Dispatcher routes each
// channel to a registered, input-validating handler.
package bridge

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"runtime/debug"
	"strings"
	"sync"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

//go:embed shim.js
var shimJS string

// MaxArgsBytes bounds one call's JSON arguments (imports can be large).
const MaxArgsBytes = 64 << 20

// Args are the decoded positional arguments of a call.
type Args []any

// Handler serves one channel.
type Handler func(ctx context.Context, a Args) (any, error)

// InputError marks a validation failure (reported to the UI as-is).
type InputError struct{ msg string }

func (e *InputError) Error() string { return e.msg }

// Errf builds an InputError.
func Errf(format string, v ...any) error { return &InputError{fmt.Sprintf(format, v...)} }

// Dispatcher owns the channel registry.
type Dispatcher struct {
	token    string
	mu       sync.RWMutex
	handlers map[string]Handler
	ctx      context.Context
	wg       sync.WaitGroup
}

// New creates a dispatcher; token must be the per-session secret that the
// init script exposes to our origin only.
func New(ctx context.Context, token string) *Dispatcher {
	return &Dispatcher{token: token, handlers: map[string]Handler{}, ctx: ctx}
}

// Handle registers a channel.
func (d *Dispatcher) Handle(channel string, h Handler) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, dup := d.handlers[channel]; dup {
		panic("duplicate bridge channel " + channel)
	}
	d.handlers[channel] = h
}

// Channels lists registered channels.
func (d *Dispatcher) Channels() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]string, 0, len(d.handlers))
	for c := range d.handlers {
		out = append(out, c)
	}
	return out
}

// Settler delivers a call result to the UI (ok=false => rejected promise).
type Settler func(id int64, ok bool, payload any)

// Invoke validates and dispatches one call asynchronously. It never blocks
// the UI thread; the result is delivered through settle.
func (d *Dispatcher) Invoke(token string, id float64, channel string, argsJSON string, settle Settler) error {
	if token == "" || len(token) != len(d.token) || !constantTimeEq(token, d.token) {
		log.Printf("[bridge][security] rejected call to %q: bad token", channel)
		return errors.New("forbidden")
	}
	if id != math.Trunc(id) || id < 0 || id > 1<<53 {
		return errors.New("invalid call id")
	}
	cid := int64(id)
	d.mu.RLock()
	h, ok := d.handlers[channel]
	d.mu.RUnlock()
	if !ok {
		settle(cid, false, "Unknown channel: "+channel)
		return nil
	}
	if len(argsJSON) > MaxArgsBytes {
		settle(cid, false, "Request too large.")
		return nil
	}
	var args Args
	if argsJSON != "" {
		if err := json.Unmarshal([]byte(argsJSON), &args); err != nil {
			settle(cid, false, "Invalid arguments.")
			return nil
		}
	}
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[bridge] panic in %s: %v\n%s", channel, r, debug.Stack())
				settle(cid, false, "Internal error.")
			}
		}()
		res, err := h(d.ctx, args)
		if err != nil {
			settle(cid, false, err.Error())
			return
		}
		settle(cid, true, res)
	}()
	return nil
}

// Wait blocks until in-flight calls finish (shutdown).
func (d *Dispatcher) Wait() { d.wg.Wait() }

func constantTimeEq(a, b string) bool {
	var v byte
	for i := 0; i < len(a) && i < len(b); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0 && len(a) == len(b)
}

// InitScript returns the shim with origin, token and the persisted
// localStorage snapshot substituted.
func InitScript(origin, token string, storage map[string]string) string {
	if storage == nil {
		storage = map[string]string{}
	}
	r := strings.NewReplacer(
		"__BF_ORIGIN__", jsv.JSONString(origin),
		"__BF_TOKEN__", jsv.JSONString(token),
		"__BF_STORAGE__", jsv.JSONString(storage),
	)
	return r.Replace(shimJS)
}

// SettleScript renders the JS that resolves a pending call.
func SettleScript(id int64, ok bool, payload any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		ok, data = false, []byte(jsv.JSONString("Could not serialise the result: "+err.Error()))
	}
	return fmt.Sprintf("window.__bfSettle && window.__bfSettle(%d,%t,%s);", id, ok, data)
}

// EmitScript renders the JS that delivers a stream event.
func EmitScript(event string, payload any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		data = []byte("{}")
	}
	return fmt.Sprintf("window.__bfEmit && window.__bfEmit(%s,%s);", jsv.JSONString(event), data)
}

// ---------- argument helpers (validation) ----------

// Arg returns the i-th argument or nil.
func (a Args) Arg(i int) any {
	if i < len(a) {
		return a[i]
	}
	return nil
}

// Obj returns argument i as an object; nil/missing gives an empty object
// when optional, otherwise an error.
func (a Args) Obj(i int, optional bool) (jsv.Obj, error) {
	v := a.Arg(i)
	if v == nil {
		if optional {
			return jsv.Obj{}, nil
		}
		return nil, Errf("argument %d must be an object", i+1)
	}
	o, ok := v.(map[string]any)
	if !ok {
		return nil, Errf("argument %d must be an object", i+1)
	}
	return o, nil
}

// Str returns argument i as a bounded string.
func (a Args) Str(i int, maxLen int, required bool) (string, error) {
	v := a.Arg(i)
	if v == nil {
		if required {
			return "", Errf("argument %d is required", i+1)
		}
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", Errf("argument %d must be a string", i+1)
	}
	if len(s) > maxLen {
		return "", Errf("argument %d is too long", i+1)
	}
	if required && strings.TrimSpace(s) == "" {
		return "", Errf("argument %d is required", i+1)
	}
	return s, nil
}

// strictID accepts only JSON numbers that are positive integers.
func strictID(v any) (int64, bool) {
	f, isNum := v.(float64)
	if !isNum {
		return 0, false
	}
	n, ok := jsv.Int(f)
	return n, ok && n > 0
}

// ID validates a positive integer id field of an object.
func ID(o jsv.Obj, key string) (int64, error) {
	v, ok := strictID(o[key])
	if !ok {
		return 0, Errf("%s must be a positive integer", key)
	}
	return v, nil
}

// OptID validates an optional positive integer id (nil when absent/null/0).
func OptID(o jsv.Obj, keys ...string) (any, error) {
	for _, k := range keys {
		raw := o[k]
		if raw == nil || raw == "" || raw == 0.0 {
			continue
		}
		v, ok := strictID(raw)
		if !ok {
			return nil, Errf("%s must be a positive integer", k)
		}
		return v, nil
	}
	return nil, nil
}

// Data returns o[key] as an object (required).
func Data(o jsv.Obj, key string) (jsv.Obj, error) {
	d, ok := o[key].(map[string]any)
	if !ok {
		return nil, Errf("%s must be an object", key)
	}
	return d, nil
}

// IDList validates an array of positive integer ids.
func IDList(v any, field string, max int) ([]any, error) {
	if v == nil {
		return nil, nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, Errf("%s must be an array", field)
	}
	if len(arr) > max {
		return nil, Errf("%s has too many items", field)
	}
	out := make([]any, 0, len(arr))
	for _, x := range arr {
		n, ok := strictID(x)
		if !ok {
			return nil, Errf("%s must contain positive integers", field)
		}
		out = append(out, n)
	}
	return out, nil
}
