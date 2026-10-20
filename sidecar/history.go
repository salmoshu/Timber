package main

// history.go：git 历史 —— 提交日志 / 单提交详情（供历史视图）。
// 非 git 项目统一返回 {ok:false, error:"not-a-repo"}（HTTP 200，UI 呈现空态）。

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CommitInfo 一条提交摘要（列表与详情共用）。
type CommitInfo struct {
	Sha        string   `json:"sha"`
	Short      string   `json:"short"`
	Parents    []string `json:"parents"`
	Author     string   `json:"author"`
	Email      string   `json:"email"`
	Time       int64    `json:"time"` // unix 秒
	Subject    string   `json:"subject"`
	Kind       string   `json:"kind"` // feat/fix/docs/.../change
	Files      int      `json:"files"`
	Insertions int      `json:"insertions"`
	Deletions  int      `json:"deletions"`
	// Entire-Checkpoint trailer（存在即该提交有关联的 AI 会话 checkpoint）
	EntireCheckpoint string `json:"entireCheckpoint,omitempty"`
}

// CommitFile 单提交内的一个变更文件。
type CommitFile struct {
	Path       string `json:"path"`
	OldPath    string `json:"oldPath,omitempty"` // 重命名前路径
	Status     string `json:"status"`            // A/M/D/R
	Insertions int    `json:"insertions"`
	Deletions  int    `json:"deletions"`
}

// log 记录分隔：\x1e 分记录、\x1f 分字段（提交信息几乎不含控制字符）。
// 末字段为 Entire-Checkpoint trailer 值（无则空串）。
const logFormat = "%x1e%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:key=Entire-Checkpoint,valueonly)"

// isGitRepo 项目目录是否在 git 工作树内。
func isGitRepo(projectPath string) bool {
	out, err := gitRun(projectPath, 10*time.Second, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(out) == "true"
}

// writeNotRepo 统一的非仓库响应。
func writeNotRepo(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]any{"ok": false, "error": "not-a-repo"})
}

func (s *server) handleGitLog(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	skip, _ := strconv.Atoi(q.Get("skip"))
	if skip < 0 {
		skip = 0
	}
	out, err := gitRun(p.Path, 60*time.Second, "log",
		"--format="+logFormat, "--numstat",
		"--skip="+itoa(skip), "--max-count="+itoa(limit))
	if err != nil {
		// 无提交的空仓库：返回空列表而非错误
		writeJSON(w, 200, map[string]any{"ok": true, "commits": []CommitInfo{}, "total": 0})
		return
	}
	commits := parseGitLog(out)
	total := 0
	if out, err := gitRun(p.Path, 30*time.Second, "rev-list", "--count", "HEAD"); err == nil {
		total, _ = strconv.Atoi(strings.TrimSpace(out))
	}
	writeJSON(w, 200, map[string]any{"ok": true, "commits": commits, "total": total})
}

// parseGitLog 解析 --format=logFormat --numstat 的输出。
func parseGitLog(out string) []CommitInfo {
	commits := []CommitInfo{}
	for _, rec := range strings.Split(out, "\x1e") {
		rec = strings.Trim(rec, "\n")
		if rec == "" {
			continue
		}
		lines := strings.Split(rec, "\n")
		fields := strings.Split(lines[0], "\x1f")
		if len(fields) < 8 {
			continue
		}
		c := CommitInfo{
			Sha:     fields[0],
			Short:   fields[1],
			Author:  fields[3],
			Email:   fields[4],
			Subject: fields[6],
			Parents: []string{},
		}
		// 同名 trailer 多个时取首个（值内换行会溢出到后续行，但不影响 numstat 解析）
		c.EntireCheckpoint = strings.TrimSpace(fields[7])
		if p := strings.TrimSpace(fields[2]); p != "" {
			c.Parents = strings.Fields(p)
		}
		c.Time, _ = strconv.ParseInt(fields[5], 10, 64)
		var paths []string
		for _, ln := range lines[1:] {
			parts := strings.SplitN(ln, "\t", 3)
			if len(parts) != 3 {
				continue
			}
			c.Files++
			if n, err := strconv.Atoi(parts[0]); err == nil { // "-" 表示二进制
				c.Insertions += n
			}
			if n, err := strconv.Atoi(parts[1]); err == nil {
				c.Deletions += n
			}
			paths = append(paths, parts[2])
		}
		c.Kind = classifyCommit(c.Subject, paths)
		commits = append(commits, c)
	}
	return commits
}

var (
	conventionalRe = regexp.MustCompile(`^(\w+)(\(.*\))?!?:`)
	knownKinds     = map[string]bool{
		"feat": true, "fix": true, "docs": true, "style": true,
		"refactor": true, "perf": true, "test": true, "build": true,
		"ci": true, "chore": true, "revert": true,
	}
)

