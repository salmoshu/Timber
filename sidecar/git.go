package main

// git.go：git 集成 —— 状态 / 暂存 / 取消暂存 / 丢弃 / 提交 / 拉推。
// 通过调用 git CLI 实现（模仿 VSCode 源代码管理的最小集），项目目录可以是
// 仓库根目录或其子目录：所有操作以项目目录为 cwd，状态限定在项目子树内。

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ensureGitIgnore：若项目是 git 仓库且 .gitignore 未忽略 .timber，则追加忽略项（幂等）。
// 批注库等本地数据写入 <项目>/.timber/，不应进入版本库。
func ensureGitIgnore(projectPath string) {
	out, err := gitRun(projectPath, 10*time.Second, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(out) != "true" {
		return
	}
	ignorePath := filepath.Join(projectPath, ".gitignore")
	data, err := os.ReadFile(ignorePath)
	content := string(data)
	if err == nil && strings.Contains(content, ".timber") {
		return
	}
	line := ".timber/"
	if err == nil && len(content) > 0 && !strings.HasSuffix(content, "\n") {
		line = "\n" + line
	}
	line += "\n"
	f, err := os.OpenFile(ignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}

// GitChange 一条变更。Index/Work 为 porcelain 状态码（M/A/D/R/U/? 等，空格表示无变化）。
type GitChange struct {
	Path  string `json:"path"`           // 相对项目根（/ 分隔）
	Orig  string `json:"orig,omitempty"` // 重命名前的路径
	Index string `json:"index"`          // 暂存区状态
	Work  string `json:"work"`           // 工作区状态
}

// GitStatus 仓库概览。Repo=false 表示项目不在 git 工作树内。
type GitStatus struct {
	Repo    bool        `json:"repo"`
	Branch  string      `json:"branch"`
	Ahead   int         `json:"ahead"`
	Behind  int         `json:"behind"`
	Changes []GitChange `json:"changes"`
	Err     string      `json:"err,omitempty"`
}

const gitNotFound = "未找到 git 命令（请安装 Git 并确保在 PATH 中）"

// gitRun 在 dir 内执行 git，返回 stdout；stderr 一并包进错误便于 UI 展示。
func gitRun(dir string, timeout time.Duration, args ...string) (string, error) {
	return gitRunContext(context.Background(), dir, timeout, args...)
}

func gitRunContext(parent context.Context, dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var out, errBuf strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.Error); ok && ee.Err == exec.ErrNotFound {
			return "", fmt.Errorf("%s", gitNotFound)
		}
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return out.String(), nil
}

func toSlash(p string) string { return strings.ReplaceAll(p, "\\", "/") }

func (s *server) handleGitStatus(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	writeJSON(w, 200, gitStatus(p.Path))
}

// repoPrefix 项目目录在仓库内的相对前缀（仓库根目录为空串）。
// porcelain 输出的路径相对仓库根，需剥掉前缀换算成项目相对路径。
func repoPrefix(projectPath string) string {
	out, err := gitRun(projectPath, 10*time.Second, "rev-parse", "--show-prefix")
	if err != nil {
		return ""
	}
	return toSlash(strings.TrimSpace(out))
}

func gitStatus(projectPath string) *GitStatus {
	st := &GitStatus{Changes: []GitChange{}}
	if _, err := gitRun(projectPath, 15*time.Second, "rev-parse", "--is-inside-work-tree"); err != nil {
		if strings.Contains(err.Error(), gitNotFound) {
			st.Err = err.Error()
		}
		return st
	}
	out, err := gitRun(projectPath, 20*time.Second, "status", "--porcelain=v1", "-b", "--", ".")
	if err != nil {
		st.Err = err.Error()
		return st
	}
	prefix := repoPrefix(projectPath)
	st.Repo = true
	branchRe := regexp.MustCompile(`^## (?:Initial commit on )?([^\s.]+?)(?:\.\.\.[^\s]*)?(?:\s+\[.*\])?$`)
	abRe := regexp.MustCompile(`\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]`)
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			if m := branchRe.FindStringSubmatch(line); m != nil {
				st.Branch = m[1]
			}
			if m := abRe.FindStringSubmatch(line); m != nil {
				if m[1] != "" {
					st.Ahead, _ = strconv.Atoi(m[1])
				}
				if m[2] != "" {
					st.Behind, _ = strconv.Atoi(m[2])
				}
			}
			continue
		}
		if len(line) < 4 {
			continue
		}
		c := GitChange{Index: string(line[0]), Work: string(line[1])}
		rest := line[3:]
		// 重命名形如 "R  new -> old"
		if i := strings.Index(rest, " -> "); i >= 0 {
			c.Path = rest[:i]
			c.Orig = rest[i+4:]
		} else {
			c.Path = rest
		}
		c.Path = toSlash(strings.Trim(c.Path, `"`))
		c.Orig = toSlash(strings.Trim(c.Orig, `"`))
		// 只保留项目子树内、且剥掉仓库前缀后的路径
		if prefix != "" {
			if strings.HasPrefix(c.Path, prefix) {
				c.Path = strings.TrimPrefix(c.Path, prefix)
			} else {
				continue
			}
			if c.Orig != "" && strings.HasPrefix(c.Orig, prefix) {
				c.Orig = strings.TrimPrefix(c.Orig, prefix)
			}
		}
		st.Changes = append(st.Changes, c)
	}
	return st
}

