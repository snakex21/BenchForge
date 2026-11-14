//go:build windows

package winapi

import "testing"

func TestFilterStringIsDoubleNulTerminated(t *testing.T) {
	f := filterString("JSON", "json")
	if len(f) < 4 || f[len(f)-1] != 0 || f[len(f)-2] != 0 {
		t.Fatalf("filter not double-NUL terminated: %v", f)
	}
	zeros := 0
	for _, c := range f {
		if c == 0 {
			zeros++
		}
	}
	if zeros != 5 {
		t.Fatalf("expected 4 separators + final NUL, got %d", zeros)
	}
}

func TestSanitizeFileName(t *testing.T) {
	cases := map[string]string{`..\..\evil.exe`: "evil.exe", `a:b*c?.zip`: "a_b_c_.zip", "ok.json": "ok.json", "..": "file"}
	for in, want := range cases {
		if got := SanitizeFileName(in); got != want {
			t.Errorf("%q => %q want %q", in, got, want)
		}
	}
}
