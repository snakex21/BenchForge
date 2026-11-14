package reposandbox

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
)

const candidate = "```diff\n" + `diff --git a/calc.py b/calc.py
--- a/calc.py
+++ b/calc.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b
+    return a + b
` + "```\n"

// gitRepo creates a tiny SWE-style repository with a bug in calc.py.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	must := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	must("init", "-q")
	must("config", "core.autocrlf", "false")
	_ = os.WriteFile(filepath.Join(dir, "calc.py"), []byte("def add(a, b):\n    return a - b\n"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "test_calc.py"), []byte("from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n"), 0o644)
	must("add", ".")
	must("commit", "-q", "-m", "init")
	return dir
}

type dockerCall struct{ args []string }

// fakeDocker lets git run for real and plays the container: it checks the
// hardened flags and "runs" the test by reading the mounted, patched copy.
func fakeDocker(t *testing.T, available bool) (*[]dockerCall, *bool) {
	t.Helper()
	paths.SetDataDirForTests(t.TempDir())
	calls := &[]dockerCall{}
	hostShell := new(bool)
	oldExec, oldAvail := Exec, DockerAvailable
	t.Cleanup(func() { Exec, DockerAvailable = oldExec, oldAvail; paths.SetDataDirForTests("") })
	DockerAvailable = func(context.Context) bool { return available }
	Exec = func(ctx context.Context, name string, args []string, o proc.Options) proc.Result {
		if name == "git" {
			return proc.Run(ctx, name, args, o)
		}
		if name != "docker" {
			*hostShell = true
			t.Errorf("unexpected host command %s %v", name, args)
			return proc.Result{}
		}
		*calls = append(*calls, dockerCall{args})
		mount := ""
		for i, a := range args {
			if a == "-v" {
				mount = strings.TrimSuffix(args[i+1], ":/work/repo")
			}
		}
		b, err := os.ReadFile(filepath.Join(filepath.FromSlash(mount), "calc.py"))
		code := 0
		if err != nil || !strings.Contains(string(b), "a + b") {
			code = 1
		}
		return proc.Result{OK: code == 0, ExitCode: &code, Stdout: "1 passed"}
	}
	return calls, hostShell
}

func bench() jsv.Obj {
	return jsv.Obj{"pass_condition": `{"mode":"swe_bench_patch","instance_id":"demo__calc-1","repo":"demo/calc","test_command":"python -m pytest -q"}`}
}

func TestDockerRunsRepoTestsHardened(t *testing.T) {
	repo := gitRepo(t)
	calls, host := fakeDocker(t, true)
	roots := []any{map[string]any{"instanceId": "demo__calc-1", "path": repo, "dockerImage": "benchforge/calc-tests:1"}}
	ev := Evaluate(context.Background(), bench(), candidate, roots, sandbox.PolicyFromPrefs(nil, nil))
	if ev == nil || jsv.Number(ev["score"]) != 100 || ev["error"] != nil {
		t.Fatalf("expected full score, got %v", jsv.JSONIndent(ev))
	}
	if *host || len(*calls) != 1 {
		t.Fatalf("expected exactly one docker run, host=%v calls=%v", *host, *calls)
	}
	joined := strings.Join((*calls)[0].args, " ")
	for _, want := range []string{"--network none", "--cap-drop ALL", "no-new-privileges", "--user 65534:65534", "--memory 2g", "benchforge/calc-tests:1 sh -c python -m pytest -q"} {
		if !strings.Contains(joined, want) {
			t.Errorf("docker args missing %q: %s", want, joined)
		}
	}
	sb := jsv.AsObj(ev["sandbox"])
	if sb["execution"] != "docker" || sb["dockerImage"] != "benchforge/calc-tests:1" {
		t.Fatalf("report: %v", sb)
	}
	// the source repo is untouched
	if b, _ := os.ReadFile(filepath.Join(repo, "calc.py")); !strings.Contains(string(b), "a - b") {
		t.Fatal("source repo was modified")
	}
}