// classifyCommit 提交分类：conventional 前缀优先，否则按文件启发。
func classifyCommit(subject string, files []string) string {
	if m := conventionalRe.FindStringSubmatch(subject); m != nil {
		if k := strings.ToLower(m[1]); knownKinds[k] {
			return k
		}
	}
	if len(files) == 0 {
		return "change"
	}
	docs, test, build := true, true, true
	for _, f := range files {
		f = strings.ToLower(f)
		if !isDocsFile(f) {
			docs = false
		}
		if !isTestFile(f) {
			test = false
		}
		if !isBuildFile(f) {
			build = false
		}
	}
	switch {
	case docs:
		return "docs"
	case test:
		return "test"
	case build:
		return "build"
	}
	return "change"
}

func isDocsFile(f string) bool {
	return strings.HasPrefix(f, "docs/") || strings.HasSuffix(f, ".md") ||
		strings.HasSuffix(f, ".markdown") || strings.HasSuffix(f, ".rst")
}

func isTestFile(f string) bool {
	if strings.HasSuffix(f, "_test.go") || strings.Contains(f, ".test.") || strings.Contains(f, ".spec.") {
		return true
	}
	for _, seg := range strings.Split(f, "/") {
		if seg == "test" || seg == "tests" || seg == "__tests__" || seg == "testdata" {
			return true
		}
	}
	return false
}

func isBuildFile(f string) bool {
	base := f
	if i := strings.LastIndex(f, "/"); i >= 0 {
		base = f[i+1:]
	}
	if strings.HasPrefix(f, ".github/workflows/") || strings.HasPrefix(f, ".gitlab-ci") {
		return true
	}
	switch base {
	case "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
		"go.mod", "go.sum", "cargo.toml", "cargo.lock", "makefile",
		"dockerfile", "docker-compose.yml", "docker-compose.yaml":
		return true
	}
	return strings.HasSuffix(base, ".mk")
}

var shaRe = regexp.MustCompile(`^[0-9a-fA-F]{4,40}$`)

func (s *server) handleGitShow(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	sha := r.PathValue("sha")
	if !shaRe.MatchString(sha) {
		writeError(w, 400, "无效的提交 sha")
		return
	}
	// 元信息 + trailer + body（-s 不带 diff；body 放最后，内部可能含换行）
	meta, err := gitRun(p.Path, 30*time.Second, "show", "-s",
		"--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:key=Entire-Checkpoint,valueonly)%x1f%b", sha)
	if err != nil {
		writeError(w, 404, "提交不存在")
		return
	}
	fields := strings.SplitN(meta, "\x1f", 9)
	if len(fields) < 9 {
		writeError(w, 500, "提交解析失败")
		return
	}
	c := CommitInfo{
		Sha: fields[0], Short: fields[1], Author: fields[3], Email: fields[4],
		Subject: fields[6], Parents: []string{},
	}
	if ps := strings.TrimSpace(fields[2]); ps != "" {
		c.Parents = strings.Fields(ps)
	}
	c.Time, _ = strconv.ParseInt(fields[5], 10, 64)
	c.EntireCheckpoint = strings.TrimSpace(fields[7])
	body := strings.Trim(fields[8], "\n")

	files := showFiles(p.Path, sha)
	paths := make([]string, 0, len(files))
	for _, f := range files {
		c.Files++
		c.Insertions += f.Insertions
		c.Deletions += f.Deletions
		paths = append(paths, f.Path)
	}
	c.Kind = classifyCommit(c.Subject, paths)
	writeJSON(w, 200, map[string]any{"ok": true, "commit": c, "body": body, "files": files})
}

// showFiles 组合 --name-status 与 --numstat（均 -z，避免路径转义问题）解析文件列表。
func showFiles(dir, sha string) []CommitFile {
	nsOut, err := gitRun(dir, 30*time.Second, "show", "--format=", "-z", "--name-status", sha)
	if err != nil {
		return []CommitFile{}
	}
	stats := map[string][2]int{} // path -> [ins, del]
	if stOut, err := gitRun(dir, 30*time.Second, "show", "--format=", "-z", "--numstat", sha); err == nil {
		toks := strings.Split(stOut, "\x00")
		for i := 0; i < len(toks); i++ {
			parts := strings.SplitN(toks[i], "\t", 3)
			if len(parts) != 3 {
				continue
			}
			ins, _ := strconv.Atoi(parts[0])
			del, _ := strconv.Atoi(parts[1])
			p := parts[2]
			if p == "" && i+2 < len(toks) { // 重命名：ins\tdel\t\0old\0new\0
				p = toks[i+2]
				i += 2
			}
			if p != "" {
				stats[p] = [2]int{ins, del}
			}
		}
	}
	files := []CommitFile{}
	toks := strings.Split(nsOut, "\x00")
	for i := 0; i < len(toks); i++ {
		status := toks[i]
		if status == "" {
			continue
		}
		f := CommitFile{Status: string(status[0])}
		if status[0] == 'R' || status[0] == 'C' { // R100\0old\0new\0
			if i+2 >= len(toks) {
				break
			}
			f.OldPath, f.Path = toks[i+1], toks[i+2]
			i += 2
		} else {
			if i+1 >= len(toks) {
				break
			}
			f.Path = toks[i+1]
			i++
		}
		if st, ok := stats[f.Path]; ok {
			f.Insertions, f.Deletions = st[0], st[1]
		}
		files = append(files, f)
	}
	return files
}
