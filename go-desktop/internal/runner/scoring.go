package runner

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

// The scoring rules are a faithful port of electron/runner.cjs so that
// results stay comparable with the Electron build. Known weaknesses of the
// legacy boolean/numeric heuristics (documented in
// docs/migration/go-migration-plan.md) are intentionally preserved here;
// changing them requires a versioned evaluator, not a silent port change.

var expectedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)poprawna odpowied[źz]\s+to\s+([^\.\n]+)`),
	regexp.MustCompile(`(?i)odpowied[źz]\s+to\s+([^\.\n]+)`),
	regexp.MustCompile(`(?i)zawiera\s+([^\.\n]+)`),
}

var quoteChars = strings.NewReplacer(`"`, "", "'", "", "`", "")

// ExtractExpectedAnswers mirrors extractExpectedAnswers.
func ExtractExpectedAnswers(b jsv.Obj) []string {
	checklist := ""
	if arr := jsv.AsArr(b["evaluation_checklist"]); arr != nil {
		parts := make([]string, len(arr))
		for i, v := range arr {
			if v == nil {
				parts[i] = ""
			} else {
				parts[i] = jsv.String(v)
			}
		}
		checklist = strings.Join(parts, "\n")
	}
	source := jsv.Str(b["pass_condition"]) + "\n" + checklist
	var out []string
	for _, p := range expectedPatterns {
		if m := p.FindStringSubmatch(source); m != nil && m[1] != "" {
			v := strings.ToLower(strings.TrimSpace(quoteChars.Replace(m[1])))
			if v != "" {
				out = append(out, v)
			}
		}
	}
	return out
}

var (
	takRe     = regexp.MustCompile(`\btak\b`)
	nieRe     = regexp.MustCompile(`\bnie\b`)
	numericRe = regexp.MustCompile(`\b(100|\d{1,2})(?:\s*%)?\b`)
)

// EvaluateBoolean mirrors evaluateBooleanResponse ("" = could not evaluate).
func EvaluateBoolean(b jsv.Obj, response string) string {
	n := strings.ToLower(strings.TrimSpace(response))
	if takRe.MatchString(n) {
		return "tak"
	}
	if nieRe.MatchString(n) {
		return "nie"
	}
	if exp := ExtractExpectedAnswers(b); len(exp) > 0 {
		for _, e := range exp {
			if strings.Contains(n, e) {
				return "tak"
			}
		}
		return "nie"
	}
	return ""
}

// EvaluateNumeric mirrors evaluateNumericResponse (ok=false when no number).
func EvaluateNumeric(response string) (float64, bool) {
	m := numericRe.FindStringSubmatch(response)
	if m == nil {
		return 0, false
	}
	v, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	return math.Max(0, math.Min(100, v)), true
}

const idBoundary = `[^a-z0-9_$]`

func hasExactDeclaration(text, id string) bool {
	q := regexp.QuoteMeta(id)
	pats := []string{
		`(?i)(^|` + idBoundary + `)(?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\s+` + q + `(?:$|` + idBoundary + `)`,
		`(?i)(^|` + idBoundary + `)(?:const|let|var)\s+` + q + `\s*=`,
		`(?i)(^|` + idBoundary + `)(?:public\s+|private\s+|protected\s+|static\s+|final\s+|inline\s+|constexpr\s+|async\s+)*(?:[a-z_$][\w$:<>,\[\]\*&?]*\s+)+` + q + `\s*\(`,
	}
	return anyMatch(pats, text)
}

func hasPrefixedBadDeclaration(text, id string) bool {
	bad := regexp.QuoteMeta(id) + `[a-z0-9_$]+`
	pats := []string{
		`(?i)(^|` + idBoundary + `)(?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\s+` + bad + `(?:$|` + idBoundary + `)`,
		`(?i)(^|` + idBoundary + `)(?:const|let|var)\s+` + bad + `\s*=`,
		`(?i)(^|` + idBoundary + `)(?:public\s+|private\s+|protected\s+|static\s+|final\s+|inline\s+|constexpr\s+|async\s+)*(?:[a-z_$][\w$:<>,\[\]\*&?]*\s+)+` + bad + `\s*\(`,
	}
	return anyMatch(pats, text)
}

func anyMatch(pats []string, text string) bool {
	for _, p := range pats {
		if re, err := regexp.Compile(p); err == nil && re.MatchString(text) {
			return true
		}
	}
	return false
}

var (
	identifierRe  = regexp.MustCompile(`(?i)^[a-z_$][\w$]*$`)
	declarationRe = regexp.MustCompile(`(?i)^((?:def|function|func|fun|fn|class|struct|interface|trait|protocol)\s+)([a-z_$][\w$]*)$`)
	seenWordsRe   = regexp.MustCompile(`(?i)\bwidziane\b|\bseen\b|\bset\s*\(|dict\.fromkeys`)
)

// MatchesRequiredCodeFragment mirrors matchesRequiredCodeFragment (text is
// already lower-cased by the caller, as in the JS).
func MatchesRequiredCodeFragment(text, required string) bool {
	needle := strings.ToLower(strings.TrimSpace(required))
	if needle == "" {
		return false
	}
	if needle == "seen" && seenWordsRe.MatchString(text) {
		return true
	}
	if identifierRe.MatchString(needle) {
		q := regexp.QuoteMeta(needle)
		if regexp.MustCompile(`(?i)\.\s*` + q + `(?:$|` + idBoundary + `)`).MatchString(text) {
			return true
		}
		if hasPrefixedBadDeclaration(text, needle) && !hasExactDeclaration(text, needle) {
			return false
		}
		return regexp.MustCompile(`(?i)(^|` + idBoundary + `)` + q + `(?:$|` + idBoundary + `)`).MatchString(text)
	}
	if m := declarationRe.FindStringSubmatch(needle); m != nil {
		return regexp.MustCompile(`(?i)(^|` + idBoundary + `)` + regexp.QuoteMeta(m[1]) + regexp.QuoteMeta(m[2]) + `(?:$|` + idBoundary + `)`).MatchString(text)
	}
	return strings.Contains(text, needle)
}

