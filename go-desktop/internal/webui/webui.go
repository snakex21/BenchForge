// Package webui serves the embedded, unchanged React build (frontend/ built
// with `vite build --mode go`) to the WebView2 window from 127.0.0.1.
//
// The server only serves static files: there is no API endpoint (the UI
// talks to Go through webview bindings), so a malicious local web page can
// at most read public UI assets. Still, like the Czarna Mapa host it
// enforces:
//   - Host must be exactly 127.0.0.1:<port>   (DNS rebinding)
//   - Origin, when present, must be our origin
//   - Sec-Fetch-Site, when present, must be same-origin/none (CSRF, embedding)
//   - GET/HEAD only, and a per-session token on the index document request
//     (`/?t=<token>`; assets are only served after the token was presented
//     once, via an HttpOnly SameSite=Strict cookie)
//   - a strict CSP: no remote scripts, styles, fonts, frames or connections.
package webui

import (
	"crypto/rand"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

//go:embed all:dist
var dist embed.FS

// CSP for the UI. 'unsafe-inline' styles are required by the existing React
// components (inline style props); images may be data:/blob: (base64 maze
// references, generated SVG previews) but never remote.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
	"font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; object-src 'none'; frame-src 'self' blob: data:; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const cookieName = "bf_session"

// Server is the running static server.
type Server struct {
	URL    string // http://127.0.0.1:<port>/?t=<token>
	Origin string
	Token  string
	srv    *http.Server
	ln     net.Listener
}

// Assets returns the embedded UI file system.
func Assets() (fs.FS, error) { return fs.Sub(dist, "dist") }

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Start listens on 127.0.0.1:preferredPort (a stable origin keeps the UI's
// localStorage) and falls back to a random port.
func Start(preferredPort int) (*Server, error) {
	assets, err := Assets()
	if err != nil {
		return nil, err
	}
	if _, err := fs.Stat(assets, "index.html"); err != nil {
		return nil, errors.New("embedded UI is missing: build it with `npm --prefix frontend run build:go` before `go build`")
	}
	var ln net.Listener
	if preferredPort > 0 {
		ln, err = net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(preferredPort))
	}
	if ln == nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
	}
	token, err := newToken()
	if err != nil {
		ln.Close()
		return nil, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	s := &Server{Origin: fmt.Sprintf("http://127.0.0.1:%d", port), Token: token, ln: ln}
	s.URL = s.Origin + "/?t=" + token
	s.srv = &http.Server{Handler: Handler(assets, port, token), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() {
		if err := s.srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[webui] server: %v", err)
		}
	}()
	return s, nil
}

// Close stops the server.
func (s *Server) Close() error {
	if s == nil || s.srv == nil {
		return nil
	}
	return s.srv.Close()
}

func forbidden(w http.ResponseWriter, r *http.Request, reason string) {
	log.Printf("[webui][security] rejected %s %s: %s (Host=%q Origin=%q)", r.Method, r.URL.Path, reason, r.Host, r.Header.Get("Origin"))
	http.Error(w, "Forbidden", http.StatusForbidden)
}

// Handler builds the guarded static handler (exported for tests).
func Handler(assets fs.FS, port int, token string) http.Handler {
	host := fmt.Sprintf("127.0.0.1:%d", port)
	origin := "http://" + host
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != host {
			forbidden(w, r, "bad Host")
			return
		}
		if o := r.Header.Get("Origin"); o != "" && o != origin {
			forbidden(w, r, "foreign Origin")
			return
		}
		if sfs := r.Header.Get("Sec-Fetch-Site"); sfs != "" && sfs != "same-origin" && sfs != "none" {
			forbidden(w, r, "cross-site request")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		authorized := false
		if c, err := r.Cookie(cookieName); err == nil && subtle.ConstantTimeCompare([]byte(c.Value), []byte(token)) == 1 {
			authorized = true
		}
		if t := r.URL.Query().Get("t"); t != "" && subtle.ConstantTimeCompare([]byte(t), []byte(token)) == 1 && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			authorized = true
		}
		if !authorized {
			forbidden(w, r, "missing session token")
			return
		}
		h := w.Header()
		h.Set("Content-Security-Policy", CSP)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			h.Set("Cache-Control", "private, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-store")
		}
		files.ServeHTTP(w, r)
	})
}
