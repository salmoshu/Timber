package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pastedPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 2, 2))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestPastedImageStoredBesideNestedDocumentWithoutOverwriting(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	data := pastedPNG(t)
	encoded := base64.StdEncoding.EncodeToString(data)
	first, err := storeProjectImage(root, "docs/note.md", encoded)
	if err != nil {
		t.Fatal(err)
	}
	second, err := storeProjectImage(root, "docs/note.md", encoded)
	if err != nil {
		t.Fatal(err)
	}
	if first.Path == second.Path {
		t.Fatal("pastes must never overwrite one another")
	}
	if !strings.HasPrefix(first.Path, "docs/assets/") || !strings.HasPrefix(first.MarkdownPath, "assets/") {
		t.Fatalf("unexpected relative paths: %#v", first)
	}
	actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(first.Path)))
	if err != nil || !bytes.Equal(actual, data) {
		t.Fatalf("image data changed: %v", err)
	}
}

func TestPastedImageRejectsInvalidContentAndTraversal(t *testing.T) {
	root := t.TempDir()
	valid := base64.StdEncoding.EncodeToString(pastedPNG(t))
	for _, item := range []struct{ path, data string }{
		{"note.md", "!base64"}, {"note.md", ""}, {"note.md", base64.StdEncoding.EncodeToString([]byte("<script>alert(1)</script>"))},
		{"../escape.md", valid}, {"note.md", strings.Repeat("A", maxPastedImageBytes*4/3+8)},
	} {
		if _, err := storeProjectImage(root, item.path, item.data); err == nil {
			t.Errorf("accepted invalid request for %q", item.path)
		}
	}
}

func TestPastedImageRejectsExternalAssetsSymlink(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "assets")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := storeProjectImage(root, "note.md", base64.StdEncoding.EncodeToString(pastedPNG(t))); err == nil {
		t.Fatal("wrote through an external assets symlink")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("external directory was modified")
	}
}

func TestPastedImageEndpointRequiresAuthentication(t *testing.T) {
	s := &server{token: "image-test"}
	mux := http.NewServeMux()
	s.routes(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/projects/test/images", strings.NewReader(`{}`)))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized upload returned %d", response.Code)
	}
}
