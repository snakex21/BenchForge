package sandbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/proc"
)

type call struct {
	name string
	args []string
}

func fakeRuntime(t *testing.T, policy Policy, docker bool) (*Runtime, *[]call) {
	t.Helper()
	paths.SetDataDirForTests(t.TempDir())
	t.Cleanup(func() { paths.SetDataDirForTests("") })
	calls := &[]call{}
	rt := &Runtime{
		Policy: func() Policy { return policy },
		Exec: func(ctx context.Context, name string, args []string, o proc.Options) proc.Result {
			*calls = append(*calls, call{name, args})
			code := 0
			return proc.Result{OK: true, ExitCode: &code, Stdout: "hello"}
		},
		DockerAvailable: func(context.Context) bool { return docker },
	}
	return rt, calls
}

func TestPolicyDefaults(t *testing.T) {
	cases := []struct {
		useDocker, optIn any
		want             Mode
	}{
		{nil, nil, ModeDocker},      // fresh install: Docker
		{true, nil, ModeDocker},     // explicit Docker
		{false, nil, ModeRefused},   // Electron-era "off" is not consent
		{false, true, ModeHost},     // explicit opt-in after the warning
		{"false", true, ModeDocker}, // non-bool garbage keeps the secure default
		{true, true, ModeDocker},
	}
	for _, c := range cases {
		if got := PolicyFromPrefs(c.useDocker, c.optIn).Mode(); got != c.want {
			t.Errorf("PolicyFromPrefs(%v,%v)=%s want %s", c.useDocker, c.optIn, got, c.want)
		}
	}
}

func TestCodeRunsInHardenedDockerByDefault(t *testing.T) {
	rt, calls := fakeRuntime(t, PolicyFromPrefs(nil, nil), true)
	res := rt.Run(context.Background(), jsv.Obj{"tool": "python.run", "input": jsv.Obj{"code": "print(1)"}}, RunOptions{})
	if res["ok"] != true || res["sandbox"] != "docker" {
		t.Fatalf("result %+v", res)
	}
	if len(*calls) != 1 || (*calls)[0].name != "docker" {
		t.Fatalf("calls %+v", *calls)
	}
	args := strings.Join((*calls)[0].args, " ")
	for _, want := range []string{"--network none", "--cap-drop ALL", "no-new-privileges", "--read-only", "--pids-limit", "--memory 512m", "--user 65534:65534", PythonImage} {
		if !strings.Contains(args, want) {
			t.Errorf("docker args lack %q: %s", want, args)
		}
	}
}

func TestModelCannotChooseInterpreterOrDisableDocker(t *testing.T) {
	rt, calls := fakeRuntime(t, PolicyFromPrefs(nil, nil), true)
	rt.Run(context.Background(), jsv.Obj{"tool": "node.run", "input": jsv.Obj{"code": "1", "useDocker": false, "nodePath": `C:\Windows\System32\cmd.exe`, "nodeImage": "evil/image"}}, RunOptions{})
	args := strings.Join((*calls)[0].args, " ")
	if (*calls)[0].name != "docker" || strings.Contains(args, "evil/image") || strings.Contains(args, "cmd.exe") || !strings.Contains(args, NodeImage) {
		t.Fatalf("model input influenced execution: %s %s", (*calls)[0].name, args)
	}
}

func TestHostExecutionRefusedWithoutOptIn(t *testing.T) {
	rt, calls := fakeRuntime(t, PolicyFromPrefs(false, nil), true)
	res := rt.Run(context.Background(), jsv.Obj{"tool": "python.run", "input": jsv.Obj{"code": "import os"}}, RunOptions{})
	if res["ok"] != false || !strings.Contains(jsv.Str(res["stderr"]), "refused") || len(*calls) != 0 {
		t.Fatalf("expected refusal without executing anything: %+v calls=%v", res, *calls)
	}
}

func TestDockerUnavailableDoesNotFallBackToHost(t *testing.T) {
	rt, calls := fakeRuntime(t, PolicyFromPrefs(nil, nil), false)
	res := rt.Run(context.Background(), jsv.Obj{"tool": "node.run", "input": jsv.Obj{"code": "1"}}, RunOptions{})
	if res["ok"] != false || res["sandbox"] != "docker-unavailable" || len(*calls) != 0 {
		t.Fatalf("must not fall back to host: %+v calls=%v", res, *calls)
	}
}

func TestHostExecutionAfterExplicitOptIn(t *testing.T) {
	rt, calls := fakeRuntime(t, PolicyFromPrefs(false, true), false)
	res := rt.Run(context.Background(), jsv.Obj{"tool": "python.run", "input": jsv.Obj{"code": "print(1)"}}, RunOptions{})
	if res["hostExecution"] != true || len(*calls) == 0 || (*calls)[0].name != "python" {
		t.Fatalf("host run %+v %+v", res, *calls)
	}
}

func TestFileToolsAreConfinedToWorkdir(t *testing.T) {
	rt, _ := fakeRuntime(t, PolicyFromPrefs(nil, nil), true)
	ctx := context.Background()
	w := rt.Run(ctx, jsv.Obj{"tool": "file.write", "input": jsv.Obj{"path": "sub/a.txt", "content": "x"}}, RunOptions{})
	if w["ok"] != true {
		t.Fatalf("write %+v", w)
	}
	wd := jsv.Str(w["workdir"])
	for _, p := range []string{"../../escape.txt", `..\..\escape.txt`, `C:\Windows\win.ini`, "/etc/passwd", "sub/../../x"} {
		r := rt.Run(ctx, jsv.Obj{"tool": "file.write", "workdir": wd, "input": jsv.Obj{"path": p, "content": "pwned"}}, RunOptions{})
		if strings.HasPrefix(p, "/") {
			// Leading slashes are stripped (JS behaviour) and stay inside the workdir.
			if r["ok"] != true || !strings.HasPrefix(jsv.Str(r["path"]), "etc/") {
				t.Fatalf("%s: %+v", p, r)
			}
			continue
		}
		if r["ok"] != false {
			t.Fatalf("%s escaped: %+v", p, r)
		}
	}
	// A workdir outside artifacts/ is rejected.
	r := rt.Run(ctx, jsv.Obj{"tool": "file.list", "workdir": "../"}, RunOptions{})
	if r["ok"] != false {
		t.Fatalf("workdir escape: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(paths.Data(), "..", "escape.txt")); err == nil {
		t.Fatal("file written outside the data dir")
	}
}

func TestDrawPathSVGAndClampTimeout(t *testing.T) {
	rt, _ := fakeRuntime(t, PolicyFromPrefs(nil, nil), true)
	r := rt.Run(context.Background(), jsv.Obj{"tool": "image.draw_path_svg", "input": jsv.Obj{"points": []any{[]any{1.0, 2.0}, map[string]any{"x": 3.0, "y": 4.0}, "bad"}}}, RunOptions{})
	if r["ok"] != true || r["points"] != 2 {
		t.Fatalf("svg %+v", r)
	}
	if ClampTimeout(500000.0).Seconds() != 120 || ClampTimeout(nil).Seconds() != 10 || ClampTimeout(-5.0).Seconds() != 10 || ClampTimeout(1.0).Milliseconds() != 100 {
		t.Fatal("timeout clamping")
	}
}