// gitPathsReq 通用请求体：paths 为项目内相对路径（/ 分隔）。
type gitPathsReq struct {
	Paths []string `json:"paths"`
}

// gitPathOp 校验 paths 均在项目内，换算为仓库相对路径后执行 git 操作。
func (s *server) gitPathOp(w http.ResponseWriter, r *http.Request, op func(p *Project, repoPaths []string, projPaths []string) error) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req gitPathsReq
	if err := readJSON(r, &req); err != nil || len(req.Paths) == 0 {
		writeError(w, 400, "请求体需包含 paths")
		return
	}
	for _, rel := range req.Paths {
		if _, err := resolveDoc(p.Path, rel); err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	prefix := repoPrefix(p.Path)
	repoPaths := make([]string, 0, len(req.Paths))
	for _, rel := range req.Paths {
		repoPaths = append(repoPaths, prefix+rel)
	}
	if err := op(p, repoPaths, req.Paths); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleGitDiff 查看单个文件相对 HEAD 的更改（未跟踪文件展示全文为新增）。
func (s *server) handleGitDiff(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	rel := strings.TrimSpace(r.URL.Query().Get("path"))
	if rel == "" {
		writeError(w, 400, "缺少 path 参数")
		return
	}
	if _, err := resolveDoc(p.Path, rel); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	prefix := repoPrefix(p.Path)
	repoRel := prefix + rel

	tracked, err := gitRun(p.Path, 20*time.Second, "ls-files", "--", repoRel)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	var diff string
	if strings.TrimSpace(tracked) != "" {
		out, err := gitRun(p.Path, 20*time.Second, "diff", "HEAD", "--", repoRel)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		diff = out
	} else {
		// 未跟踪：读文件内容合成“新增”diff
		abs, err := resolveDoc(p.Path, rel)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		var b strings.Builder
		b.WriteString("--- /dev/null\n")
		b.WriteString("+++ " + rel + "\n")
		b.WriteString("@@ -0,0 +1," + itoa(countLines(data)) + " @@\n")
		for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
			b.WriteString("+" + line + "\n")
		}
		diff = b.String()
	}
	writeJSON(w, 200, map[string]any{"path": rel, "diff": diff})
}

func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	n := 1
	for _, c := range data {
		if c == '\n' {
			n++
		}
	}
	return n
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

func (s *server) handleGitAdd(w http.ResponseWriter, r *http.Request) {
	s.gitPathOp(w, r, func(p *Project, repoPaths, _ []string) error {
		_, err := gitRun(p.Path, 30*time.Second, append([]string{"add", "--"}, repoPaths...)...)
		return err
	})
}

func (s *server) handleGitReset(w http.ResponseWriter, r *http.Request) {
	s.gitPathOp(w, r, func(p *Project, repoPaths, _ []string) error {
		_, err := gitRun(p.Path, 30*time.Second, append([]string{"reset", "-q", "HEAD", "--"}, repoPaths...)...)
		return err
	})
}

// handleGitDiscard 丢弃工作区改动：未跟踪文件直接删除，已跟踪文件还原到 HEAD。
func (s *server) handleGitDiscard(w http.ResponseWriter, r *http.Request) {
	s.gitPathOp(w, r, func(p *Project, repoPaths, projPaths []string) error {
		tracked, err := gitRun(p.Path, 30*time.Second, append([]string{"ls-files", "--"}, repoPaths...)...)
		if err != nil {
			return err
		}
		trackedSet := map[string]bool{}
		for _, line := range strings.Split(strings.TrimSpace(tracked), "\n") {
			if line != "" {
				trackedSet[toSlash(line)] = true
			}
		}
		var toRestore []string
		for i, rel := range repoPaths {
			if trackedSet[rel] {
				toRestore = append(toRestore, rel)
				continue
			}
			abs, err := resolveDoc(p.Path, projPaths[i])
			if err != nil {
				return err
			}
			if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if len(toRestore) > 0 {
			_, err := gitRun(p.Path, 30*time.Second, append([]string{"checkout", "-q", "HEAD", "--"}, toRestore...)...)
			return err
		}
		return nil
	})
}

func (s *server) handleGitCommit(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Message string `json:"message"`
	}
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Message) == "" {
		writeError(w, 400, "提交信息不能为空")
		return
	}
	if _, err := gitRun(p.Path, 60*time.Second, "commit", "-m", req.Message); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// handleGitSync pull / push 由 body.op 区分（ff-only 拉取，避免意外合并）。
func (s *server) handleGitSync(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Op string `json:"op"` // pull | push
	}
	if err := readJSON(r, &req); err != nil || (req.Op != "pull" && req.Op != "push") {
		writeError(w, 400, "op 仅支持 pull / push")
		return
	}
	args := []string{"pull", "--ff-only"}
	if req.Op == "push" {
		args = []string{"push"}
	}
	if _, err := gitRun(p.Path, 180*time.Second, args...); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
