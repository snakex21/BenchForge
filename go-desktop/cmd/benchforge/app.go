package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/artifacts"
	"github.com/snakex21/benchforge/go-desktop/internal/bridge"
	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/envcheck"
	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/library"
	"github.com/snakex21/benchforge/go-desktop/internal/mcp"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/pricing"
	"github.com/snakex21/benchforge/go-desktop/internal/providers"
	"github.com/snakex21/benchforge/go-desktop/internal/radar"
	"github.com/snakex21/benchforge/go-desktop/internal/runner"
	"github.com/snakex21/benchforge/go-desktop/internal/sandbox"
	"github.com/snakex21/benchforge/go-desktop/internal/secrets"
	"github.com/snakex21/benchforge/go-desktop/internal/updater"
	"github.com/snakex21/benchforge/go-desktop/internal/winapi"
)

type Obj = jsv.Obj

// Host is what the handlers need from the window (fakeable in tests).
type Host interface {
	Emit(event string, payload any)
	// OnUI runs fn on the UI thread and waits (native modal dialogs).
	OnUI(fn func())
	HWND() uintptr
	Quit()
}

// App holds the backend state shared by all bridge handlers.
type App struct {
	Version string
	Store   *db.Store
	Runtime *sandbox.Runtime
	Runner  *runner.Runner
	Pricing *pricing.Service
	Radar   *radar.Radar
	Library library.Fetcher
	Updater *updater.Updater
	Host    Host

	// Dialogs/shell are indirections so tests never open real windows.
	SaveDialog func(title, defaultName, filterName, ext string) (string, bool, error)
	OpenDialog func(title, filterName, ext string) (string, bool, error)
	Confirm    func(title, text string) bool
	ShellOpen  func(target string) error

	runMu     sync.Mutex
	runCancel context.CancelFunc

	storageMu sync.Mutex
}

// NewApp wires the backend.
func NewApp(version string, store *db.Store, host Host) *App {
	a := &App{Version: version, Store: store, Host: host, Updater: updater.New()}
	a.Runtime = sandbox.New(a.policy)
	a.Runner = &runner.Runner{Store: store, Runtime: a.Runtime, Policy: a.policy}
	a.Pricing = pricing.New(store)
	a.Radar = radar.New(radar.NewHTTPFetcher(&http.Client{Timeout: 15 * time.Second}))
	a.Library = library.NewHTTPFetcher(&http.Client{Timeout: 90 * time.Second})
	a.SaveDialog = func(title, name, filter, ext string) (string, bool, error) {
		var p string
		var ok bool
		var err error
		host.OnUI(func() { p, ok, err = winapi.SaveFile(host.HWND(), title, name, filter, ext) })
		return p, ok, err
	}
	a.OpenDialog = func(title, filter, ext string) (string, bool, error) {
		var p string
		var ok bool
		var err error
		host.OnUI(func() { p, ok, err = winapi.OpenFile(host.HWND(), title, filter, ext) })
		return p, ok, err
	}
	a.Confirm = func(title, text string) bool {
		var ok bool
		host.OnUI(func() { ok = winapi.ConfirmWarning(host.HWND(), title, text) })
		return ok
	}
	a.ShellOpen = winapi.ShellOpen
	return a
}

func (a *App) policy() sandbox.Policy {
	return sandbox.PolicyFromPrefs(a.Store.Pref(sandbox.PrefUseDocker), a.Store.Pref(sandbox.PrefHostOptIn))
}

func (a *App) githubToken() string {
	if t, ok := a.Store.Pref("github_token").(string); ok && strings.TrimSpace(t) != "" {
		return strings.TrimSpace(t)
	}
	if t := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); t != "" {
		return t
	}
	return strings.TrimSpace(os.Getenv("GH_TOKEN"))
}

func (a *App) emit(event string, payload any) {
	if a.Host != nil {
		a.Host.Emit(event, payload)
	}
}

