package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestReadDocChecksBothSizeAndMtime(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "first & second.md")
	if err := os.WriteFile(file, []byte("# First\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := newRegistry(filepath.Join(t.TempDir(), "projects.json"))
	project, err := reg.add(root)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{token: "doc-test", registry: reg}
	mux := http.NewServeMux()
	s.routes(mux)
	query := url.Values{"path": {filepath.Base(file)}}
	read := func() struct {
		Content   string    `json:"content"`
		Size      int64     `json:"size"`
		Mtime     time.Time `json:"mtime"`
		Unchanged bool      `json:"unchanged"`
	} {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/projects/"+project.ID+"/doc?"+query.Encode(), nil)
		req.Header.Set("X-Timber-Token", s.token)
		res := httptest.NewRecorder()
		mux.ServeHTTP(res, req)
		var reply struct {
			Content   string    `json:"content"`
			Size      int64     `json:"size"`
			Mtime     time.Time `json:"mtime"`
			Unchanged bool      `json:"unchanged"`
		}
		if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &reply) != nil {
			t.Fatalf("unexpected HTTP response %d: %s", res.Code, res.Body.String())
		}
		return reply
	}
	initial := read()
	if initial.Content != "# First\n" || initial.Unchanged {
		t.Fatalf("unconditional read did not return content: %+v", initial)
	}
	query.Set("knownMtime", initial.Mtime.Format(time.RFC3339Nano))
	query.Set("knownSize", strconv.FormatInt(initial.Size, 10))
	if checked := read(); !checked.Unchanged || checked.Content != "" {
		t.Fatalf("conditional read returned an unchanged body: %+v", checked)
	}
	query.Set("knownSize", "0")
	if checked := read(); checked.Unchanged || checked.Content != initial.Content {
		t.Fatalf("different size failed to invalidate: %+v", checked)
	}
	query.Set("knownSize", strconv.FormatInt(initial.Size, 10))
	if err := os.WriteFile(file, []byte("# Other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	changed := initial.Mtime.Add(2 * time.Second)
	if err := os.Chtimes(file, changed, changed); err != nil {
		t.Fatal(err)
	}
	if checked := read(); checked.Unchanged || checked.Content != "# Other\n" {
		t.Fatalf("same-size external edit did not invalidate: %+v", checked)
	}
}
