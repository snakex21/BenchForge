package webui

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler() http.Handler {
	assets := fstest.MapFS{
		"index.html":       {Data: []byte("<html>ok</html>")},
		"assets/index.js":  {Data: []byte("console.log(1)")},
		"assets/style.css": {Data: []byte("body{}")},
	}
	return Handler(assets, 4000, "tok123")
}

func do(h http.Handler, method, target string, mod func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	req.Host = "127.0.0.1:4000"
	if mod != nil {
		mod(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func withCookie(r *http.Request) { r.AddCookie(&http.Cookie{Name: cookieName, Value: "tok123"}) }

func TestIndexNeedsToken(t *testing.T) {
	h := testHandler()
	if rec := do(h, "GET", "/", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := do(h, "GET", "/?t=wrong", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong token: %d", rec.Code)
	}
	rec := do(h, "GET", "/?t=tok123", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("token: %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Set-Cookie"), "HttpOnly") || !strings.Contains(rec.Header().Get("Set-Cookie"), "SameSite=Strict") {
		t.Fatalf("cookie %q", rec.Header().Get("Set-Cookie"))
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "script-src 'self'") || strings.Contains(csp, "http") {
		t.Fatalf("csp %q", csp)
	}
	// Token in the query only unlocks the document, not arbitrary assets.
	if rec := do(h, "GET", "/assets/index.js?t=tok123", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("asset with query token: %d", rec.Code)
	}
	if rec := do(h, "GET", "/assets/index.js", withCookie); rec.Code != http.StatusOK {
		t.Fatalf("asset with cookie: %d", rec.Code)
	}
}

func TestRejectsRebindingCSRFAndMethods(t *testing.T) {
	h := testHandler()
	cases := map[string]func(*http.Request){
		"evil host":       func(r *http.Request) { withCookie(r); r.Host = "evil.example:4000" },
		"localhost alias": func(r *http.Request) { withCookie(r); r.Host = "localhost:4000" },
		"foreign origin":  func(r *http.Request) { withCookie(r); r.Header.Set("Origin", "http://evil.example") },
		"cross-site":      func(r *http.Request) { withCookie(r); r.Header.Set("Sec-Fetch-Site", "cross-site") },
	}
	for name, mod := range cases {
		if rec := do(h, "GET", "/assets/index.js", mod); rec.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, rec.Code)
		}
	}
	if rec := do(h, "POST", "/", withCookie); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d", rec.Code)
	}
	ok := func(r *http.Request) {
		withCookie(r)
		r.Header.Set("Origin", "http://127.0.0.1:4000")
		r.Header.Set("Sec-Fetch-Site", "same-origin")
	}
	if rec := do(h, "GET", "/assets/style.css", ok); rec.Code != http.StatusOK {
		t.Errorf("same-origin: %d", rec.Code)
	}
}

func TestEmbeddedUIPresent(t *testing.T) {
	assets, err := Assets()
	if err != nil {
		t.Fatal(err)
	}
	f, err := assets.Open("index.html")
	if err != nil {
		// CI always builds the UI first; locally `go test` also works without it.
		if os.Getenv("GITHUB_ACTIONS") == "true" {
			t.Fatalf("embedded index.html missing: %v", err)
		}
		t.Skip("UI not built (npm --prefix ../frontend run build:go)")
	}
	f.Close()
}