// Register installs every IPC channel of electron/main.cjs (+ internal ones).
func (a *App) Register(d *bridge.Dispatcher) {
	type H = bridge.Handler
	reg := func(ch string, h H) { d.Handle(ch, h) }

	// ---- app ----
	reg("app:get-meta", func(ctx context.Context, _ bridge.Args) (any, error) {
		return Obj{"name": "BenchForge", "version": a.Version, "platform": "win32", "dataPath": paths.Data()}, nil
	})
	reg("app:get-data-path", func(ctx context.Context, _ bridge.Args) (any, error) { return paths.Data(), nil })
	reg("app:open-data-path", func(ctx context.Context, _ bridge.Args) (any, error) {
		return a.openResult(a.ShellOpen(paths.Data())), nil
	})
	reg("app:open-external", func(ctx context.Context, args bridge.Args) (any, error) {
		target, err := args.Str(0, 4096, false)
		if err != nil {
			return nil, err
		}
		u, perr := url.Parse(target)
		if perr != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" || u.User != nil {
			return Obj{"ok": false, "error": "Only HTTPS URLs are allowed."}, nil
		}
		return a.openResult(a.ShellOpen(u.String())), nil
	})

	// ---- updates (fixed repo + mandatory SHA256) ----
	reg("updates:check", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		if err := updater.CheckRepo(p["repo"]); err != nil {
			return nil, err
		}
		return a.Updater.Latest(ctx, a.githubToken(), a.Version)
	})
	reg("updates:download", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		if err := updater.CheckRepo(p["repo"]); err != nil {
			return nil, err
		}
		rel, err := a.Updater.Latest(ctx, a.githubToken(), a.Version)
		if err != nil {
			return nil, err
		}
		asset, err := updater.SelectAsset(rel, jsv.Str(p["assetName"]), jsv.Str(jsv.Or(p["kind"], "zip")))
		if err != nil {
			return nil, err
		}
		ext := strings.TrimPrefix(filepath.Ext(asset.Name), ".")
		target, ok, err := a.SaveDialog("Download BenchForge update", asset.Name, "BenchForge release asset", ext)
		if err != nil {
			return nil, err
		}
		if !ok {
			return Obj{"canceled": true}, nil
		}
		return a.Updater.DownloadTo(ctx, rel, asset, target, a.githubToken())
	})
	reg("updates:apply-portable", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		if err := updater.CheckRepo(p["repo"]); err != nil {
			return nil, err
		}
		if a.Version == "dev" && os.Getenv("BENCHFORGE_ALLOW_DEV_UPDATE") != "1" {
			return nil, errors.New("Portable self-update is only available in packaged builds.")
		}
		rel, err := a.Updater.Latest(ctx, a.githubToken(), a.Version)
		if err != nil {
			return nil, err
		}
		asset, err := updater.SelectAsset(rel, jsv.Str(p["assetName"]), "zip")
		if err != nil {
			return nil, err
		}
		dataDir := paths.Data()
		downloaded, err := a.Updater.DownloadTo(ctx, rel, asset, filepath.Join(dataDir, "updates", "downloads", asset.Name), a.githubToken())
		if err != nil {
			return nil, err
		}
		exe, _ := os.Executable()
		plan, err := updater.PreparePortable(dataDir, exe)
		if err != nil {
			return nil, err
		}
		appDir := paths.AppBase()
		if err := plan.Launch(appDir, downloaded.FilePath); err != nil {
			return nil, err
		}
		time.AfterFunc(750*time.Millisecond, func() {
			if a.Host != nil {
				a.Host.Quit()
			}
		})
		return Obj{"ok": true, "willQuit": true, "appDir": appDir, "dataDir": dataDir, "scriptPath": plan.ScriptPath, "logPath": plan.LogPath, "downloaded": downloaded}, nil
	})

	// ---- pricing ----
	reg("pricing:status", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Pricing.Status(), nil })
	reg("pricing:refresh-openrouter", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Pricing.Refresh(ctx) })

	// ---- files ----
	reg("files:save-json", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		name := jsv.Str(jsv.Or(p["defaultFileName"], fmt.Sprintf("benchforge-results-%d.json", time.Now().UnixMilli())))
		return a.saveText("Export BenchForge results", name, "JSON", "json", jsv.Str(p["content"]))
	})
	reg("files:save-text", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		ext := jsv.Str(jsv.Or(p["extension"], "txt"))
		if !regexp.MustCompile(`^[A-Za-z0-9]{1,10}$`).MatchString(ext) {
			return nil, bridge.Errf("invalid extension")
		}
		name := jsv.Str(jsv.Or(p["defaultFileName"], "benchforge-output."+ext))
		return a.saveText("Save model response", name, jsv.Str(jsv.Or(p["extensionLabel"], "File")), ext, jsv.Str(p["content"]))
	})
	reg("files:open-json", func(ctx context.Context, _ bridge.Args) (any, error) {
		path, ok, err := a.OpenDialog("Import BenchForge data", "JSON", "json")
		if err != nil {
			return nil, err
		}
		if !ok {
			return Obj{"canceled": true}, nil
		}
		st, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if st.Size() > bridge.MaxArgsBytes {
			return nil, errors.New("file is too large to import")
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		return Obj{"canceled": false, "filePath": path, "content": string(b)}, nil
	})
	reg("files:open-path", func(ctx context.Context, args bridge.Args) (any, error) {
		rel, err := args.Str(0, 1024, false)
		if err != nil {
			return nil, err
		}
		abs := artifacts.Resolve(rel)
		if abs == "" || !strings.HasPrefix(paths.ToPosix(rel), "artifacts/") {
			return Obj{"ok": false, "error": "Invalid artifact path."}, nil
		}
		return a.openResult(a.ShellOpen(abs)), nil
	})
	reg("files:export-artifact-zip", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		rel := jsv.Str(p["relativePath"])
		if artifacts.Resolve(rel) == "" {
			return nil, errors.New("Artifact path does not exist")
		}
		name := jsv.Str(jsv.Or(p["defaultFileName"], fmt.Sprintf("benchforge-artifacts-%d.zip", time.Now().UnixMilli())))
		target, ok, err := a.SaveDialog("Export BenchForge artifacts", name, "ZIP", "zip")
		if err != nil {
			return nil, err
		}
		if !ok {
			return Obj{"canceled": true}, nil
		}
		n, err := artifacts.ZipDirectory(rel, target)
		if err != nil {
			return nil, err
		}
		return Obj{"canceled": false, "filePath": target, "files": n}, nil
	})

	// ---- library / radar ----
	reg("benchmark-library:list", func(ctx context.Context, _ bridge.Args) (any, error) { return library.ListPacks(), nil })
	reg("benchmark-library:download", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		id, _ := p["id"].(string)
		if id == "" || len(id) > 128 {
			return nil, bridge.Errf("id is required")
		}
		return library.DownloadPack(ctx, a.Library, id, p)
	})
	reg("benchmark-radar:scan", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.Radar.Scan(ctx, p, a.githubToken())
	})
	reg("benchmark-radar:discover", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.Radar.Discover(ctx, p, a.githubToken())
	})

	// ---- tools / env / health / mcp ----
	reg("tools:list", func(ctx context.Context, _ bridge.Args) (any, error) { return sandbox.ToolDefs, nil })
	reg("tools:run", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		// The renderer cannot pick interpreters/images/Docker either.
		if in := jsv.AsObj(p["input"]); in != nil {
			for _, k := range []string{"useDocker", "pythonPath", "nodePath", "pythonImage", "nodeImage"} {
				delete(in, k)
			}
		}
		for _, k := range []string{"useDocker", "pythonPath", "nodePath", "pythonImage", "nodeImage", "mcpServers", "servers"} {
			delete(p, k)
		}
		return a.Runtime.Run(ctx, p, sandbox.RunOptions{MCPServers: a.Store.Pref("mcp_servers")}), nil
	})
	reg("env:check", func(ctx context.Context, _ bridge.Args) (any, error) { return envcheck.Check(ctx), nil })
	reg("health:check", func(ctx context.Context, _ bridge.Args) (any, error) { return a.healthCheck(ctx) })
	reg("mcp:servers:get", func(ctx context.Context, _ bridge.Args) (any, error) {
		return jsv.Or(a.Store.Pref("mcp_servers"), []any{}), nil
	})
	reg("mcp:servers:save", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		servers := []any{}
		if arr := jsv.AsArr(p["servers"]); arr != nil {
			if len(arr) > 100 {
				return nil, bridge.Errf("too many MCP servers")
			}
			for _, s := range arr {
				if jsv.AsObj(s) == nil {
					return nil, bridge.Errf("MCP server entries must be objects")
				}
			}
			servers = arr
		}
		if err := a.Store.SavePreference("mcp_servers", servers); err != nil {
			return nil, err
		}
		return jsv.Or(a.Store.Pref("mcp_servers"), []any{}), nil
	})
	reg("mcp:tools:list", func(ctx context.Context, _ bridge.Args) (any, error) {
		return mcp.ListTools(ctx, a.Store.Pref("mcp_servers")), nil
	})
	reg("mcp:tool:call", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return mcp.CallTool(ctx, a.Store.Pref("mcp_servers"), jsv.Str(p["serverId"]), jsv.Str(p["toolName"]), jsv.Or(p["arguments"], map[string]any{}))
	})

	// ---- models ----
	reg("db:models:get", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetModels() })
	reg("db:models:add", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		if err := validateModel(p, true); err != nil {
			return nil, err
		}
		return a.Store.AddModel(p)
	})
	reg("db:models:update", a.idData(func(id int64, data Obj) (any, error) {
		if err := validateModel(data, false); err != nil {
			return nil, err
		}
		return a.Store.UpdateModel(id, data)
	}))
	reg("db:models:delete", a.idOnly(func(id int64) (any, error) { return a.Store.DeleteModel(id) }))
	reg("db:discovered-models:get", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.Store.GetDiscoveredModels(jsv.Str(p["provider"]))
	})

	// ---- provider configs ----
	reg("db:provider-configs:get-all", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetAllProviderConfigs() })
	reg("db:provider-configs:get", func(ctx context.Context, args bridge.Args) (any, error) {
		name, err := args.Str(0, 200, true)
		if err != nil {
			return nil, err
		}
		return a.Store.GetProviderConfig(name)
	})
	reg("db:provider-configs:save", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		name, _ := p["provider"].(string)
		if strings.TrimSpace(name) == "" || len(name) > 200 {
			return nil, bridge.Errf("provider is required")
		}
		data := jsv.AsObj(p["data"])
		if data == nil {
			data = Obj{}
		}
		if err := validateURLField(data, "base_url"); err != nil {
			return nil, err
		}
		return a.Store.SaveProviderConfig(name, data)
	})
	reg("db:provider-configs:delete", func(ctx context.Context, args bridge.Args) (any, error) {
		name, err := args.Str(0, 200, true)
		if err != nil {
			return nil, err
		}
		return a.Store.DeleteProviderConfig(name)
	})

	// ---- benchmarks & tasks ----
	reg("db:benchmarks:get", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetBenchmarks() })
	reg("db:benchmarks:add", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		if err := validateBenchmark(p); err != nil {
			return nil, err
		}
		return a.Store.AddBenchmark(p)
	})
	reg("db:benchmarks:update", a.idData(func(id int64, data Obj) (any, error) {
		if err := validateScoreType(data); err != nil {
			return nil, err
		}
		return a.Store.UpdateBenchmark(id, data)
	}))
	reg("db:benchmarks:delete", a.idOnly(func(id int64) (any, error) { return a.Store.DeleteBenchmark(id) }))
	reg("db:tasks:get", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		id, err := bridge.ID(p, "benchmarkId")
		if err != nil {
			return nil, err
		}
		return a.Store.GetTasks(id)
	})
	reg("db:tasks:add", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		if _, err := bridge.ID(p, "benchmarkId"); err != nil {
			return nil, err
		}
		if st := p["scoreType"]; st != "numeric" && st != "boolean" {
			return nil, bridge.Errf("scoreType must be numeric or boolean")
		}
		return a.Store.AddTask(p)
	})
	reg("db:tasks:update", a.idData(func(id int64, data Obj) (any, error) {
		if st, ok := data["scoreType"]; ok && st != "numeric" && st != "boolean" {
			return nil, bridge.Errf("scoreType must be numeric or boolean")
		}
		return a.Store.UpdateTask(id, data)
	}))
	reg("db:tasks:delete", a.idOnly(func(id int64) (any, error) { return a.Store.DeleteTask(id) }))
	reg("db:tasks:reorder", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		bid, err := bridge.ID(p, "benchmarkId")
		if err != nil {
			return nil, err
		}
		ids, err := bridge.IDList(p["orderedIds"], "orderedIds", 100000)
		if err != nil {
			return nil, err
		}
		return a.Store.ReorderTasks(bid, ids)
	})

	// ---- results / runs / sessions ----
	reg("db:results:get", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetResults() })
	reg("db:results:add", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		if _, err := bridge.ID(p, "model_id"); err != nil {
			return nil, err
		}
		if _, err := bridge.ID(p, "benchmark_id"); err != nil {
			return nil, err
		}
		return a.Store.AddResult(p)
	})
	reg("db:results:delete", a.idOnly(func(id int64) (any, error) { return a.Store.DeleteResult(id) }))
	reg("db:results:clear", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.ClearResultsData() })
	reg("db:results:rebuild-artifacts", func(ctx context.Context, _ bridge.Args) (any, error) {
		n, err := a.Store.EnsureResultArtifacts()
		return Obj{"created": n}, err
	})
	reg("db:runs:get", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetRuns() })
	reg("db:runs:add", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.Store.AddRun(p)
	})
	reg("db:runs:update", a.idData(func(id int64, data Obj) (any, error) { return a.Store.UpdateRun(id, data) }))
	reg("run-session:create", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		if _, err := bridge.ID(p, "model_id"); err != nil {
			return nil, err
		}
		if _, err := bridge.IDList(p["benchmark_ids"], "benchmark_ids", 10000); err != nil {
			return nil, err
		}
		return a.Store.CreateRunSession(p)
	})
	reg("run-session:get-active", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetActiveRunSession() })
	reg("run-session:update", a.idData(func(id int64, data Obj) (any, error) { return a.Store.UpdateRunSession(id, data) }))
	reg("run-session:finish", a.idOnly(func(id int64) (any, error) { return a.Store.FinishRunSession(id) }))
	reg("run-session:cancel", a.idOnly(func(id int64) (any, error) { return a.Store.CancelRunSession(id) }))

	// ---- export / import ----
	reg("db:export-all", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.GetAllData() })
	reg("db:clear-all", func(ctx context.Context, _ bridge.Args) (any, error) { return a.Store.ClearAllData() })
	reg("db:import-all", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		return a.Store.ReplaceAllData(p)
	})

	// ---- preferences ----
	reg("db:preference:set", func(ctx context.Context, args bridge.Args) (any, error) {
		key, err := args.Str(0, 200, true)
		if err != nil {
			return nil, err
		}
		value := args.Arg(1)
		if key == sandbox.PrefHostOptIn {
			return nil, bridge.Errf("%s can only be changed through the confirmation dialog", key)
		}
		if key == sandbox.PrefUseDocker {
			return nil, a.setSandboxDocker(value)
		}
		return nil, a.Store.SavePreference(key, value)
	})
	reg("db:preference:get", func(ctx context.Context, args bridge.Args) (any, error) {
		key, err := args.Str(0, 200, true)
		if err != nil {
			return nil, err
		}
		if key == sandbox.PrefUseDocker {
			return a.policy().UseDocker, nil // unset means Docker (new secure default)
		}
		return a.Store.Pref(key), nil
	})

	// ---- models: connection, scan, prompt, judge ----
	reg("model:test-connection", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		var model Obj
		if id, _ := bridge.OptID(p, "modelId"); id != nil {
			if model, err = a.Store.GetEffectiveModelConfig(id); err != nil {
				return nil, err
			}
		} else {
			model = jsv.AsObj(p["modelConfig"])
		}
		if model == nil {
			return Obj{"ok": false, "error": "Model configuration was not found."}, nil
		}
		prov, err := providers.Get(jsv.Str(model["mode"]))
		if err != nil {
			return nil, err
		}
		ok, msg := prov.TestConnection(ctx, model)
		var e any
		if !ok {
			e = msg
		}
		return Obj{"ok": ok, "error": e}, nil
	})
	reg("models:scan", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.scanModels(ctx, p)
	})
	reg("model:send-prompt", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		id, err := bridge.ID(p, "modelId")
		if err != nil {
			return nil, err
		}
		model, err := a.Store.GetEffectiveModelConfig(id)
		if err != nil {
			return nil, err
		}
		if model == nil {
			return nil, errors.New("Model was not found.")
		}
		prov, err := providers.Get(jsv.Str(model["mode"]))
		if err != nil {
			return nil, err
		}
		res, err := prov.SendPrompt(ctx, model, jsv.Str(p["prompt"]), "")
		if err != nil {
			return nil, err
		}
		return Obj{"response": res.Response, "tokens_used": res.TokensUsed, "input_tokens": res.InputTokens, "output_tokens": res.OutputTokens, "is_manual": res.Response == providers.ManualResponse}, nil
	})
	reg("judge:evaluate", func(ctx context.Context, args bridge.Args) (any, error) { return a.judge(ctx, args), nil })

	// ---- benchmark runs ----
	reg("benchmark:run", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		mid, err1 := bridge.ID(p, "modelId")
		bid, err2 := bridge.ID(p, "benchmarkId")
		if err := errors.Join(err1, err2); err != nil {
			return nil, err
		}
		res, err := a.Runner.RunBenchmark(ctx, mid, bid)
		if err != nil {
			return Obj{"score": nil, "response": nil, "tokens_used": nil, "is_manual": false, "error": err.Error()}, nil
		}
		return res, nil
	})
	reg("benchmark:run-streaming", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		mid, err1 := bridge.ID(p, "modelId")
		bid, err2 := bridge.ID(p, "benchmarkId")
		sid, err3 := bridge.OptID(p, "sessionId")
		taskIDs, err4 := bridge.IDList(p["taskIds"], "taskIds", 100000)
		if err := errors.Join(err1, err2, err3, err4); err != nil {
			return Obj{"started": false, "error": err.Error()}, nil
		}
		a.runMu.Lock()
		if a.runCancel != nil {
			a.runMu.Unlock()
			return Obj{"started": false, "error": "A benchmark is already running."}, nil
		}
		runCtx, cancel := context.WithCancel(ctx)
		a.runCancel = cancel
		a.runMu.Unlock()
		go func() {
			defer func() {
				a.runMu.Lock()
				a.runCancel = nil
				a.runMu.Unlock()
				cancel()
			}()
			a.Runner.RunStreaming(runCtx, mid, bid, func(ev string, payload Obj) { a.emit(ev, payload) }, sid, taskIDs)
		}()
		return Obj{"started": true}, nil
	})
	reg("benchmark:abort", func(ctx context.Context, _ bridge.Args) (any, error) {
		a.runMu.Lock()
		if a.runCancel != nil {
			a.runCancel()
		}
		a.runMu.Unlock()
		a.emit("benchmark:aborted", Obj{})
		return Obj{"ok": true}, nil
	})
	reg("benchmark:submit-manual", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		b, err := a.Store.GetBenchmarkByID(p["benchmarkId"])
		if err != nil || b == nil {
			return Obj{"ok": false, "resultId": nil, "error": "Benchmark was not found."}, nil
		}
		res, err := a.Store.AddResult(Obj{"model_id": p["modelId"], "benchmark_id": p["benchmarkId"], "task_id": jsv.Or(p["taskId"], nil),
			"run_session_id": jsv.Or(p["runSessionId"], p["sessionId"], nil), "score": p["score"], "notes": p["response"],
			"thinking_notes": jsv.Or(p["thinkingNotes"], p["thinking_notes"], nil)})
		if err != nil {
			return Obj{"ok": false, "resultId": nil, "error": err.Error()}, nil
		}
		return Obj{"ok": true, "resultId": res["id"], "error": nil}, nil
	})
	reg("benchmark:submit-manual-streaming", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		var task Obj
		if jsv.Truthy(p["taskId"]) {
			task, _ = a.Store.GetTaskByID(p["taskId"])
		}
		benchmarkID := jsv.Or(p["benchmarkId"], task["benchmark_id"], nil)
		if !jsv.Truthy(benchmarkID) {
			return Obj{"ok": false, "resultId": nil, "error": "Benchmark for the manual task was not found."}, nil
		}
		attempt := jsv.Or(p["attemptNumber"], 1.0)
		res, err := a.Store.AddResult(Obj{"model_id": p["modelId"], "benchmark_id": benchmarkID, "task_id": jsv.Or(p["taskId"], nil),
			"run_session_id": jsv.Or(p["runSessionId"], p["sessionId"], nil), "score": p["score"], "notes": p["response"],
			"thinking_notes": jsv.Or(p["thinkingNotes"], p["thinking_notes"], nil), "attempt_number": attempt,
			"tokens_used": jsv.Coalesce(p["tokensUsed"], p["tokens_used"]), "duration_ms": jsv.Coalesce(p["durationMs"], p["duration_ms"])})
		if err != nil {
			return Obj{"ok": false, "resultId": nil, "error": err.Error()}, nil
		}
		a.emit("task:done", Obj{"benchmarkId": benchmarkID, "taskId": jsv.Or(p["taskId"], nil), "score": p["score"], "response": p["response"], "attemptNumber": attempt, "is_manual": true, "resultId": res["id"]})
		return Obj{"ok": true, "resultId": res["id"], "error": nil}, nil
	})
	reg("benchmark:submit-manual-batch", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return a.Runner.SubmitManualBatch(ctx, p)
	})

	// ---- internal ----
	reg("internal:storage-sync", func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, true)
		if err != nil {
			return nil, err
		}
		return nil, a.saveStorage(p)
	})
}

