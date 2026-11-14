// Command benchforge is the Go + WebView2 desktop host of BenchForge. It
// replaces the Electron main process: the unchanged React UI is embedded
// and served from 127.0.0.1, and window.benchforge / window.db are provided
// by a webview binding instead of Electron IPC.
package main

import (
	"context"
	_ "embed"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	rdebug "runtime/debug"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"

	"github.com/snakex21/benchforge/go-desktop/internal/bridge"
	"github.com/snakex21/benchforge/go-desktop/internal/db"
	"github.com/snakex21/benchforge/go-desktop/internal/migrate"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
	"github.com/snakex21/benchforge/go-desktop/internal/webui"
	"github.com/snakex21/benchforge/go-desktop/internal/winapi"
)

// Windows file properties and the exe icon come from rsrc_windows_amd64.syso,
// generated from winres/versioninfo.json:
//go:generate go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.4.1 -64 -icon=icon.ico -o rsrc_windows_amd64.syso ../../winres/versioninfo.json

// version is set at build time (-X main.version=2.0.0).
var version = "dev"

const preferredPort = 47821

//go:embed icon.ico
var appIcon []byte

type windowHost struct {
	w      webview.WebView
	closed atomic.Bool
}

func (h *windowHost) Emit(event string, payload any) {
	if h.closed.Load() {
		return
	}
	script := bridge.EmitScript(event, payload)
	h.w.Dispatch(func() {
		if !h.closed.Load() {
			h.w.Eval(script)
		}
	})
}

func (h *windowHost) settle(id int64, ok bool, payload any) {
	if h.closed.Load() {
		return
	}
	script := bridge.SettleScript(id, ok, payload)
	h.w.Dispatch(func() {
		if !h.closed.Load() {
			h.w.Eval(script)
		}
	})
}

func (h *windowHost) OnUI(fn func()) {
	if h.closed.Load() {
		return
	}
	done := make(chan struct{})
	h.w.Dispatch(func() {
		defer close(done)
		fn()
	})
	select {
	case <-done:
	case <-time.After(30 * time.Minute):
	}
}

func (h *windowHost) HWND() uintptr { return uintptr(h.w.Window()) }

func (h *windowHost) Quit() {
	h.w.Dispatch(func() { h.w.Terminate() })
}

func main() {
	os.Exit(run())
}

func run() int {
	debug := flag.Bool("debug", false, "enable WebView2 devtools")
	importFrom := flag.String("import-electron", "", "copy benchforge.db and artifacts from a BenchForge 1.x (Electron) data folder, then start")
	flag.Parse()

	dataDir := paths.Data()
	logFile, err := os.OpenFile(filepath.Join(dataDir, "benchforge.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err == nil {
		log.SetOutput(io.MultiWriter(logFile, os.Stderr))
		defer logFile.Close()
		// Unrecovered panics/fatal errors (any goroutine) end up in the log too.
		_ = rdebug.SetCrashOutput(logFile, rdebug.CrashOptions{})
	}
	log.Printf("BenchForge (Go/WebView2) %s starting, data=%s", version, dataDir)
	startedAt := time.Now()

	// Portable WebView2 profile next to the data (patched webview_go reads it).
	if os.Getenv("WEBVIEW_GO_USER_DATA_FOLDER") == "" {
		_ = os.Setenv("WEBVIEW_GO_USER_DATA_FOLDER", filepath.Join(dataDir, "webview2"))
	}

	importElectronData(dataDir, *importFrom)

	store, err := db.Open(filepath.Join(dataDir, "benchforge.db"))
	if err != nil {
		fatal("Could not open the database:\n" + err.Error())
		return 1
	}
	defer store.Close()

	server, err := webui.Start(preferredPort)
	if err != nil {
		fatal("Could not start the UI server:\n" + err.Error())
		return 1
	}
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	w := webview.New(*debug)
	if w == nil {
		fatal("Microsoft Edge WebView2 Runtime is required. Install it from https://developer.microsoft.com/microsoft-edge/webview2/")
		return 1
	}
	host := &windowHost{w: w}
	w.SetTitle("BenchForge")
	w.SetSize(1360, 860, webview.HintNone)
	w.SetSize(960, 600, webview.HintMin)
	setWindowIcon(unsafe.Pointer(w.Window()), appIcon)

	app := NewApp(version, store, host)
	dispatcher := bridge.New(ctx, server.Token)
	app.Register(dispatcher)
	if err := w.Bind("__bf_invoke", func(token string, id float64, channel string, args string) error {
		return dispatcher.Invoke(token, id, channel, args, host.settle)
	}); err != nil {
		fatal("Could not bind the UI bridge: " + err.Error())
		return 1
	}
	w.Init(bridge.InitScript(server.Origin, server.Token, loadStorage()))
	w.Navigate(server.URL)

	var bg sync.WaitGroup
	bg.Add(1)
	go func() {
		defer bg.Done()
		pctx, pcancel := context.WithTimeout(ctx, 60*time.Second)
		defer pcancel()
		if _, err := app.Pricing.RefreshIfStale(pctx); err != nil {
			log.Printf("[pricing] Auto refresh failed: %v", err)
		}
	}()
	log.Printf("window created in %s", time.Since(startedAt))

	w.Run()

	host.closed.Store(true)
	cancel() // aborts a running benchmark
	if err := store.InterruptActiveRunSessions(); err != nil {
		log.Printf("[run_sessions] Failed to mark active sessions interrupted: %v", err)
	}
	waitTimeout(dispatcher.Wait, 5*time.Second)
	waitTimeout(bg.Wait, 2*time.Second)
	w.Destroy()
	log.Printf("BenchForge exited")
	return 0
}

// importElectronData copies a BenchForge 1.x (Electron) database into an
// empty data folder: explicitly with -import-electron, or after a Yes in the
// first-start dialog when a 1.x install is found (BENCHFORGE_NO_IMPORT=1
// skips the question). The 1.x data is only read, never changed.
func importElectronData(dataDir, from string) {
	if from == "" {
		if _, err := os.Stat(filepath.Join(dataDir, migrate.DBName)); err == nil || os.Getenv("BENCHFORGE_NO_IMPORT") == "1" {
			return
		}
		cands := migrate.Candidates(os.Getenv)
		if len(cands) == 0 {
			return
		}
		msg := "BenchForge 1.x data was found in:\n" + cands[0] + "\n\nCopy the benchmarks, models, results and artifacts into this BenchForge?\n" +
			"The original folder is not changed, so the 1.x app keeps working.\n\nNew data folder:\n" + dataDir
		if winapi.MessageBox(0, "BenchForge - import 1.x data", msg, winapi.MBYesNo|winapi.MBIconQuestion|winapi.MBSetForegound) != winapi.IDYes {
			log.Printf("[import] 1.x data at %s not imported (declined)", cands[0])
			return
		}
		from = cands[0]
	}
	rep, err := migrate.Import(from, dataDir)
	if err != nil {
		log.Printf("[import] from %s failed: %v", from, err)
		winapi.MessageBox(0, "BenchForge", "Import of the 1.x data failed:\n"+err.Error(), winapi.MBOK|winapi.MBIconError)
		return
	}
	log.Printf("[import] copied %d files (%d bytes) from %s, artifacts=%v", rep.Files, rep.Bytes, from, rep.Artifacts)
}

func waitTimeout(fn func(), d time.Duration) {
	done := make(chan struct{})
	go func() { fn(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
	}
}

func fatal(msg string) {
	log.Print(msg)
	winapi.MessageBox(0, "BenchForge", msg, winapi.MBOK|winapi.MBIconError)
	fmt.Fprintln(os.Stderr, msg)
}
