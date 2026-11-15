package main

import (
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