func (a *App) openResult(err error) Obj {
	if err != nil {
		return Obj{"ok": false, "error": err.Error()}
	}
	return Obj{"ok": true, "error": nil}
}

func (a *App) saveText(title, name, filterName, ext, content string) (any, error) {
	target, ok, err := a.SaveDialog(title, name, filterName, ext)
	if err != nil {
		return nil, err
	}
	if !ok {
		return Obj{"canceled": true}, nil
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return nil, err
	}
	return Obj{"canceled": false, "filePath": target}, nil
}

func (a *App) idOnly(fn func(int64) (any, error)) bridge.Handler {
	return func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		id, err := bridge.ID(p, "id")
		if err != nil {
			return nil, err
		}
		return fn(id)
	}
}

func (a *App) idData(fn func(int64, Obj) (any, error)) bridge.Handler {
	return func(ctx context.Context, args bridge.Args) (any, error) {
		p, err := args.Obj(0, false)
		if err != nil {
			return nil, err
		}
		id, err := bridge.ID(p, "id")
		if err != nil {
			return nil, err
		}
		data, err := bridge.Data(p, "data")
		if err != nil {
			return nil, err
		}
		return fn(id, data)
	}
}

func validateURLField(o Obj, key string) error {
	v, ok := o[key]
	if !ok || !jsv.Truthy(v) {
		return nil
	}
	s, isStr := v.(string)
	if !isStr || len(s) > 2048 {
		return bridge.Errf("%s must be a URL", key)
	}
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return bridge.Errf("%s must be an http(s) URL", key)
	}
	return nil
}

