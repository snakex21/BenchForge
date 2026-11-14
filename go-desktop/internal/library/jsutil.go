package library

// Helpers that reproduce the JavaScript semantics used by the original
// electron/benchmarkLibrary.cjs (truthiness, String(), Number(), trim and
// JSON.stringify with insertion-ordered keys) so the produced data is
// byte-for-byte compatible with what the Electron build generated.

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// undefinedT models JavaScript `undefined` (a missing property).
type undefinedT struct{}

var undef = undefinedT{}

// kv / obj model a JavaScript object literal with insertion-ordered keys.
type kv struct {
	K string
	V any
}

type obj []kv

// field returns v[key] like JS property access, or undef when missing.
func field(v any, key string) any {
	switch m := v.(type) {
	case map[string]any:
		if x, ok := m[key]; ok {
			return x
		}
	case obj:
		for _, e := range m {
			if e.K == key {
				return e.V
			}
		}
	}
	return undef
}

func isArray(v any) bool {
	_, ok := v.([]any)
	return ok
}

func truthy(v any) bool {
	switch x := v.(type) {
	case nil, undefinedT:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	case float32:
		return x != 0 && !math.IsNaN(float64(x))
	case int:
		return x != 0
	case int64:
		return x != 0
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	}
	return true
}

func nullish(v any) bool {
	switch v.(type) {
	case nil, undefinedT:
		return true
	}
	return false
}

// or mimics `a || b || c`: first truthy value, otherwise the last one.
func or(vals ...any) any {
	for _, v := range vals {
		if truthy(v) {
			return v
		}
	}
	if len(vals) == 0 {
		return undef
	}
	return vals[len(vals)-1]
}

// coalesce mimics `a ?? b`.
func coalesce(a, b any) any {
	if nullish(a) {
		return b
	}
	return a
}

func filterTruthy(vals []any) []any {
	out := make([]any, 0, len(vals))
	for _, v := range vals {
		if truthy(v) {
			out = append(out, v)
		}
	}
	return out
}

// jsString mimics String(v) / template literal interpolation.
func jsString(v any) string {
	switch x := v.(type) {
	case undefinedT:
		return "undefined"
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
		return jsNumber(x)
	case float32:
		return jsNumber(float64(x))
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case json.Number:
		if f, err := x.Float64(); err == nil {
			return jsNumber(f)
		}
		return x.String()
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if nullish(e) {
				parts[i] = ""
			} else {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case []string:
		return strings.Join(x, ",")
	case map[string]any, obj:
		return "[object Object]"
	}
	return "[object Object]"
}

// jsNumber formats a float64 the way Number.prototype.toString does.
func jsNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // d.dddde±XX
	mant, expStr, _ := strings.Cut(s, "e")
	exp, _ := strconv.Atoi(expStr)
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := exp + 1
	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		es := "+"
		if e < 0 {
			es = "-"
			e = -e
		}
		if k == 1 {
			out = digits + "e" + es + strconv.Itoa(e)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + es + strconv.Itoa(e)
		}
	}
	return sign + out
}

// jsNumberOf mimics Number(v). Missing values yield NaN.
func jsNumberOf(v any) float64 {
	switch x := v.(type) {
	case undefinedT:
		return math.NaN()
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case float32:
		return float64(x)
	case json.Number:
		return jsNumberOf(x.String())
	case string:
		return parseJSNumberString(x)
	case []any:
		return parseJSNumberString(jsString(x))
	case map[string]any, obj:
		return math.NaN()
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return float64(rv.Int())
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return float64(rv.Uint())
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	}
	return math.NaN()
}

func parseJSNumberString(s string) float64 {
	t := jsTrim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		var base int
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			if strings.Contains(t[2:], "_") {
				return math.NaN()
			}
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	for _, r := range t {
		if !(r >= '0' && r <= '9') && r != '.' && r != 'e' && r != 'E' && r != '+' && r != '-' {
			return math.NaN()
		}
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// jsTrim mimics String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// jsSpaceClass is the JavaScript `\s` character class for Go regexps.
const jsSpaceClass = `[\t\n\x0B\f\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]`

// stringify mimics JSON.stringify(v) (no indentation, insertion order for obj).
func stringify(v any) string {
	var b bytes.Buffer
	writeJSON(&b, v, false)
	return b.String()
}

func writeJSON(b *bytes.Buffer, v any, inArray bool) {
	switch x := v.(type) {
	case undefinedT:
		b.WriteString("null")
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJSString(b, x)
	case float64:
		writeJSNum(b, x)
	case float32:
		writeJSNum(b, float64(x))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case json.Number:
		writeJSNum(b, jsNumberOf(x))
	case obj:
		b.WriteByte('{')
		first := true
		for _, e := range x {
			if _, skip := e.V.(undefinedT); skip {
				continue
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			writeJSString(b, e.K)
			b.WriteByte(':')
			writeJSON(b, e.V, false)
		}
		b.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := make(obj, 0, len(keys))
		for _, k := range keys {
			o = append(o, kv{k, x[k]})
		}
		writeJSON(b, o, false)
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSON(b, e, true)
		}
		b.WriteByte(']')
	case []string:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSString(b, e)
		}
		b.WriteByte(']')
	case []int:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(strconv.Itoa(e))
		}
		b.WriteByte(']')
	default:
		raw, err := json.Marshal(x)
		if err != nil {
			b.WriteString("null")
			return
		}
		b.Write(raw)
	}
}

func writeJSNum(b *bytes.Buffer, f float64) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		b.WriteString("null")
		return
	}
	b.WriteString(jsNumber(f))
}

const hexDigits = "0123456789abcdef"

func writeJSString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[r>>4])
				b.WriteByte(hexDigits[r&0xF])
			} else {
				b.WriteRune(r) // invalid bytes become U+FFFD
			}
		}
	}
	b.WriteByte('"')
}
