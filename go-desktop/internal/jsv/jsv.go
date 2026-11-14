// Package jsv contains small helpers that reproduce JavaScript value
// semantics (truthiness, `||`, `??`, Number(), String()) for payloads that
// arrive from the unchanged React UI as decoded JSON (map[string]any,
// []any, float64, string, bool, nil). Keeping these rules in one place is
// what makes the Go handlers behave like the original electron/*.cjs code.
package jsv

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Obj is a decoded JSON object.
type Obj = map[string]any

// Truthy implements JavaScript truthiness for decoded JSON values.
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case int64:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// Or is JavaScript `a || b || ...` (returns the last value when none is truthy).
func Or(values ...any) any {
	for _, v := range values {
		if Truthy(v) {
			return v
		}
	}
	if len(values) == 0 {
		return nil
	}
	return values[len(values)-1]
}

// Coalesce is JavaScript `a ?? b ?? ...`.
func Coalesce(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

// Has reports Object.prototype.hasOwnProperty.
func Has(m Obj, key string) bool {
	if m == nil {
		return false
	}
	_, ok := m[key]
	return ok
}

// AsObj returns v as an object or nil.
func AsObj(v any) Obj {
	m, _ := v.(map[string]any)
	return m
}

// AsArr returns v as an array or nil.
func AsArr(v any) []any {
	a, _ := v.([]any)
	return a
}

// IsArr reports Array.isArray.
func IsArr(v any) bool {
	_, ok := v.([]any)
	return ok
}

// Number is JavaScript Number(v). NaN is returned for non-numeric input.
func Number(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	default:
		return math.NaN()
	}
}

// Finite reports Number.isFinite(Number(v)) for non-nil values (JS
// `Number.isFinite(Number(null))` is true (0); callers that need the
// distinction check nil first).
func Finite(v any) bool {
	f := Number(v)
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}

// Int returns an integer id from a JSON number or numeric string.
func Int(v any) (int64, bool) {
	f := Number(v)
	if v == nil || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, false
	}
	if f > 9007199254740991 || f < -9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

// String is JavaScript String(v) for scalars.
func String(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return FormatNumber(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

// Str is `String(v || ”)`.
func Str(v any) string {
	if !Truthy(v) {
		return ""
	}
	return String(v)
}

// FormatNumber renders a float like JavaScript's Number#toString for the
// value ranges BenchForge uses (scores, prices, token counts).
func FormatNumber(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	// Go: 1e-07 ; JS: 1e-7
	s = strings.Replace(s, "e-0", "e-", 1)
	s = strings.Replace(s, "e+0", "e+", 1)
	return s
}

// ToFixed is Number(x.toFixed(n)) — rounding to n decimals.
func ToFixed(f float64, n int) float64 {
	s := strconv.FormatFloat(f, 'f', n, 64)
	out, _ := strconv.ParseFloat(s, 64)
	return out
}

// StringList maps an array through String() and drops empty strings
// (`Array.isArray(x) ? x.map(String).filter(Boolean) : []`).
func StringList(v any) []string {
	out := []string{}
	for _, item := range AsArr(v) {
		s := String(item)
		if item == nil {
			s = "null"
		}
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Bind converts a decoded JSON scalar into a value accepted by database/sql,
// mirroring better-sqlite3 (which rejects objects/arrays/booleans; the
// original code never bound those, so they are an input error here).
func Bind(v any) (any, error) {
	switch x := v.(type) {
	case nil:
		return nil, nil
	case string:
		return x, nil
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 9.007199254740992e15 {
			return int64(x), nil
		}
		return x, nil
	case int:
		return int64(x), nil
	case int64:
		return x, nil
	case bool:
		if x {
			return int64(1), nil
		}
		return int64(0), nil
	default:
		return nil, fmt.Errorf("unsupported value type %T", v)
	}
}

// JSONString is JSON.stringify for arbitrary decoded values.
func JSONString(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(sb.String(), "\n")
}

// JSONIndent is JSON.stringify(v, null, 2).
func JSONIndent(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return "null"
	}
	return strings.TrimSuffix(sb.String(), "\n")
}