func validateModel(o Obj, create bool) error {
	if create {
		if name, _ := o["name"].(string); strings.TrimSpace(name) == "" {
			return bridge.Errf("name is required")
		}
		if m := o["mode"]; m != "api" && m != "manual" {
			return bridge.Errf("mode must be api or manual")
		}
	} else if m, ok := o["mode"]; ok && m != "api" && m != "manual" {
		return bridge.Errf("mode must be api or manual")
	}
	return validateURLField(o, "base_url")
}

func validateScoreType(o Obj) error {
	for _, k := range []string{"score_type", "scoreType"} {
		if v, ok := o[k]; ok && v != nil && v != "numeric" && v != "boolean" {
			return bridge.Errf("%s must be numeric or boolean", k)
		}
	}
	return nil
}

func validateBenchmark(o Obj) error {
	if name, _ := o["name"].(string); strings.TrimSpace(name) == "" {
		return bridge.Errf("name is required")
	}
	if c, _ := o["category"].(string); strings.TrimSpace(c) == "" {
		return bridge.Errf("category is required")
	}
	return validateScoreType(o)
}

// setSandboxDocker handles the Settings toggle. Turning Docker off asks for
// explicit confirmation of host execution (native warning dialog).
func (a *App) setSandboxDocker(value any) error {
	on := jsv.Truthy(value)
	if on {
		if err := a.Store.SavePreference(sandbox.PrefHostOptIn, false); err != nil {
			return err
		}
		return a.Store.SavePreference(sandbox.PrefUseDocker, true)
	}
	if !a.Confirm("BenchForge: run AI-generated code on this computer?", sandbox.HostWarning) {
		// Keep Docker; the UI toggle re-reads the preference on next load.
		return errors.New("Docker sandbox stays enabled (host execution was not confirmed).")
	}
	if err := a.Store.SavePreference(sandbox.PrefHostOptIn, true); err != nil {
		return err
	}
	return a.Store.SavePreference(sandbox.PrefUseDocker, false)
}

