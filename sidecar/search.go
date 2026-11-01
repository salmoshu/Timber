package main

// search.go：项目内文档全文搜索（文件名过滤之外的正文搜索）。
// 大小写不敏感；HTML 先剥标签再匹配；限量返回防止超大项目拖垮。

import (
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// SearchMatch 一条命中：行号 + 上下文片段。
type SearchMatch struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

// SearchFileResult 一个文件内的命中集合。
type SearchFileResult struct {
	Path    string        `json:"path"`
	Ext     string        `json:"ext"`
	Count   int           `json:"count"`
	Matches []SearchMatch `json:"matches"`
}

const (
	searchMaxFiles      = 50  // 最多返回的文件数
	searchMaxPerFile    = 20  // 单文件最多片段数
	searchMaxTotal      = 200 // 总片段上限
	searchSnippetLength = 160 // 片段长度上限
)

var htmlTagRe = regexp.MustCompile(`<[^>]*>`)
var htmlEntityRe = regexp.MustCompile(`&[a-zA-Z]+;|&#\d+;`)

// plainTextForSearch html 剥标签与实体，其余原样返回。
func plainTextForSearch(line, ext string) string {
	if ext != ".html" && ext != ".htm" {
		return line
	}
	s := htmlTagRe.ReplaceAllString(line, " ")
	s = htmlEntityRe.ReplaceAllString(s, " ")
	return strings.Join(strings.Fields(s), " ")
}

func snippetAround(line, needle string) string {
	lower := strings.ToLower(line)
	idx := strings.Index(lower, strings.ToLower(needle))
	if idx < 0 {
		if len(line) > searchSnippetLength {
			return line[:searchSnippetLength] + "…"
		}
		return line
	}
	start := idx - searchSnippetLength/3
	if start < 0 {
		start = 0
	}
	end := start + searchSnippetLength
	if end > len(line) {
		end = len(line)
	}
	s := line[start:end]
	if start > 0 {
		s = "…" + s
	}
	if end < len(line) {
		s += "…"
	}
	return s
}

func (s *server) handleSearch(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, 400, "缺少搜索关键词 q")
		return
	}
	exts := parseExts(r.URL.Query().Get("exts"))
	needle := strings.ToLower(q)
	files := []SearchFileResult{}
	total := 0
	truncated := false

	_ = filepath.WalkDir(p.Path, func(path string, d fs.DirEntry, err error) error {
		if err != nil || truncated {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if skipDirs[name] {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !exts[ext] || ext == ".xlsx" || ext == ".xls" {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.Size() > maxDocBytes {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(p.Path, path)
		if err != nil {
			return nil
		}
		fr := SearchFileResult{Path: toSlash(rel), Ext: ext, Matches: []SearchMatch{}}
		for i, raw := range strings.Split(string(data), "\n") {
			line := plainTextForSearch(strings.TrimRight(raw, "\r"), ext)
			if !strings.Contains(strings.ToLower(line), needle) {
				continue
			}
			if len(fr.Matches) < searchMaxPerFile && total < searchMaxTotal {
				fr.Matches = append(fr.Matches, SearchMatch{Line: i + 1, Text: snippetAround(line, q)})
				total++
			}
			fr.Count++
			if fr.Count >= searchMaxPerFile*10 || total >= searchMaxTotal {
				break
			}
		}
		if fr.Count > 0 {
			files = append(files, fr)
			if len(files) >= searchMaxFiles || total >= searchMaxTotal {
				truncated = true
				return filepath.SkipAll
			}
		}
		return nil
	})

	writeJSON(w, 200, map[string]any{
		"query":     q,
		"files":     files,
		"truncated": truncated,
	})
}
