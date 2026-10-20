package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
)

const maxDocBytes = 8 << 20 // 8MB

type server struct {
	token    string
	registry *registry
	anns     *annotationStore
	assets   string
	remotes  *remoteRegistry
}

func (s *server) routes(mux *http.ServeMux) {
	s.anns = newAnnotationStore()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": version})
	})

	mux.HandleFunc("GET /api/projects", s.auth(s.handleListProjects))
	mux.HandleFunc("POST /api/projects", s.auth(s.handleAddProject))
	mux.HandleFunc("DELETE /api/projects/{id}", s.auth(s.handleRemoveProject))
	mux.HandleFunc("POST /api/projects/{id}/rescan", s.auth(s.handleRescan))
	mux.HandleFunc("GET /api/projects/{id}/tree", s.auth(s.handleTree))
	mux.HandleFunc("GET /api/projects/{id}/doc", s.auth(s.handleReadDoc))
	mux.HandleFunc("GET /api/projects/{id}/search", s.auth(s.handleSearch))
	mux.HandleFunc("PUT /api/projects/{id}/doc", s.auth(s.handleWriteDoc))
	mux.HandleFunc("GET /api/projects/{id}/annotations", s.auth(s.handleListAnnotations))
	mux.HandleFunc("POST /api/projects/{id}/annotations", s.auth(s.handleCreateAnnotation))
	mux.HandleFunc("PATCH /api/projects/{id}/annotations", s.auth(s.handleUpdateAnnotation))
	mux.HandleFunc("DELETE /api/projects/{id}/annotations", s.auth(s.handleDeleteAnnotation))
	mux.HandleFunc("GET /api/projects/{id}/annotations-file", s.auth(s.handleAnnotationFile))
	mux.HandleFunc("GET /api/projects/{id}/git/status", s.auth(s.handleGitStatus))
	mux.HandleFunc("GET /api/projects/{id}/git/diff", s.auth(s.handleGitDiff))
	mux.HandleFunc("GET /api/projects/{id}/git/log", s.auth(s.handleGitLog))
	mux.HandleFunc("GET /api/projects/{id}/git/show/{sha}", s.auth(s.handleGitShow))
	mux.HandleFunc("GET /api/projects/{id}/entire/checkpoint", s.auth(s.handleEntireCheckpoint))
	mux.HandleFunc("GET /api/projects/{id}/entire/transcript", s.auth(s.handleEntireTranscript))
	mux.HandleFunc("GET /api/projects/{id}/entire/coupling", s.auth(s.handleEntireCoupling))
	mux.HandleFunc("POST /api/projects/{id}/entire/sync", s.auth(s.handleEntireSync))
	mux.HandleFunc("GET /api/projects/{id}/entire/search", s.auth(s.handleEntireSearch))
	mux.HandleFunc("GET /api/projects/{id}/arch/refs", s.auth(s.handleArchRefs))
	mux.HandleFunc("GET /api/projects/{id}/arch/spec", s.auth(s.handleArchSpec))
	mux.HandleFunc("GET /api/projects/{id}/arch/insights", s.auth(s.handleArchInsights))
	mux.HandleFunc("GET /api/wsl/distros", s.auth(s.handleWslDistros))
	mux.HandleFunc("GET /api/wsl/home", s.auth(s.handleWslHome))
	mux.HandleFunc("GET /api/fs/list", s.auth(s.handleFsList))
	mux.HandleFunc("POST /api/remote/setup", s.auth(s.handleRemoteSetup))
	mux.HandleFunc("POST /api/remote/teardown", s.auth(s.handleRemoteTeardown))
	mux.HandleFunc("POST /api/projects/{id}/git/add", s.auth(s.handleGitAdd))
	mux.HandleFunc("POST /api/projects/{id}/git/reset", s.auth(s.handleGitReset))
	mux.HandleFunc("POST /api/projects/{id}/git/discard", s.auth(s.handleGitDiscard))
	mux.HandleFunc("POST /api/projects/{id}/git/commit", s.auth(s.handleGitCommit))
	mux.HandleFunc("POST /api/projects/{id}/git/sync", s.auth(s.handleGitSync))
	mux.HandleFunc("POST /api/projects/{id}/fs", s.auth(s.handleFsOp))
	// /raw/{id}/{path...}：项目内文件直读（HTML 文档以真实 URL 嵌入 iframe，
	// 使相对路径资源与页内脚本可用）。iframe 无法携带请求头，故不走 token 校验，
	// 但仅限已导入项目内的文件、仅监听 127.0.0.1。
	mux.HandleFunc("GET /raw/{id}/{path...}", s.handleRawFile)
}

// auth 校验令牌；本地工具放开 CORS 以便 dev:web 预览（仅监听 127.0.0.1）。
func (s *server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Timber-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		if r.Header.Get("X-Timber-Token") != s.token {
			writeError(w, 401, "缺少或错误的访问令牌")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxDocBytes))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, v)
}