// storagePath stores the UI's localStorage snapshot.
func storagePath() string { return filepath.Join(paths.Data(), "webview-localstorage.json") }

func (a *App) saveStorage(snap Obj) error {
	out := map[string]string{}
	total := 0
	for k, v := range snap {
		s, ok := v.(string)
		if !ok || len(k) > 256 {
			continue
		}
		total += len(k) + len(s)
		if total > 5<<20 {
			return errors.New("localStorage snapshot too large")
		}
		out[k] = s
	}
	b, _ := json.Marshal(out)
	a.storageMu.Lock()
	defer a.storageMu.Unlock()
	tmp := storagePath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, storagePath())
}

func loadStorage() map[string]string {
	b, err := os.ReadFile(storagePath())
	if err != nil {
		return nil
	}
	out := map[string]string{}
	if json.Unmarshal(b, &out) != nil {
		return nil
	}
	return out
}

func (a *App) judge(ctx context.Context, args bridge.Args) Obj {
	p, err := args.Obj(0, true)
	if err != nil {
		return Obj{"ok": false, "error": err.Error()}
	}
	model, err := a.Store.GetEffectiveModelConfig(p["modelId"])
	if err != nil {
		return Obj{"ok": false, "error": err.Error()}
	}
	if model == nil {
		return Obj{"ok": false, "error": "Judge model was not found."}
	}
	prov, err := providers.Get(jsv.Str(model["mode"]))
	if err != nil {
		return Obj{"ok": false, "error": err.Error()}
	}
	var checklist []string
	for _, item := range jsv.AsArr(p["checklist"]) {
		checklist = append(checklist, "- "+jsv.String(item))
	}
	prompt := "Evaluate the model response as a judge. Return ONLY JSON: {\"score\":0-100,\"passed\":true/false,\"reason\":\"...\"}.\n\nBenchmark/task:\n" +
		jsv.Str(p["taskPrompt"]) + "\n\nChecklist:\n" + strings.Join(checklist, "\n") + "\n\nResponse to evaluate:\n" + jsv.Str(p["response"])
	res, err := prov.SendPrompt(ctx, model, prompt, "")
	if err != nil {
		return Obj{"ok": false, "error": err.Error()}
	}
	var parsed any
	text := res.Response
	if m := regexp.MustCompile(`(?s)\{.*\}`).FindString(text); m != "" {
		text = m
	}
	if json.Unmarshal([]byte(text), &parsed) != nil {
		parsed = nil
	}
	if parsed == nil {
		parsed = Obj{"score": nil, "passed": nil, "reason": res.Response}
	}
	return Obj{"ok": true, "raw": res.Response, "tokens_used": res.TokensUsed, "result": parsed}
}

