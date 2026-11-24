package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestAPI(t *testing.T, root string) (*server, *http.ServeMux, string) {
	t.Helper()
	r := newRegistry(filepath.Join(t.TempDir(), "projects.json"))
	p, err := r.add(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{token: "test-token", registry: r}
	mux := http.NewServeMux()
	s.routes(mux)
	return s, mux, p.ID
}

func callAPI(s *server, mux *http.ServeMux, method, endpoint, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, endpoint, strings.NewReader(body))
	req.Header.Set("X-Timber-Token", s.token)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestGitShowDiffReturnsOnlyRequestedFile(t *testing.T) {
	root := t.TempDir()
	if _, err := gitRun(root, 10*time.Second, "init", "-q"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	for name, content := range map[string]string{"a.txt": "a one\n", "b.txt": "b one\n"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := gitRun(root, 10*time.Second, "add", "."); err != nil {
		t.Fatal(err)
	}
	commit := func(message string) string {
		t.Helper()
		args := []string{"-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message}
		if _, err := gitRun(root, 10*time.Second, args...); err != nil {
			t.Fatal(err)
		}
		sha, err := gitRun(root, 10*time.Second, "rev-parse", "HEAD")
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(sha)
	}
	commit("first")
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("a changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "b.txt"), []byte("b changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := gitRun(root, 10*time.Second, "add", "."); err != nil {
		t.Fatal(err)
	}
	sha := commit("second")

	s, mux, id := newTestAPI(t, root)
	rec := callAPI(s, mux, "GET", "/api/projects/"+id+"/git/show/"+sha+"/diff?path=a.txt", "")
	if rec.Code != 200 {
		t.Fatalf("show diff failed: %d %s", rec.Code, rec.Body)
	}
	var out struct {
		Diff string `json:"diff"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.Diff, "+a changed") {
		t.Fatalf("missing a.txt addition: %s", out.Diff)
	}
	if strings.Contains(out.Diff, "b.txt") || strings.Contains(out.Diff, "b changed") {
		t.Fatalf("diff leaked another file: %s", out.Diff)
	}
}

func TestGitFileOperationsUseProjectRelativePaths(t *testing.T) {
	root := t.TempDir()
	if _, err := gitRun(root, 10*time.Second, "init", "-q"); err != nil {
		t.Skipf("git unavailable: %v", err)
	}
	subdir := filepath.Join(root, "docs")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(subdir, "note.md")
	if err := os.WriteFile(file, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := gitRun(root, 10*time.Second, "add", "--", "docs/note.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := gitRun(root, 10*time.Second, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("second\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, mux, id := newTestAPI(t, subdir)
	base := "/api/projects/" + id + "/git/"
	diff := callAPI(s, mux, "GET", base+"diff?path=note.md", "")
	if diff.Code != 200 || !strings.Contains(diff.Body.String(), "-first") || !strings.Contains(diff.Body.String(), "+second") {
		t.Fatalf("nested diff failed: %d %s", diff.Code, diff.Body)
	}
	for _, op := range []string{"add", "reset", "discard"} {
		response := callAPI(s, mux, "POST", base+op, `{"paths":["note.md"]}`)
		if response.Code != 200 {
			t.Fatalf("nested %s failed: %d %s", op, response.Code, response.Body)
		}
	}
	content, err := os.ReadFile(file)
	if err != nil || strings.TrimSpace(string(content)) != "first" {
		t.Fatalf("tracked file was not restored: %s (%v)", content, err)
	}
}

func TestFsMoveCaseOnlyRenameLeavesSingleEntry(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("# note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, mux, id := newTestAPI(t, root)
	rec := callAPI(s, mux, "POST", "/api/projects/"+id+"/fs", `{"op":"move","from":"a.md","to":"A.md"}`)
	if rec.Code != 200 {
		t.Fatalf("case-only rename failed: %d %s", rec.Code, rec.Body)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	if len(names) != 1 || names[0] != "A.md" {
		t.Fatalf("expected a single A.md after rename, got %v", names)
	}
}