func (s *server) project(w http.ResponseWriter, r *http.Request) *Project {
	p := s.registry.get(r.PathValue("id"))
	if p == nil {
		writeError(w, 404, "项目不存在")
	}
	return p
}

func (s *server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"projects": s.registry.list()})
}

func (s *server) handleAddProject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil || req.Path == "" {
		writeError(w, 400, "请求体需包含 path")
		return
	}
	p, err := s.registry.add(req.Path)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, p)
}

func (s *server) handleRemoveProject(w http.ResponseWriter, r *http.Request) {
	if !s.registry.remove(r.PathValue("id")) {
		writeError(w, 404, "项目不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *server) handleRescan(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Exts []string `json:"exts"`
	}
	_ = readJSON(r, &req)
	if len(req.Exts) > 0 {
		p.DocCount = countDocsExts(p.Path, parseExts(strings.Join(req.Exts, ",")))
	} else {
		p.DocCount = countDocs(p.Path)
	}
	writeJSON(w, 200, p)
}

func (s *server) handleTree(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	tree, err := scanTreeExts(p.Path, parseExts(r.URL.Query().Get("exts")))
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, tree)
}

func (s *server) handleReadDoc(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	abs, err := resolveDoc(p.Path, r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		writeError(w, 404, "文档不存在")
		return
	}
	if info.Size() > maxDocBytes {
		writeError(w, 413, "文档过大（>8MB），暂不支持")
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"path":    r.URL.Query().Get("path"),
		"ext":     strings.ToLower(strings.TrimPrefix(filepath_Ext(abs), ".")),
		"content": string(data),
		"size":    info.Size(),
		"mtime":   info.ModTime(),
	})
}

func filepath_Ext(p string) string {
	i := strings.LastIndex(p, ".")
	if i < 0 {
		return ""
	}
	return p[i:]
}

func (s *server) handleWriteDoc(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, 400, "请求体解析失败")
		return
	}
	abs, err := resolveDoc(p.Path, req.Path)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	// 原子写入：tmp + rename
	tmp := abs + ".timber.tmp"
	if err := os.WriteFile(tmp, []byte(req.Content), 0o644); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := os.Rename(tmp, abs); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *server) handleListAnnotations(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	anns, err := s.anns.list(p.Path, r.URL.Query().Get("doc"))
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if anns == nil {
		anns = []*Annotation{}
	}
	writeJSON(w, 200, map[string]any{"annotations": anns})
}

func (s *server) handleCreateAnnotation(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var a Annotation
	if err := readJSON(r, &a); err != nil {
		writeError(w, 400, "请求体解析失败")
		return
	}
	if a.Doc == "" || a.Text == "" {
		writeError(w, 400, "doc 与 text 不能为空")
		return
	}
	if a.Kind != "" && a.Kind != "tag" && a.Kind != "note" && a.Kind != "annotation" {
		writeError(w, 400, "kind 仅支持 tag / note / annotation")
		return
	}
	if _, err := resolveDoc(p.Path, a.Doc); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	ensureGitIgnore(p.Path)
	if err := s.anns.create(p.Path, &a); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, a)
}

func (s *server) handleUpdateAnnotation(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Doc    string `json:"doc"`
		ID     string `json:"id"`
		Text   string `json:"text"`
		Status string `json:"status"`
	}
	if err := readJSON(r, &req); err != nil || req.Doc == "" || req.ID == "" {
		writeError(w, 400, "doc 与 id 不能为空")
		return
	}
	if req.Status != "" && req.Status != "open" && req.Status != "done" {
		writeError(w, 400, "status 仅支持 open / done")
		return
	}
	a, err := s.anns.update(p.Path, req.Doc, req.ID, req.Text, req.Status)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, 404, "批注不存在")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, a)
}

func (s *server) handleDeleteAnnotation(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	q := r.URL.Query()
	if err := s.anns.delete(p.Path, q.Get("doc"), q.Get("id")); err != nil {
		writeError(w, 404, "批注不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleAnnotationFile 返回批注库绝对路径（供"复制批注地址"与 agent 消费）。
func (s *server) handleAnnotationFile(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	writeJSON(w, 200, map[string]string{"path": annFilePath(p.Path)})
}

// handleRawFile 直读项目内文件（HTML 文档/静态资源），供 iframe 按真实 URL 加载。
func (s *server) handleRawFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p := s.registry.get(id)
	if p == nil {
		writeError(w, 404, "项目不存在")
		return
	}
	rel := r.PathValue("path")
	abs, err := resolveDoc(p.Path, rel)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		writeError(w, 404, "文件不存在")
		return
	}
	http.ServeFile(w, r, abs)
}