func (a *App) healthCheck(ctx context.Context) (any, error) {
	env := envcheck.Check(ctx)
	models, err := a.Store.GetModels()
	if err != nil {
		return nil, err
	}
	local := map[string]bool{"lmstudio": true, "ollama": true, "vllm": true}
	var remote, missing []string
	hasLocal, hasManual := false, false
	for _, m := range models {
		if m["mode"] == "manual" {
			hasManual = true
		}
		if m["mode"] != "api" {
			continue
		}
		prov := jsv.Str(m["provider"])
		if local[prov] {
			hasLocal = true
			continue
		}
		if prov == "" {
			continue
		}
		remote = append(remote, jsv.Str(m["name"]))
		if strings.TrimSpace(jsv.Str(m["api_key"])) != "" {
			continue
		}
		pc, _ := a.Store.GetProviderConfig(prov)
		if pc == nil || strings.TrimSpace(jsv.Str(pc["api_key"])) == "" {
			missing = append(missing, jsv.Str(m["name"]))
		}
	}
	checks := []Obj{}
	var dockerOK bool
	for _, c := range env["checks"].([]jsv.Obj) {
		c2 := Obj{"group": "environment"}
		for k, v := range c {
			c2[k] = v
		}
		if c["label"] == "Docker" {
			dockerOK = c["ok"] == true
		}
		checks = append(checks, c2)
	}
	ss := secrets.GetStatus()
	var ssErr any
	if !ss.OK {
		ssErr = "Windows DPAPI is unavailable; API keys cannot be stored securely."
	}
	checks = append(checks, Obj{"label": "Secret Store", "group": "security", "ok": ss.OK, "required": false, "version": ss.Backend, "error": ssErr})
	keysVersion := "No remote API models configured"
	if len(remote) > 0 {
		keysVersion = fmt.Sprintf("%d/%d remote API model keys present", len(remote)-len(missing), len(remote))
	}
	var keysErr any
	if len(missing) > 0 {
		keysErr = "Missing keys: " + strings.Join(missing, ", ")
	}
	checks = append(checks, Obj{"label": "API keys", "group": "models", "ok": len(missing) == 0, "required": false, "version": keysVersion, "error": keysErr})
	localVersion := "No local/manual model configured"
	if hasLocal {
		localVersion = "Local runtime model configured"
	} else if hasManual {
		localVersion = "Manual model configured"
	}
	checks = append(checks, Obj{"label": "Local model runtimes", "group": "models", "ok": hasLocal || hasManual, "required": false, "version": localVersion})
	pol := a.policy()
	sbVersion, sbOK := "Docker sandbox enabled (default)", dockerOK
	var sbErr any
	switch pol.Mode() {
	case sandbox.ModeDocker:
		if !dockerOK {
			sbErr = "Docker sandbox is enabled but Docker is unavailable; model code will not be executed."
		}
	case sandbox.ModeHost:
		sbVersion, sbOK = "Docker disabled: model code runs ON THE HOST (explicit opt-in)", false
		sbErr = "Host execution is enabled. Model-generated code can access your files."
	default:
		sbVersion, sbOK = "Docker disabled, host execution not confirmed: code execution refused", false
		sbErr = "Enable the Docker sandbox to run code benchmarks."
	}
	checks = append(checks, Obj{"label": "Docker sandbox preference", "group": "sandbox", "ok": sbOK, "required": false, "version": sbVersion, "error": sbErr})
	mcpServers := jsv.AsArr(a.Store.Pref("mcp_servers"))
	checks = append(checks, Obj{"label": "MCP servers", "group": "mcp", "ok": len(mcpServers) > 0, "required": false, "version": fmt.Sprintf("%d configured", len(mcpServers))})
	roots := jsv.AsArr(a.Store.Pref("repo_sandbox_roots"))
	checks = append(checks, Obj{"label": "Repo Sandbox", "group": "sandbox", "ok": len(roots) > 0, "required": false, "version": fmt.Sprintf("%d repo roots configured", len(roots))})
	judge := a.Store.Pref("judge_model_id")
	judgeOK := false
	judgeVersion := "Not configured"
	if f, ok := judge.(float64); ok {
		judgeVersion = "Model #" + jsv.FormatNumber(f)
		for _, m := range models {
			if jsv.Number(m["id"]) == f {
				judgeOK = true
			}
		}
	}
	checks = append(checks, Obj{"label": "Judge model", "group": "judge", "ok": judgeOK, "required": false, "version": judgeVersion})
	tok := a.githubToken() != ""
	tokVersion := "Not configured"
	if tok {
		tokVersion = "Configured"
	}
	checks = append(checks, Obj{"label": "GitHub Radar token", "group": "radar", "ok": tok, "required": false, "version": tokVersion})
	ok := true
	for _, c := range checks {
		if c["required"] == true && c["ok"] != true {
			ok = false
		}
	}
	return Obj{"ok": ok, "checks": checks}, nil
}

