// Package updater replaces electron/updateChecker.cjs + portableUpdater.cjs.
//
// Differences from the Electron build (security fixes):
//   - The GitHub repository is a compile-time constant. A `repo` sent by the
//     UI is ignored if it matches and rejected otherwise.
//   - Every download must be verified against the release's SHA256SUMS.txt.
//     A release without a checksum file, an asset missing from it or a hash
//     mismatch aborts the download and nothing is written to the target.
//   - Downloads only come from GitHub hosts over HTTPS (redirects included)
//     and are size-limited.
package updater

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
)

// Repo is the only repository updates are taken from.
const Repo = "snakex21/BenchForge"

const (
	maxAssetBytes    = 512 << 20
	maxChecksumBytes = 1 << 20
	maxAPIBytes      = 8 << 20
)

// Updater talks to the GitHub Releases API.
type Updater struct {
	Client  *http.Client
	APIBase string // https://api.github.com
	// AllowedHosts are the hosts downloads (and redirects) may use.
	AllowedHosts map[string]bool
	// RequireHTTPS can be disabled only by tests (httptest servers).
	RequireHTTPS bool
}

// New returns an updater for production use.
func New() *Updater {
	u := &Updater{
		APIBase:      "https://api.github.com",
		RequireHTTPS: true,
		AllowedHosts: map[string]bool{
			"api.github.com": true, "github.com": true,
			"objects.githubusercontent.com": true, "release-assets.githubusercontent.com": true,
			"github-releases.githubusercontent.com": true,
		},
	}
	u.Client = &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return u.checkURL(req.URL)
	}}
	return u
}

func (u *Updater) checkURL(p *url.URL) error {
	if u.RequireHTTPS && p.Scheme != "https" {
		return fmt.Errorf("refusing non-HTTPS update URL %s", p.Redacted())
	}
	if p.User != nil || !u.AllowedHosts[strings.ToLower(p.Hostname())] {
		return fmt.Errorf("refusing update URL on host %q", p.Hostname())
	}
	return nil
}

// ErrRepoNotAllowed is returned when the UI asks for another repository.
var ErrRepoNotAllowed = errors.New("Updates are only downloaded from " + Repo + "; the repository cannot be changed from the UI.")

// CheckRepo validates an optional `repo` coming from the UI.
func CheckRepo(requested any) error {
	if requested == nil || requested == "" {
		return nil
	}
	if s, ok := requested.(string); ok && strings.EqualFold(strings.TrimSpace(s), Repo) {
		return nil
	}
	return ErrRepoNotAllowed
}

func normalizeVersion(v string) string {
	return strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(v), "v"), "V")
}

var versionSplit = regexp.MustCompile(`[.-]`)

// CompareVersions mirrors compareVersions.
func CompareVersions(a, b string) int {
	pa := versionSplit.Split(normalizeVersion(a), -1)
	pb := versionSplit.Split(normalizeVersion(b), -1)
	n := max(len(pa), len(pb), 3)
	num := func(p []string, i int) int {
		if i >= len(p) {
			return 0
		}
		s := p[i]
		j := 0
		for j < len(s) && s[j] >= '0' && s[j] <= '9' {
			j++
		}
		v, _ := strconv.Atoi(s[:j])
		return v
	}
	for i := 0; i < n; i++ {
		if d := num(pa, i) - num(pb, i); d != 0 {
			if d > 0 {
				return 1
			}
			return -1
		}
	}
	return 0
}

func (u *Updater) get(ctx context.Context, rawURL, token string, accept string) (*http.Response, error) {
	p, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	if err := u.checkURL(p); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "BenchForge-Portable-Updater")
	req.Header.Set("Accept", accept)
	if token != "" && strings.EqualFold(p.Hostname(), "api.github.com") {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return u.Client.Do(req)
}

type statusError struct {
	status int
	text   string
}

func (e *statusError) Error() string { return e.text }

// Asset is a release asset.
type Asset struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	DownloadURL string `json:"downloadUrl"`
	ContentType any    `json:"contentType"`
}

