package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSingleFileWorkspaceIsDistinctAndPersists(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "单文件.MARKDOWN")
	if err := os.WriteFile(file, []byte("# Document"), 0o644); err != nil {
		t.Fatal(err)
	}
	registryFile := filepath.Join(t.TempDir(), "projects.json")
	r := newRegistry(registryFile)
	folder, err := r.add(root)
	if err != nil {
		t.Fatal(err)
	}
	document, err := r.add(file)
	if err != nil {
		t.Fatal(err)
	}
	if document.ID == folder.ID || document.Kind != "file" || document.Path != root || document.File != filepath.Base(file) || document.DocCount != 1 {
		t.Fatalf("unexpected file workspace: %+v", document)
	}
	reopened, err := r.add(file)
	if err != nil || reopened.ID != document.ID || len(r.list()) != 2 {
		t.Fatalf("opening a file twice must reuse its workspace: %+v, %v", reopened, err)
	}
	restored := newRegistry(registryFile).get(document.ID)
	if restored == nil || restored.Kind != "file" || restored.File != document.File {
		t.Fatalf("file workspace did not survive restart: %+v", restored)
	}
}

func TestSingleFileRoutesStayWithinFileAndRejectProjectFeatures(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{"note.md": "# target", "sibling.md": "siblingsecret"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	r := newRegistry(filepath.Join(t.TempDir(), "projects.json"))
	p, err := r.add(filepath.Join(root, "note.md"))
	if err != nil {
		t.Fatal(err)
	}
	s := &server{token: "test-token", registry: r}
	mux := http.NewServeMux()
	s.routes(mux)
	request := func(method, endpoint, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/projects/"+p.ID+endpoint, strings.NewReader(body))
		req.Header.Set("X-Timber-Token", s.token)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		return response
	}
	response := request("GET", "/tree?exts=.md", "")
	var tree DocNode
	if err := json.Unmarshal(response.Body.Bytes(), &tree); err != nil || response.Code != 200 || len(tree.Children) != 1 || tree.Children[0].Path != "note.md" {
		t.Fatalf("single file tree exposed siblings: %s, %v", response.Body, err)
	}
	response = request("GET", "/search?q=siblingsecret", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "sibling.md") {
		t.Fatalf("single file search exposed siblings: %s", response.Body)
	}
	for _, endpoint := range []string{"/git/log", "/git/status", "/arch/spec", "/arch/refs", "/entire/checkpoint"} {
		response = request("GET", endpoint, "")
		if response.Code != 400 || !strings.Contains(response.Body.String(), "folder-required") {
			t.Fatalf("single file accepted %s: %d %s", endpoint, response.Code, response.Body)
		}
	}
	response = request("PUT", "/doc", `{"path":"note.md","content":"# saved"}`)
	if response.Code != 200 {
		t.Fatalf("single file save failed: %d %s", response.Code, response.Body)
	}
	saved, err := os.ReadFile(filepath.Join(root, "note.md"))
	if err != nil || string(saved) != "# saved" {
		t.Fatalf("single file save did not reach disk: %q, %v", saved, err)
	}
}