var defaultScanEndpoints = []Obj{
	{"key": "lmstudio", "name": "LMStudio", "url": "http://localhost:1234/v1", "type": "openai"},
	{"key": "ollama", "name": "Ollama", "url": "http://localhost:11434", "type": "ollama"},
	{"key": "vllm", "name": "vLLM", "url": "http://localhost:8000/v1", "type": "openai"},
}

func normalizeScanURL(u, suffix string) string {
	t := strings.TrimSuffix(u, "/")
	if suffix == "" {
		return t
	}
	if suffix == "/api/tags" {
		t = regexp.MustCompile(`(?i)/v1$`).ReplaceAllString(t, "")
	}
	if strings.HasSuffix(t, "/models") || strings.HasSuffix(t, "/api/tags") {
		return t
	}
	return t + suffix
}

func endpointKey(e Obj) string {
	return jsv.Str(jsv.Or(e["key"], strings.ToLower(jsv.Str(e["name"])), "custom"))
}

func (a *App) scanEndpoint(ctx context.Context, e Obj) ([]string, string, error) {
	isOllama := e["type"] == "ollama" || regexp.MustCompile(`(?i)ollama`).MatchString(jsv.Str(e["name"])) || strings.Contains(jsv.Str(e["url"]), "11434")
	if jsv.Truthy(e["scanUnsupported"]) {
		return []string{}, "", nil
	}
	if jsv.Truthy(e["requiresApiKey"]) && !jsv.Truthy(e["apiKey"]) {
		return []string{}, "missing API key", nil
	}
	suffix := "/models"
	if isOllama {
		suffix = "/api/tags"
	}
	if s := jsv.Str(e["scanPath"]); s != "" {
		suffix = s
	}
	target := normalizeScanURL(jsv.Str(e["url"]), suffix)
	pu, err := url.Parse(target)
	if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
		return nil, "", errors.New("endpoint URL must be http(s)")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, "", err
	}
	if key := jsv.Str(e["apiKey"]); key != "" {
		switch e["authType"] {
		case "anthropic":
			req.Header.Set("x-api-key", key)
			req.Header.Set("anthropic-version", "2023-06-01")
		case "google":
			req.Header.Set("x-goog-api-key", key)
		default:
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}
	c, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(c))
	if err != nil {
		if c.Err() != nil {
			return nil, "", errors.New("This operation was aborted")
		}
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, "", fmt.Errorf("%d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	var payload Obj
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&payload); err != nil {
		return nil, "", err
	}
	models := []string{}
	if isOllama {
		for _, m := range jsv.AsArr(payload["models"]) {
			if n := jsv.Str(jsv.AsObj(m)["name"]); n != "" {
				models = append(models, n)
			}
		}
		return models, "", nil
	}
	if data := jsv.AsArr(payload["data"]); data != nil {
		for _, m := range data {
			o := jsv.AsObj(m)
			if n := jsv.Str(jsv.Or(o["id"], o["name"])); n != "" {
				models = append(models, n)
			}
		}
		return models, "", nil
	}
	for _, m := range jsv.AsArr(payload["models"]) {
		var n string
		if o := jsv.AsObj(m); o != nil {
			n = jsv.Str(jsv.Or(o["id"], o["name"]))
		} else {
			n = jsv.Str(m)
		}
		if n = strings.TrimPrefix(n, "models/"); n != "" {
			models = append(models, n)
		}
	}
	return models, "", nil
}