// Release is getLatestRelease's result (JSON keys match the UI type).
type Release struct {
	OK             bool              `json:"ok"`
	NoRelease      bool              `json:"noRelease,omitempty"`
	Message        string            `json:"message,omitempty"`
	Repo           string            `json:"repo"`
	CurrentVersion string            `json:"currentVersion"`
	LatestVersion  string            `json:"latestVersion"`
	UpdateAvail    bool              `json:"updateAvailable"`
	TagName        any               `json:"tagName"`
	Name           any               `json:"name"`
	Body           string            `json:"body"`
	HTMLURL        string            `json:"htmlUrl"`
	PublishedAt    any               `json:"publishedAt"`
	Prerelease     bool              `json:"prerelease"`
	Draft          bool              `json:"draft"`
	Assets         []Asset           `json:"assets"`
	Recommended    map[string]*Asset `json:"recommended"`
}

var (
	zipRe      = regexp.MustCompile(`(?i)BenchForge-.*-x64\.zip$`)
	anyZipRe   = regexp.MustCompile(`(?i)\.zip$`)
	portableRe = regexp.MustCompile(`(?i)Portable.*\.exe$`)
	setupRe    = regexp.MustCompile(`(?i)Setup.*\.exe$`)
	sumsRe     = regexp.MustCompile(`(?i)^SHA256SUMS\.txt$`)
	sha256Re   = regexp.MustCompile(`(?i)sha256`)
)

func pick(assets []Asset, res ...*regexp.Regexp) *Asset {
	for _, re := range res {
		for i := range assets {
			if re.MatchString(assets[i].Name) {
				a := assets[i]
				return &a
			}
		}
	}
	return nil
}

