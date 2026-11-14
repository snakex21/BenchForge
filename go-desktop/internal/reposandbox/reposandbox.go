// Package reposandbox ports electron/repoSandbox.cjs (SWE-bench style
// "apply the model's patch to a local repo copy and run its tests").
//
// The test command executes code produced by the model (the patched repo).
// With the default Docker policy it runs inside a hardened container
// (no network, all capabilities dropped, resource limits) with only the
// patched repo copy mounted. On the host it runs only after the user
// explicitly enabled host execution. With neither available nothing runs.
// Preparing the copy (git clone/checkout/apply) never executes repo code.
package reposandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

// Exec and DockerAvailable are replaceable in tests.
var (
	Exec            = proc.Run
	DockerAvailable = func(ctx context.Context) bool {
		return proc.Run(ctx, "docker", []string{"version", "--format", "{{.Server.Version}}"}, proc.Options{Timeout: 8 * time.Second}).OK
	}
)

var imagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:@-]{0,254}$`)

const (
	defaultTimeout = 120 * time.Second
	maxTimeout     = 30 * time.Minute
)

// Spec is getRepoSpec.
type Spec struct {
	Mode       string `json:"mode"`
	Repo       any    `json:"repo"`
	InstanceID any    `json:"instance_id"`
	BaseCommit any    `json:"base_commit"`
	TestPatch  any    `json:"test_patch"`
	RefPatch   any    `json:"reference_patch"`
	TestCmd    any    `json:"test_command"`
	TimeoutMs  int64  `json:"timeoutMs"`
	Raw        any    `json:"raw"`
}

func clampMs(v any, def time.Duration) time.Duration {
	f := jsv.Number(jsv.Or(v, float64(def/time.Millisecond)))
	if f != f || f < 1000 {
		f = 1000
	}
	if f > float64(maxTimeout/time.Millisecond) {
		f = float64(maxTimeout / time.Millisecond)
	}
	return time.Duration(f) * time.Millisecond
}

// GetSpec parses the benchmark pass_condition.
func GetSpec(bench jsv.Obj) *Spec {
	var parsed map[string]any
	if json.Unmarshal([]byte(jsv.Str(bench["pass_condition"])), &parsed) != nil || parsed == nil {
		return nil
	}
	mode := jsv.Str(parsed["mode"])
	if mode != "swe_bench_patch" && mode != "repo_patch" {
		return nil
	}
	return &Spec{
		Mode: mode, Repo: jsv.Or(parsed["repo"], parsed["repository"], nil), InstanceID: jsv.Or(parsed["instance_id"], parsed["instanceId"], nil),
		BaseCommit: jsv.Or(parsed["base_commit"], parsed["baseCommit"], nil), TestPatch: jsv.Or(parsed["test_patch"], parsed["testPatch"], nil),
		RefPatch: jsv.Or(parsed["patch"], nil), TestCmd: jsv.Or(parsed["test_command"], parsed["testCommand"], nil),
		TimeoutMs: int64(clampMs(jsv.Or(parsed["timeout_ms"], parsed["timeoutMs"]), defaultTimeout) / time.Millisecond), Raw: parsed,
	}
}

func findConfig(spec *Spec, roots any) jsv.Obj {
	for _, item := range jsv.AsArr(roots) {
		c := jsv.AsObj(item)
		if c == nil {
			continue
		}
		if jsv.Truthy(c["instanceId"]) || jsv.Truthy(c["instance_id"]) {
			if jsv.String(jsv.Or(c["instanceId"], c["instance_id"])) == jsv.Str(spec.InstanceID) {
				return c
			}
			continue
		}
		if jsv.Str(jsv.Or(c["repo"], c["repository"], "")) == jsv.Str(spec.Repo) {
			return c
		}
	}
	return nil
}

var (
	fencedPatch = regexp.MustCompile("(?is)```(?:diff|patch)?\\s*(.*?)```")
	unifiedHead = regexp.MustCompile(`(?m)^---\s+`)
)

// ExtractPatch mirrors extractPatch.
func ExtractPatch(response string) string {
	if m := fencedPatch.FindStringSubmatch(response); m != nil {
		f := strings.TrimSpace(m[1])
		if f != "" && (strings.Contains(f, "diff --git") || (strings.Contains(f, "--- ") && strings.Contains(f, "+++ "))) {
			return f
		}
	}
	if i := strings.Index(response, "diff --git "); i >= 0 {
		return strings.TrimSpace(response[i:])
	}
	if loc := unifiedHead.FindStringIndex(response); loc != nil && strings.Contains(response[loc[0]:], "+++ ") {
		return strings.TrimSpace(response[loc[0]:])
	}
	return ""
}

var unsafeName = regexp.MustCompile(`(?i)[^a-z0-9_.-]+`)

func safeName(v string) string {
	s := strings.Trim(unsafeName.ReplaceAllString(v, "-"), "-")
	if len(s) > 120 {
		s = s[:120]
	}
	if s == "" {
		return "repo"
	}
	return s
}

func rnd() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type cmdResult struct {
	Command    string `json:"command"`
	OK         bool   `json:"ok"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	TimedOut   bool   `json:"timedOut,omitempty"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

func wrap(command string, r proc.Result) cmdResult {
	return cmdResult{Command: command, OK: r.OK, ExitCode: r.ExitCode, TimedOut: r.TimedOut, Stdout: r.Stdout, Stderr: r.Stderr, DurationMs: r.DurationMs}
}

func fail(spec *Spec, msg, short string) jsv.Obj {
	return jsv.Obj{"score": 0, "error": msg, "passed": 0, "total": 2, "allow_partial": true,
		"sandbox": jsv.Obj{"version": 3, "type": "repo_patch", "ok": false, "score": 0, "spec": spec, "error": short}}
}

// Evaluate runs the repo sandbox; returns nil when the benchmark is not a
// repo-patch benchmark or no local repo is configured (same as the JS).
func Evaluate(ctx context.Context, bench jsv.Obj, response string, roots any, policy sandbox.Policy) jsv.Obj {
	spec := GetSpec(bench)
	if spec == nil {
		return nil
	}
	cfg := findConfig(spec, roots)
	if cfg == nil || !jsv.Truthy(cfg["path"]) {
		return nil
	}
	mode := policy.Mode()
	switch mode {
	case sandbox.ModeDocker:
		if DockerAvailable != nil && !DockerAvailable(ctx) {
			return fail(spec, "Repo sandbox: Docker is not available. Repository tests run model-modified code, so they need Docker (start Docker Desktop) or an explicit host-execution opt-in in Settings. Nothing was run.", "docker unavailable")
		}
	case sandbox.ModeHost:
	default:
		return fail(spec, "Repo sandbox: running repository tests executes model-modified code. Enable the Docker sandbox, or explicitly opt in to host execution (Settings: disable Docker sandbox and confirm the warning). Nothing was run.", "host execution not enabled")
	}
	image := ""
	if mode == sandbox.ModeDocker {
		image = jsv.Str(jsv.Or(cfg["dockerImage"], cfg["docker_image"], ""))
		if image != "" && !imagePattern.MatchString(image) {
			return fail(spec, "Repo sandbox: invalid dockerImage "+image, "invalid docker image")
		}
	}
	source, _ := filepath.Abs(jsv.String(cfg["path"]))
	if st, err := os.Stat(source); err != nil || !st.IsDir() {
		return fail(spec, "Repo sandbox: path does not exist: "+source, "missing repo path")
	}
	patch := ExtractPatch(response)
	if patch == "" {
		return fail(spec, "Repo sandbox: no patch/diff found in model response.", "no patch found")
	}
	timeout := clampMs(jsv.Or(cfg["timeoutMs"], cfg["timeout_ms"], float64(spec.TimeoutMs)), defaultTimeout)
	id := safeName(jsv.Str(jsv.Or(spec.Repo, spec.InstanceID, "repo"))) + "-" + strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")) + "-" + rnd()
	rel := "artifacts/repo-sandbox/" + id
	abs := paths.ResolveData(rel)
	if abs == "" {
		return fail(spec, "Repo sandbox: invalid workdir", "invalid workdir")
	}
	_ = os.MkdirAll(abs, 0o755)
	repoDir := filepath.Join(abs, "repo")
	// ExtractPatch trims the text; git apply reports "corrupt patch" when
	// the last hunk line has no newline (a bug in the Electron version).
	_ = os.WriteFile(filepath.Join(abs, "candidate.patch"), []byte(patch+"\n"), 0o644)
	if jsv.Truthy(spec.TestPatch) {
		_ = os.WriteFile(filepath.Join(abs, "test.patch"), []byte(jsv.String(spec.TestPatch)), 0o644)
	}
	env := []string{"BENCHFORGE_REPO_SANDBOX=1", "NO_PROXY=*", "no_proxy=*"}
	o := proc.Options{Timeout: timeout, Env: env}
	commands := []cmdResult{}

	clone := Exec(ctx, "git", []string{"clone", "--no-hardlinks", source, repoDir}, o)
	commands = append(commands, wrap("git clone --no-hardlinks "+source, clone))
	if !clone.OK {
		if err := copyTree(source, repoDir); err != nil {
			commands = append(commands, cmdResult{Command: "fs.copyRecursive fallback", Stderr: err.Error()})
			sb := jsv.Obj{"version": 3, "type": "repo_patch", "ok": false, "score": 0, "spec": spec, "workdir": rel, "repoDir": rel + "/repo", "commands": commands}
			_ = os.WriteFile(filepath.Join(abs, "repo-sandbox-report.json"), []byte(jsv.JSONIndent(sb)), 0o644)
			return jsv.Obj{"score": 0, "error": "Repo sandbox: failed to prepare repository.", "passed": 0, "total": 2, "allow_partial": true, "sandbox": sb}
		}
		commands = append(commands, cmdResult{Command: "fs.copyRecursive fallback", OK: true})
	}
	if base := jsv.Str(spec.BaseCommit); base != "" && !strings.HasPrefix(base, "-") {
		if _, err := os.Stat(filepath.Join(repoDir, ".git")); err == nil {
			od := o
			od.Dir = repoDir
			commands = append(commands, wrap("git checkout --force "+base, Exec(ctx, "git", []string{"checkout", "--force", base}, od)))
			commands = append(commands, wrap("git clean -fdx", Exec(ctx, "git", []string{"clean", "-fdx"}, od)))
		}
	}
	od := o
	od.Dir = repoDir
	apply := func(file, label string) cmdResult {
		first := Exec(ctx, "git", []string{"apply", "--whitespace=nowarn", file}, od)
		if first.OK {
			return wrap("git apply "+label, first)
		}
		second := Exec(ctx, "git", []string{"apply", "--reject", "--whitespace=nowarn", file}, od)
		r := wrap("git apply --reject "+label, second)
		r.Stdout = strings.TrimSpace(first.Stdout + "\n" + second.Stdout)
		r.Stderr = strings.TrimSpace(first.Stderr + "\n" + second.Stderr)
		r.DurationMs = first.DurationMs + second.DurationMs
		return r
	}
	patchResult := apply(filepath.Join(abs, "candidate.patch"), "candidate.patch")
	commands = append(commands, patchResult)
	if jsv.Truthy(spec.TestPatch) {
		commands = append(commands, apply(filepath.Join(abs, "test.patch"), "test.patch"))
	}
	testCommand := detectTestCommand(repoDir, cfg, spec)
	var testResult *cmdResult
	if patchResult.OK && testCommand != "" {
		var r cmdResult
		if mode == sandbox.ModeDocker {
			if image == "" {
				image = defaultImage(testCommand)
			}
			name := "benchforge-repo-" + rnd() + rnd()
			dr := Exec(ctx, "docker", DockerArgs(name, repoDir, image, testCommand), proc.Options{Timeout: timeout, OnTimeout: func() {
				_ = Exec(context.Background(), "docker", []string{"rm", "-f", name}, proc.Options{Timeout: 15 * time.Second})
			}})
			r = wrap("docker ("+image+"): "+testCommand, dr)
		} else {
			r = wrap(testCommand, proc.RunShell(ctx, testCommand, od))
		}
		testResult = &r
		commands = append(commands, r)
	}
	testsOK := testResult != nil && testResult.OK
	score := 0
	if patchResult.OK {
		score = 50
	}
	if testCommand != "" && testsOK {
		score += 50
	}
	total, passed := 1, 0
	if testCommand != "" {
		total = 2
	}
	if patchResult.OK {
		passed++
	}
	if testCommand != "" && testsOK {
		passed++
	}
	ok := patchResult.OK && (testCommand == "" || testsOK)
	tests := []jsv.Obj{{"index": 1, "test": "git apply candidate.patch", "passed": patchResult.OK, "error": errOrNil(patchResult.OK, patchResult.Stderr, patchResult.Stdout, "patch failed")}}
	if testCommand != "" {
		var e any = "tests failed"
		if testResult != nil {
			e = errOrNil(testsOK, testResult.Stderr, testResult.Stdout, "tests failed")
		}
		tests = append(tests, jsv.Obj{"index": 2, "test": testCommand, "passed": testsOK, "error": e})
	}
	var outs, errs []string
	for _, c := range commands {
		outs = append(outs, "# "+c.Command+"\n"+c.Stdout)
		errs = append(errs, "# "+c.Command+"\n"+c.Stderr)
	}
	var tc any
	if testCommand != "" {
		tc = testCommand
	}
	sb := jsv.Obj{
		"version": 3, "type": "repo_patch", "ok": ok, "score": score, "passed": passed, "total": total, "spec": spec,
		"config":    jsv.Obj{"repo": jsv.Or(cfg["repo"], cfg["repository"], spec.Repo), "path": source, "testCommand": tc},
		"execution": string(mode), "dockerImage": image,
		"workdir": rel, "repoDir": rel + "/repo", "patchApplied": patchResult.OK, "testsRun": testCommand != "", "testsPassed": testsOK,
		"commands": commands, "tests": tests, "stdout": strings.Join(outs, "\n\n"), "stderr": strings.Join(errs, "\n\n"),
	}
	_ = os.WriteFile(filepath.Join(abs, "repo-sandbox-report.json"), []byte(jsv.JSONIndent(sb)), 0o644)
	var errMsg any
	if !ok {
		p := "fail"
		if patchResult.OK {
			p = "ok"
		}
		t := " tests=not configured"
		if testCommand != "" {
			t = " tests=fail"
			if testsOK {
				t = " tests=ok"
			}
		}
		errMsg = fmt.Sprintf("Repo sandbox failed: patch=%s%s", p, t)
	}
	return jsv.Obj{"score": score, "error": errMsg, "passed": passed, "total": total, "allow_partial": true, "sandbox": sb}
}

// defaultImage picks a stock image when the repo config has no dockerImage.
// Stock images have no project dependencies and there is no network, so
// real projects should set dockerImage to an image with their test deps.
func defaultImage(testCommand string) string {
	c := strings.ToLower(testCommand)
	if strings.Contains(c, "npm") || strings.Contains(c, "node") || strings.Contains(c, "yarn") || strings.Contains(c, "pnpm") {
		return sandbox.NodeImage
	}
	return sandbox.PythonImage
}

// DockerArgs builds the hardened `docker run` for a repo test command. Only
// the patched copy is mounted; the network is off.
func DockerArgs(name, repoDir, image, testCommand string) []string {
	return []string{
		"run", "--rm", "--name", name,
		"--network", "none",
		"--cap-drop", "ALL",
		"--security-opt", "no-new-privileges",
		"--pids-limit", "512",
		"--memory", "2g", "--memory-swap", "2g",
		"--cpus", "2",
		"--tmpfs", "/tmp:rw,exec,size=512m",
		"--user", "65534:65534",
		"-e", "HOME=/tmp", "-e", "BENCHFORGE_REPO_SANDBOX=1",
		"-v", paths.ToPosix(repoDir) + ":/work/repo", "-w", "/work/repo",
		image, "sh", "-c", testCommand,
	}
}

func errOrNil(ok bool, a, b, def string) any {
	if ok {
		return nil
	}
	if a != "" {
		return a
	}
	if b != "" {
		return b
	}
	return def
}

func detectTestCommand(repoDir string, cfg jsv.Obj, spec *Spec) string {
	if v := jsv.Or(cfg["testCommand"], cfg["test_command"]); jsv.Truthy(v) {
		return jsv.String(v)
	}
	if jsv.Truthy(spec.TestCmd) {
		return jsv.String(spec.TestCmd)
	}
	for _, f := range []string{"pytest.ini", "pyproject.toml", "setup.cfg"} {
		if _, err := os.Stat(filepath.Join(repoDir, f)); err == nil {
			return "python -m pytest"
		}
	}
	if _, err := os.Stat(filepath.Join(repoDir, "package.json")); err == nil {
		return "npm test"
	}
	return ""
}

var skipDirs = map[string]bool{"node_modules": true, ".venv": true, "venv": true, "__pycache__": true, ".pytest_cache": true, ".mypy_cache": true, "dist": true, "build": true, ".next": true}

func copyTree(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if skipDirs[e.Name()] || e.Type()&os.ModeSymlink != 0 {
			continue
		}
		s, d := filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyTree(s, d); err != nil {
				return err
			}
			continue
		}
		in, err := os.Open(s)
		if err != nil {
			return err
		}
		out, err := os.Create(d)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