func TestDockerFailingTestsScoreHalf(t *testing.T) {
	repo := gitRepo(t)
	fakeDocker(t, true)
	wrong := strings.Replace(candidate, "+    return a + b", "+    return a * b", 1)
	roots := []any{map[string]any{"repo": "demo/calc", "path": repo}}
	ev := Evaluate(context.Background(), bench(), wrong, roots, sandbox.PolicyFromPrefs(nil, nil))
	if jsv.Number(ev["score"]) != 50 || !strings.Contains(jsv.Str(ev["error"]), "tests=fail") {
		t.Fatalf("got %v", jsv.JSONIndent(ev))
	}
	if img := jsv.AsObj(ev["sandbox"])["dockerImage"]; img != sandbox.PythonImage {
		t.Fatalf("default image = %v", img)
	}
}

func TestDockerUnavailableRunsNothing(t *testing.T) {
	repo := gitRepo(t)
	calls, host := fakeDocker(t, false)
	roots := []any{map[string]any{"repo": "demo/calc", "path": repo}}
	ev := Evaluate(context.Background(), bench(), candidate, roots, sandbox.PolicyFromPrefs(nil, nil))
	if jsv.Number(ev["score"]) != 0 || !strings.Contains(jsv.Str(ev["error"]), "Docker is not available") || len(*calls) != 0 || *host {
		t.Fatalf("got %v calls=%v", ev, *calls)
	}
}

func TestRefusedWithoutDockerOrOptIn(t *testing.T) {
	repo := gitRepo(t)
	calls, _ := fakeDocker(t, true)
	roots := []any{map[string]any{"repo": "demo/calc", "path": repo, "testCommand": "echo pwned"}}
	ev := Evaluate(context.Background(), bench(), candidate, roots, sandbox.PolicyFromPrefs(false, nil))
	if jsv.Number(ev["score"]) != 0 || len(*calls) != 0 {
		t.Fatalf("got %v", ev)
	}
}

func TestInvalidDockerImageRejected(t *testing.T) {
	repo := gitRepo(t)
	calls, _ := fakeDocker(t, true)
	for _, img := range []string{"--privileged", "img; rm -rf /", "UPPER/case"} {
		roots := []any{map[string]any{"repo": "demo/calc", "path": repo, "dockerImage": img}}
		ev := Evaluate(context.Background(), bench(), candidate, roots, sandbox.PolicyFromPrefs(nil, nil))
		if jsv.Number(ev["score"]) != 0 || !strings.Contains(jsv.Str(ev["error"]), "invalid dockerImage") {
			t.Fatalf("%q: got %v", img, ev)
		}
	}
	if len(*calls) != 0 {
		t.Fatal("docker must not run")
	}
}

func TestDockerTimeoutRemovesContainer(t *testing.T) {
	repo := gitRepo(t)
	paths.SetDataDirForTests(t.TempDir())
	oldExec, oldAvail := Exec, DockerAvailable
	t.Cleanup(func() { Exec, DockerAvailable = oldExec, oldAvail; paths.SetDataDirForTests("") })
	DockerAvailable = func(context.Context) bool { return true }
	var removed []string
	Exec = func(ctx context.Context, name string, args []string, o proc.Options) proc.Result {
		if name == "git" {
			return proc.Run(ctx, name, args, o)
		}
		if args[0] == "rm" {
			removed = append(removed, args[2])
			return proc.Result{OK: true}
		}
		o.OnTimeout()
		return proc.Result{TimedOut: true}
	}
	roots := []any{map[string]any{"repo": "demo/calc", "path": repo}}
	ev := Evaluate(context.Background(), bench(), candidate, roots, sandbox.PolicyFromPrefs(nil, nil))
	if jsv.Number(ev["score"]) != 50 || len(removed) != 1 || !strings.HasPrefix(removed[0], "benchforge-repo-") {
		t.Fatalf("score=%v removed=%v", ev["score"], removed)
	}
}