// Latest fetches the latest release of Repo.
func (u *Updater) Latest(ctx context.Context, token, currentVersion string) (*Release, error) {
	resp, err := u.get(ctx, u.APIBase+"/repos/"+Repo+"/releases/latest", token, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	cur := normalizeVersion(currentVersion)
	if resp.StatusCode == http.StatusNotFound {
		return &Release{OK: false, NoRelease: true, Repo: Repo, CurrentVersion: cur, LatestVersion: cur, HTMLURL: "https://github.com/" + Repo + "/releases",
			Assets: []Asset{}, Recommended: map[string]*Asset{"zip": nil, "portable": nil, "setup": nil, "checksum": nil},
			Message: "No published GitHub Release was found for this repository. Create and publish a release first."}, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, &statusError{resp.StatusCode, fmt.Sprintf("GitHub API error: %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))}
	}
	var rel struct {
		TagName     string `json:"tag_name"`
		Name        string `json:"name"`
		Body        string `json:"body"`
		HTMLURL     string `json:"html_url"`
		PublishedAt any    `json:"published_at"`
		Prerelease  bool   `json:"prerelease"`
		Draft       bool   `json:"draft"`
		Assets      []struct {
			ID          int64  `json:"id"`
			Name        string `json:"name"`
			Size        int64  `json:"size"`
			URL         string `json:"browser_download_url"`
			ContentType string `json:"content_type"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxAPIBytes)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("invalid GitHub release JSON: %w", err)
	}
	assets := []Asset{}
	for _, a := range rel.Assets {
		var ct any
		if a.ContentType != "" {
			ct = a.ContentType
		}
		assets = append(assets, Asset{ID: a.ID, Name: a.Name, Size: a.Size, DownloadURL: a.URL, ContentType: ct})
	}
	latest := normalizeVersion(jsv.Str(jsv.Or(rel.TagName, rel.Name)))
	var name any = jsv.Or(rel.Name, rel.TagName)
	return &Release{
		OK: true, Repo: Repo, CurrentVersion: cur, LatestVersion: latest, UpdateAvail: CompareVersions(latest, currentVersion) > 0,
		TagName: rel.TagName, Name: name, Body: rel.Body, HTMLURL: rel.HTMLURL, PublishedAt: rel.PublishedAt,
		Prerelease: rel.Prerelease, Draft: rel.Draft, Assets: assets,
		Recommended: map[string]*Asset{
			"zip": pick(assets, zipRe, anyZipRe), "portable": pick(assets, portableRe), "setup": pick(assets, setupRe),
			"checksum": pick(assets, sumsRe, sha256Re),
		},
	}, nil
}

// SelectAsset mirrors selectReleaseAsset.
func SelectAsset(rel *Release, assetName, kind string) (*Asset, error) {
	if assetName != "" {
		for i := range rel.Assets {
			if rel.Assets[i].Name == assetName {
				return &rel.Assets[i], nil
			}
		}
		return nil, errors.New("No matching release asset found.")
	}
	key := "zip"
	switch kind {
	case "portable", "setup":
		key = kind
	}
	if a := rel.Recommended[key]; a != nil {
		return a, nil
	}
	return nil, errors.New("No matching release asset found.")
}

// ParseChecksums mirrors parseChecksums (sha256sum format).
func ParseChecksums(text string) map[string]string {
	out := map[string]string{}
	line := regexp.MustCompile(`(?i)^([a-f0-9]{64})\s+\*?(.+)$`)
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		if m := line.FindStringSubmatch(strings.TrimSpace(sc.Text())); m != nil {
			out[strings.TrimSpace(m[2])] = strings.ToLower(m[1])
		}
	}
	return out
}

// Downloaded is the download result (UI shape).
type Downloaded struct {
	Canceled         bool   `json:"canceled"`
	FilePath         string `json:"filePath,omitempty"`
	AssetName        string `json:"assetName,omitempty"`
	Size             int64  `json:"size,omitempty"`
	SHA256           string `json:"sha256,omitempty"`
	ExpectedSHA256   string `json:"expectedSha256,omitempty"`
	ChecksumVerified bool   `json:"checksumVerified"`
	Release          any    `json:"release,omitempty"`
}

// ExpectedChecksum downloads SHA256SUMS.txt and returns the asset's hash.
func (u *Updater) ExpectedChecksum(ctx context.Context, rel *Release, asset *Asset, token string) (string, error) {
	sums := rel.Recommended["checksum"]
	if sums == nil || sums.DownloadURL == "" {
		return "", fmt.Errorf("Release %v has no SHA256SUMS.txt; refusing to download an unverifiable update.", rel.TagName)
	}
	resp, err := u.get(ctx, sums.DownloadURL, token, "application/octet-stream")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return "", fmt.Errorf("Download error: %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxChecksumBytes))
	if err != nil {
		return "", err
	}
	exp := ParseChecksums(string(b))[asset.Name]
	if exp == "" {
		return "", fmt.Errorf("SHA256SUMS.txt does not list %s; refusing to download an unverifiable update.", asset.Name)
	}
	return exp, nil
}

// DownloadTo downloads asset into filePath after verifying its SHA256. The
// data goes to a temporary file in the same folder which is renamed only
// after the hash matches; on any error nothing is left behind.
func (u *Updater) DownloadTo(ctx context.Context, rel *Release, asset *Asset, filePath, token string) (*Downloaded, error) {
	expected, err := u.ExpectedChecksum(ctx, rel, asset, token)
	if err != nil {
		return nil, err
	}
	resp, err := u.get(ctx, asset.DownloadURL, token, "application/octet-stream")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("Download error: %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return nil, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(filePath), ".benchforge-update-*.part")
	if err != nil {
		return nil, err
	}
	tmpName := tmp.Name()
	cleanup := func() { tmp.Close(); os.Remove(tmpName) }
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), io.LimitReader(resp.Body, maxAssetBytes+1))
	if err != nil {
		cleanup()
		return nil, err
	}
	if n > maxAssetBytes {
		cleanup()
		return nil, errors.New("update asset is too large")
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		cleanup()
		return nil, fmt.Errorf("SHA256 mismatch for %s. Expected %s, got %s.", asset.Name, expected, actual)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return nil, err
	}
	_ = os.Remove(filePath)
	if err := os.Rename(tmpName, filePath); err != nil {
		os.Remove(tmpName)
		return nil, err
	}
	return &Downloaded{FilePath: filePath, AssetName: asset.Name, Size: n, SHA256: actual, ExpectedSHA256: expected, ChecksumVerified: true,
		Release: jsv.Obj{"tagName": rel.TagName, "latestVersion": rel.LatestVersion, "htmlUrl": rel.HTMLURL}}, nil
}
