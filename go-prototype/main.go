package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8787", "loopback address only")
	dir := flag.String("data-dir", "benchforge-go-data", "separate prototype reports directory; never use the legacy database")
	endpoint := flag.String("endpoint", "", "optional local OpenAI-compatible base URL, for example http://127.0.0.1:1234/v1")
	modelNames := flag.String("models", "echo", "comma-separated model IDs available to this run")
	flag.Parse()
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		log.Fatal("-listen must be a loopback IP:port")
	}
	var p Provider = Echo{}
	label := "Offline echo (not an AI model)"
	models := strings.Split(*modelNames, ",")
	for i := range models {
		models[i] = strings.TrimSpace(models[i])
	}
	if *endpoint != "" {
		base, err := localEndpoint(*endpoint)
		if err != nil {
			log.Fatal(err)
		}
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		p = LocalAPI{base, client}
		label = "Local OpenAI-compatible API"
	} else {
		if len(models) != 1 || models[0] != "echo" {
			log.Fatal("offline mode requires -models echo")
		}
	}
	m, err := newManager(*dir, p, label, models)
	if err != nil {
		log.Fatal(err)
	}
	defer m.close()
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	srv := &http.Server{Handler: m.handler(ln.Addr().String()), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	log.Printf("BenchForge experimental text runner: http://%s (loopback only)", ln.Addr())
	if err = srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Print(err)
	}
}