func (a *App) scanModels(ctx context.Context, p Obj) (any, error) {
	var endpoints []Obj
	if arr := jsv.AsArr(p["endpoints"]); len(arr) > 0 {
		if len(arr) > 50 {
			return nil, bridge.Errf("too many endpoints")
		}
		for _, e := range arr {
			o := jsv.AsObj(e)
			if o == nil {
				return nil, bridge.Errf("endpoints must be objects")
			}
			endpoints = append(endpoints, Obj{"key": jsv.Or(o["key"], strings.ToLower(jsv.Str(o["name"]))), "name": o["name"], "url": o["url"], "type": o["type"],
				"apiKey": o["apiKey"], "scanPath": o["scanPath"], "authType": o["authType"], "scanUnsupported": o["scanUnsupported"], "requiresApiKey": o["requiresApiKey"]})
		}
	} else {
		endpoints = defaultScanEndpoints
	}
	result := Obj{"lmstudio": []string{}, "ollama": []string{}, "vllm": []string{}}
	errs := Obj{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	scanned := map[string]bool{}
	for _, e := range endpoints {
		scanned[endpointKey(e)] = true
	}
	for _, e := range endpoints {
		wg.Add(1)
		go func(e Obj) {
			defer wg.Done()
			key := endpointKey(e)
			models, skipped, err := a.scanEndpoint(ctx, e)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if _, ok := result[key]; !ok {
					result[key] = []string{}
				}
				errs[key] = err.Error()
				log.Printf("[models:scan] FAIL: %s - %v", key, err)
				return
			}
			if skipped != "" {
				if _, ok := result[key]; !ok {
					result[key] = []string{}
				}
				return
			}
			result[key] = models
			var items []db.Discovered
			for _, m := range models {
				items = append(items, db.Discovered{Provider: key, ModelID: m, BaseURL: jsv.Str(e["url"])})
			}
			if err := a.Store.SaveDiscoveredModels(items); err != nil {
				log.Printf("[models:scan] save: %v", err)
			}
		}(e)
	}
	wg.Wait()
	cached, err := a.Store.GetDiscoveredModels("")
	if err != nil {
		return nil, err
	}
	for _, item := range cached {
		prov := jsv.Str(item["provider"])
		if scanned[prov] {
			continue
		}
		existing, _ := result[prov].([]string)
		seen := map[string]bool{}
		var merged []string
		for _, m := range append(existing, jsv.Str(item["modelId"])) {
			if !seen[m] {
				seen[m] = true
				merged = append(merged, m)
			}
		}
		result[prov] = merged
	}
	result["errors"] = errs
	return result, nil
}
