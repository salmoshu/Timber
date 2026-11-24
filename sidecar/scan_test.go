package main

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestScanTreeKeepsEmptyDirectories(t *testing.T) {
	root := t.TempDir()
	empty := filepath.Join(root, "empty")
	nested := filepath.Join(empty, "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}

	tree, err := scanTree(root, map[string]bool{".md": true})
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Children) != 1 || tree.Children[0].Name != "empty" || tree.Children[0].Type != "dir" {
		t.Fatalf("empty directory was not retained: %#v", tree.Children)
	}
	children := tree.Children[0].Children
	if len(children) != 1 || children[0].Name != "nested" || children[0].Path != "empty/nested" {
		t.Fatalf("nested empty directory was not retained: %#v", children)
	}
}

func TestBuildFilesAppearInTreeAndContentSearch(t *testing.T) {
	root := filepath.Join(t.TempDir(), "project.v1")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"CMakeLists.txt", "Makefile", "app.vcxproj", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("build_keyword\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s, mux, id := newTestAPI(t, root)
	selector := url.QueryEscape("=cmakelists.txt,=makefile,.vcxproj")
	treeResponse := callAPI(s, mux, "GET", "/api/projects/"+id+"/tree?exts="+selector, "")
	if treeResponse.Code != 200 {
		t.Fatalf("tree request failed: %d %s", treeResponse.Code, treeResponse.Body)
	}
	var tree DocNode
	if err := json.Unmarshal(treeResponse.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, child := range tree.Children {
		names[child.Name] = true
	}
	if len(names) != 3 || !names["CMakeLists.txt"] || !names["Makefile"] || !names["app.vcxproj"] {
		t.Fatalf("unexpected build files in tree: %v", names)
	}
	searchResponse := callAPI(s, mux, "GET", "/api/projects/"+id+"/search?q=build_keyword&exts="+selector, "")
	var search struct {
		Files []SearchFileResult `json:"files"`
	}
	if searchResponse.Code != 200 || json.Unmarshal(searchResponse.Body.Bytes(), &search) != nil {
		t.Fatalf("search request failed: %d %s", searchResponse.Code, searchResponse.Body)
	}
	searchPaths := map[string]bool{}
	for _, file := range search.Files {
		searchPaths[file.Path] = true
	}
	if len(searchPaths) != 3 || !searchPaths["CMakeLists.txt"] || !searchPaths["Makefile"] || !searchPaths["app.vcxproj"] {
		t.Fatalf("unexpected build files in search results: %v", searchPaths)
	}
	docResponse := callAPI(s, mux, "GET", "/api/projects/"+id+"/doc?path=Makefile", "")
	var doc struct {
		Ext string `json:"ext"`
	}
	if docResponse.Code != 200 || json.Unmarshal(docResponse.Body.Bytes(), &doc) != nil || doc.Ext != "" {
		t.Fatalf("extensionless Makefile returned an unexpected extension: %d %s", docResponse.Code, docResponse.Body)
	}
}