// Evaluation is the result of evaluateScore & friends.
type Evaluation struct {
	Score       any // nil, "tak"/"nie", or float64
	Error       string
	IsManual    bool
	NeedsVerify bool
	Passed      any
	Total       any
	Sandbox     any
}

// EvaluateCodePresence mirrors evaluateCodePresenceBenchmark (nil = n/a).
func EvaluateCodePresence(b jsv.Obj, response string) *Evaluation {
	var parsed jsv.Obj
	cond := jsv.Str(b["pass_condition"])
	if cond == "" {
		cond = "{}"
	}
	if json.Unmarshal([]byte(cond), &parsed) != nil || parsed == nil || parsed["mode"] != "code_presence" {
		return nil
	}
	text := strings.ToLower(response)
	if strings.TrimSpace(text) == "" {
		return &Evaluation{Score: 0.0, Error: "The model finished generation without a response.", Passed: 0, Total: 1}
	}
	req := jsv.AsArr(parsed["required"])
	if req == nil {
		return nil
	}
	var required []string
	for _, r := range req {
		s := ""
		if jsv.Truthy(r) {
			s = strings.TrimSpace(jsv.String(r))
		}
		if s != "" {
			required = append(required, s)
		}
	}
	if len(required) == 0 {
		return &Evaluation{Score: 0.0, Error: "The code_presence condition has no required fragments.", Passed: 0, Total: 1}
	}
	var missing []string
	for _, n := range required {
		if !MatchesRequiredCodeFragment(text, n) {
			missing = append(missing, n)
		}
	}
	if len(missing) == 0 {
		return &Evaluation{Score: 100.0, Passed: 1, Total: 1}
	}
	return &Evaluation{Score: 0.0, Error: "Missing required fragments: " + strings.Join(missing, ", "), Passed: 0, Total: 1}
}

// NormalizeBenchmarkScore mirrors normalizeBenchmarkScore (attempt penalty).
func NormalizeBenchmarkScore(b jsv.Obj, score any, attempt, attempts int) any {
	if b["score_type"] == "boolean" {
		return score
	}
	v := jsv.Number(score)
	if math.IsNaN(v) {
		v = 0
	}
	v = math.Max(0, math.Min(100, v))
	return jsRound(v * float64(attempts-attempt+1) / float64(attempts))
}

// jsRound is Math.round (rounds .5 up toward +Inf).
func jsRound(v float64) float64 { return math.Floor(v + 0.5) }

// AggregateBenchmarkScore mirrors aggregateBenchmarkScore (nil = none).
func AggregateBenchmarkScore(b jsv.Obj, scores []any) any {
	var present []any
	for _, s := range scores {
		if s != nil {
			present = append(present, s)
		}
	}
	if len(present) == 0 {
		return nil
	}
	if b["score_type"] == "boolean" {
		for _, s := range present {
			if strings.ToLower(jsv.String(s)) != "tak" {
				return "nie"
			}
		}
		return "tak"
	}
	sum, n := 0.0, 0
	for _, s := range present {
		f := jsv.Number(s)
		if !math.IsNaN(f) {
			sum += f
			n++
		}
	}
	if n == 0 {
		return nil
	}
	return jsv.ToFixed(sum/float64(n), 2)
}

var providedNumber = regexp.MustCompile(`-?\d+(?:[\.,]\d+)?`)

// NormalizeProvidedScore mirrors normalizeProvidedScore (nil = invalid).
func NormalizeProvidedScore(score any, scoreType any) any {
	if score == nil {
		return nil
	}
	text := strings.ToLower(strings.TrimSpace(jsv.String(score)))
	if text == "" {
		return nil
	}
	if scoreType == "boolean" {
		switch text {
		case "tak", "yes", "true", "pass", "passed", "ok", "1":
			return "tak"
		case "nie", "no", "false", "fail", "failed", "0":
			return "nie"
		}
		return nil
	}
	m := providedNumber.FindString(text)
	if m == "" {
		return nil
	}
	f, err := strconv.ParseFloat(strings.Replace(m, ",", ".", 1), 64)
	if err != nil {
		return nil
	}
	return math.Max(0, math.Min(100, f))
}

var zadanie1 = regexp.MustCompile(`(?i)^Zadanie\s+1$`)

// IsStaleLegacyTask mirrors isStaleLegacyTask.
func IsStaleLegacyTask(task, b jsv.Obj, taskCount int) bool {
	if task == nil || b == nil || taskCount <= 1 {
		return false
	}
	tp := strings.TrimSpace(jsv.Str(task["prompt_template"]))
	bp := strings.TrimSpace(jsv.Str(b["prompt_template"]))
	if tp == "" || bp == "" || tp != bp {
		return false
	}
	generic := zadanie1.MatchString(strings.TrimSpace(jsv.Str(task["name"])))
	sameCond := strings.TrimSpace(jsv.Str(task["pass_condition"])) == strings.TrimSpace(jsv.Str(b["pass_condition"]))
	noOwn := !jsv.Truthy(task["expected_answer"]) && !jsv.Truthy(task["pass_condition"]) && len(jsv.AsArr(task["evaluation_checklist"])) == 0
	return generic && (sameCond || noOwn)
}
