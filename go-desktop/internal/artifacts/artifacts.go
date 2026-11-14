// Package artifacts mirrors electron/artifacts.cjs: per-result artifact
// folders under <data>/artifacts and ZIP export of an artifact folder.
package artifacts

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/snakex21/benchforge/go-desktop/internal/jsv"
	"github.com/snakex21/benchforge/go-desktop/internal/paths"
)

var whitespace = regexp.MustCompile(`\s+`)

// PreviewText is previewText(value, 600).
func PreviewText(value string) string { return PreviewTextN(value, 600) }

// PreviewTextN collapses whitespace and truncates to limit characters.
func PreviewTextN(value string, limit int) string {
	normalized := strings.TrimSpace(whitespace.ReplaceAllString(value, " "))
	r := []rune(normalized)
	if len(r) > limit {
		return string(r[:limit-1]) + "…"
	}
	return normalized
}

func responseExtension(outputType string) string {
	switch outputType {
	case "html":
		return "html"
	case "svg":
		return "svg"
	case "markdown":
		return "md"
	case "maze":
		return "json"
	default:
		return "txt"
	}
}

// ResultRelativePath is resultArtifactRelativePath.
func ResultRelativePath(result jsv.Obj) string {
	session := "legacy"
	if jsv.Truthy(result["run_session_id"]) {
		session = "session-" + jsv.String(result["run_session_id"])
	}
	bench := "benchmark-" + jsv.String(result["benchmark_id"])
	part := "result-" + jsv.String(result["id"]) + "-aggregate"
	if jsv.Truthy(result["task_id"]) {
		part = "result-" + jsv.String(result["id"]) + "-task-" + jsv.String(result["task_id"])
	}
	return strings.Join([]string{"artifacts", "runs", session, bench, part}, "/")
}

// Resolve resolves an artifact path relative to the data dir ("" if invalid).
func Resolve(rel string) string {
	if rel == "" {
		return ""
	}
	return paths.ResolveData(rel)
}

// Remove deletes an artifact folder (best effort, confined to the data dir).
func Remove(rel string) {
	abs := Resolve(rel)
	if abs == "" {
		return
	}
	_ = os.RemoveAll(abs)
}

// Clear removes <data>/artifacts.
func Clear() { _ = os.RemoveAll(filepath.Join(paths.Data(), "artifacts")) }

func writeText(path, content string) error { return os.WriteFile(path, []byte(content), 0o644) }

// WriteResult writes prompt/response/thinking/result/snapshot files and
// returns the relative artifact path.
func WriteResult(result, model, benchmark, task jsv.Obj) (string, error) {
	rel := jsv.Str(result["artifact_path"])
	if rel == "" {
		rel = ResultRelativePath(result)
	}
	abs := Resolve(rel)
	if abs == "" {
		return "", errors.New("Invalid artifact path")
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return "", err
	}
	outputType := jsv.Str(jsv.Or(task["output_type"], benchmark["output_type"], "text"))
	ext := responseExtension(outputType)
	prompt := jsv.Str(jsv.Or(task["prompt_template"], benchmark["prompt_template"], ""))
	response := jsv.Str(result["notes"])
	thinking := jsv.Str(result["thinking_notes"])

	if err := writeText(filepath.Join(abs, "prompt.md"), prompt); err != nil {
		return "", err
	}
	if err := writeText(filepath.Join(abs, "response."+ext), response); err != nil {
		return "", err
	}
	if strings.TrimSpace(thinking) != "" {
		if err := writeText(filepath.Join(abs, "thinking.md"), thinking); err != nil {
			return "", err
		}
	}
	summary := jsv.Obj{
		"id":               result["id"],
		"model_id":         result["model_id"],
		"benchmark_id":     result["benchmark_id"],
		"task_id":          jsv.Coalesce(result["task_id"]),
		"run_session_id":   jsv.Coalesce(result["run_session_id"]),
		"score":            result["score"],
		"attempt_number":   result["attempt_number"],
		"tokens_used":      result["tokens_used"],
		"duration_ms":      result["duration_ms"],
		"run_at":           result["run_at"],
		"output_type":      outputType,
		"response_file":    "response." + ext,
		"has_thinking":     strings.TrimSpace(thinking) != "",
		"response_preview": PreviewText(response),
	}
	if err := writeText(filepath.Join(abs, "result.json"), jsv.JSONIndent(summary)); err != nil {
		return "", err
	}
	var safeModel any
	if model != nil {
		m := jsv.Obj{}
		for k, v := range model {
			if k != "api_key" {
				m[k] = v
			}
		}
		safeModel = m
	}
	if err := writeText(filepath.Join(abs, "model.snapshot.json"), jsv.JSONIndent(safeModel)); err != nil {
		return "", err
	}
	var bench any
	if benchmark != nil {
		bench = benchmark
	}
	if err := writeText(filepath.Join(abs, "benchmark.snapshot.json"), jsv.JSONIndent(bench)); err != nil {
		return "", err
	}
	if task != nil {
		if err := writeText(filepath.Join(abs, "task.snapshot.json"), jsv.JSONIndent(task)); err != nil {
			return "", err
		}
	}
	return rel, nil
}

// ZipDirectory writes all files of an artifact folder into outputPath.
func ZipDirectory(rel, outputPath string) (int, error) {
	root := Resolve(rel)
	if root == "" {
		return 0, errors.New("Artifact path does not exist")
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return 0, errors.New("Artifact path does not exist")
	}
	out, err := os.Create(outputPath)
	if err != nil {
		return 0, err
	}
	zw := zip.NewWriter(out)
	count := 0
	walkErr := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		r, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		w, err := zw.Create(paths.ToPosix(r))
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, f)
		f.Close()
		if err != nil {
			return err
		}
		count++
		return nil
	})
	if cerr := zw.Close(); walkErr == nil {
		walkErr = cerr
	}
	if cerr := out.Close(); walkErr == nil {
		walkErr = cerr
	}
	if walkErr != nil {
		return 0, fmt.Errorf("zip artifacts: %w", walkErr)
	}
	return count, nil
}
