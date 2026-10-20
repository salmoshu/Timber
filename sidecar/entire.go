package main

// entire.go：Entire CLI 的 AI 会话 checkpoint 只读读取。
// checkpoint 全部存于 git 对象（refs/entire/checkpoints/<shard>/<id>，commit message
// 挂 Entire-Checkpoint trailer），这里只走 git CLI 读对象，不依赖 entire 二进制——
// 用户可能只是 clone 了带 checkpoint 的仓库。探测即降级：无 checkpoint ref 的项目
// 各端点返回空结果，不报错。

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	entireRefPrefix = "refs/entire/checkpoints"
	// transcript 截断阈值（前端分段渲染，避免一次塞入超大对话）
	entireTranscriptCap = 200 << 10
	// search 单批 ref 数（Windows 命令行长度限制）
	entireGrepBatch = 50
)

// checkpoint id 为 Crockford base32 类大写串，宽容到纯字母数字
var entireIDRe = regexp.MustCompile(`^[A-Za-z0-9]{4,64}$`)

// ---- checkpoint 元数据（宽容解析：缺字段不报错） ----

type entireTokenUsage struct {
	InputTokens         int64 `json:"inputTokens"`
	CacheCreationTokens int64 `json:"cacheCreationTokens"`
	CacheReadTokens     int64 `json:"cacheReadTokens"`
	OutputTokens        int64 `json:"outputTokens"`
	APICallCount        int64 `json:"apiCallCount"`
}

// entireRootMeta 根 metadata.json（checkpoint 级）
type entireRootMeta struct {
	CLIVersion   string   `json:"cli_version"`
	CheckpointID string   `json:"checkpoint_id"`
	Branch       string   `json:"branch"`
	FilesTouched []string `json:"files_touched"`
	Sessions     []struct {
		Metadata          string `json:"metadata"`
		Transcript        string `json:"transcript"`
		CompactTranscript string `json:"compact_transcript"`
		Prompt            string `json:"prompt"`
	} `json:"sessions"`
	TokenUsage *entireTokenUsageRaw `json:"token_usage"`
}

// entireTokenUsageRaw 原始下划线命名（Entire 原生格式）
type entireTokenUsageRaw struct {
	InputTokens         int64 `json:"input_tokens"`
	CacheCreationTokens int64 `json:"cache_creation_tokens"`
	CacheReadTokens     int64 `json:"cache_read_tokens"`
	OutputTokens        int64 `json:"output_tokens"`
	APICallCount        int64 `json:"api_call_count"`
}

func (r *entireTokenUsageRaw) out() *entireTokenUsage {
	if r == nil {
		return nil
	}
	return &entireTokenUsage{
		InputTokens:         r.InputTokens,
		CacheCreationTokens: r.CacheCreationTokens,
		CacheReadTokens:     r.CacheReadTokens,
		OutputTokens:        r.OutputTokens,
		APICallCount:        r.APICallCount,
	}
}

// entireSessionMeta 会话级 metadata.json
type entireSessionMeta struct {
	SessionID      string               `json:"session_id"`
	CreatedAt      string               `json:"created_at"`
	Agent          string               `json:"agent"`
	Model          string               `json:"model"`
	FilesTouched   []string             `json:"files_touched"`
	TokenUsage     *entireTokenUsageRaw `json:"token_usage"`
	SessionMetrics struct {
		TurnCount int `json:"turn_count"`
	} `json:"session_metrics"`
}

// ---- 响应结构 ----

type entireSessionOut struct {
	Index        int               `json:"index"`
	Agent        string            `json:"agent"`
	Model        string            `json:"model"`
	SessionID    string            `json:"sessionId"`
	CreatedAt    string            `json:"createdAt"`
	Prompt       string            `json:"prompt"`
	FilesTouched []string          `json:"filesTouched"`
	TokenUsage   *entireTokenUsage `json:"tokenUsage,omitempty"`
	TurnCount    int               `json:"turnCount"`
}

// ---- git 读取辅助 ----

// entireRef checkpoint ref 条目（for-each-ref 按 committerdate 新到旧）
type entireRef struct {
	Ref  string
	Sha  string
	Date int64
}

// listEntireRefs 枚举全部 checkpoint ref（新到旧）；无 ref 或失败均返回空。
// for-each-ref 格式不支持 %xNN 转义，字段用空格分隔（refname/sha/时间戳均无空格）。
func listEntireRefs(dir string) []entireRef {
	out, err := gitRun(dir, 30*time.Second, "for-each-ref",
		"--format=%(refname) %(objectname) %(committerdate:unix)",
		"--sort=-committerdate", entireRefPrefix)
	if err != nil {
		return nil
	}
	refs := []entireRef{}
	for _, ln := range strings.Split(out, "\n") {
		parts := strings.Fields(ln)
		if len(parts) != 3 {
			continue
		}
		e := entireRef{Ref: parts[0], Sha: parts[1]}
		e.Date, _ = strconv.ParseInt(parts[2], 10, 64)
		refs = append(refs, e)
	}
	return refs
}

// findEntireRef 按 checkpoint id 找 ref（枚举后缀匹配，不假设 shard 大小写规则）。
func findEntireRef(dir, id string) string {
	suffix := "/" + id
	for _, r := range listEntireRefs(dir) {
		if strings.HasSuffix(r.Ref, suffix) {
			return r.Ref
		}
	}
	return ""
}

// entireReadFile 读 checkpoint tree 内文件；rel 允许带前导 /。
func entireReadFile(dir, ref, rel string) (string, error) {
	rel = strings.TrimPrefix(rel, "/")
	return gitRun(dir, 30*time.Second, "show", ref+":"+rel)
}

// entireRoot 读并解析根 metadata.json。
func entireRoot(dir, ref string) (*entireRootMeta, error) {
	out, err := entireReadFile(dir, ref, "metadata.json")
	if err != nil {
		return nil, err
	}
	var m entireRootMeta
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// ---- 端点 ----

// handleEntireCheckpoint checkpoint 聚合详情（根元数据 + 各会话元数据与首条 prompt）。
// trailer 存在但 ref 未同步到本地时返回 {ok:false, error:"not-synced"}。
func (s *server) handleEntireCheckpoint(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	id := r.URL.Query().Get("id")
	if !entireIDRe.MatchString(id) {
		writeError(w, 400, "无效的 checkpoint id")
		return
	}
	ref := findEntireRef(p.Path, id)
	if ref == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "not-synced"})
		return
	}
	root, err := entireRoot(p.Path, ref)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "unreadable"})
		return
	}
	sessions := []entireSessionOut{}
	for i, sess := range root.Sessions {
		so := entireSessionOut{Index: i, FilesTouched: []string{}}
		if sess.Metadata != "" {
			if raw, err := entireReadFile(p.Path, ref, sess.Metadata); err == nil {
				var sm entireSessionMeta
				if json.Unmarshal([]byte(raw), &sm) == nil {
					so.Agent = sm.Agent
					so.Model = sm.Model
					so.SessionID = sm.SessionID
					so.CreatedAt = sm.CreatedAt
					so.TurnCount = sm.SessionMetrics.TurnCount
					so.TokenUsage = sm.TokenUsage.out()
					if len(sm.FilesTouched) > 0 {
						so.FilesTouched = sm.FilesTouched
					}
				}
			}
		}
		if sess.Prompt != "" {
			if raw, err := entireReadFile(p.Path, ref, sess.Prompt); err == nil {
				so.Prompt = raw
			}
		}
		sessions = append(sessions, so)
	}
	filesTouched := root.FilesTouched
	if filesTouched == nil {
		filesTouched = []string{}
	}
	writeJSON(w, 200, map[string]any{
		"ok":           true,
		"checkpointId": id,
		"branch":       root.Branch,
		"cliVersion":   root.CLIVersion,
		"filesTouched": filesTouched,
		"tokenUsage":   root.TokenUsage.out(),
		"sessions":     sessions,
	})
}

// handleEntireTranscript 单会话 compact transcript（jsonl 逐行解析，坏行跳过；超 200KB 截断）。
func (s *server) handleEntireTranscript(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	q := r.URL.Query()
	id := q.Get("id")
	if !entireIDRe.MatchString(id) {
		writeError(w, 400, "无效的 checkpoint id")
		return
	}
	sessIdx, _ := strconv.Atoi(q.Get("session"))
	if sessIdx < 0 {
		sessIdx = 0
	}
	ref := findEntireRef(p.Path, id)
	if ref == "" {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "not-synced"})
		return
	}
	root, err := entireRoot(p.Path, ref)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "unreadable"})
		return
	}
	if sessIdx >= len(root.Sessions) {
		writeError(w, 400, "会话序号越界")
		return
	}
	rel := root.Sessions[sessIdx].CompactTranscript
	if rel == "" {
		rel = root.Sessions[sessIdx].Transcript
	}
	if rel == "" {
		writeJSON(w, 200, map[string]any{"ok": true, "lines": []any{}, "truncated": false})
		return
	}
	// 先看 blob 大小，决定 truncated 标记
	size := int64(0)
	if sz, err := gitRun(p.Path, 15*time.Second, "cat-file", "-s",
		ref+":"+strings.TrimPrefix(rel, "/")); err == nil {
		size, _ = strconv.ParseInt(strings.TrimSpace(sz), 10, 64)
	}
	raw, err := entireReadFile(p.Path, ref, rel)
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "unreadable"})
		return
	}
	truncated := false
	if int64(len(raw)) > entireTranscriptCap {
		raw = raw[:entireTranscriptCap]
		// 截到行尾，避免半行 JSON
		if i := strings.LastIndex(raw, "\n"); i > 0 {
			raw = raw[:i]
		}
		truncated = true
	} else if size > entireTranscriptCap {
		truncated = true
	}
	lines := []any{}
	for _, ln := range strings.Split(raw, "\n") {
		ln = strings.TrimSpace(ln)
		if ln == "" {
			continue
		}
		var v any
		if json.Unmarshal([]byte(ln), &v) == nil {
			lines = append(lines, v)
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "lines": lines, "truncated": truncated})
}

// ---- 逻辑耦合（同 checkpoint 内文件两两共现） ----

type entirePair struct {
	A     string `json:"a"`
	B     string `json:"b"`
	Count int    `json:"count"`
}

type entireCouplingResp struct {
	OK              bool         `json:"ok"`
	Pairs           []entirePair `json:"pairs"`
	CheckpointsUsed int          `json:"checkpointsUsed"`
}

// 内存缓存：key = 项目路径 + limit + 最新 checkpoint sha + ref 数（新 checkpoint 出现即失效）
var entireCouplingCache = struct {
	sync.Mutex
	m map[string]entireCouplingResp
}{m: map[string]entireCouplingResp{}}

// handleEntireCoupling 逻辑耦合：枚举最近 limit 个 checkpoint 的 files_touched 共现统计。
func (s *server) handleEntireCoupling(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	refs := listEntireRefs(p.Path)
	if len(refs) == 0 {
		writeJSON(w, 200, entireCouplingResp{OK: true, Pairs: []entirePair{}})
		return
	}
	if len(refs) > limit {
		refs = refs[:limit]
	}
	cacheKey := p.Path + "|" + itoa(limit) + "|" + refs[0].Sha + "|" + itoa(len(refs))
	entireCouplingCache.Lock()
	cached, hit := entireCouplingCache.m[cacheKey]
	entireCouplingCache.Unlock()
	if hit {
		writeJSON(w, 200, cached)
		return
	}
	counts := map[[2]string]int{}
	used := 0
	for _, rf := range refs {
		root, err := entireRoot(p.Path, rf.Ref)
		if err != nil {
			continue
		}
		// 同一 checkpoint 内去重后两两配对
		seen := map[string]bool{}
		files := []string{}
		for _, f := range root.FilesTouched {
			if !seen[f] {
				seen[f] = true
				files = append(files, f)
			}
		}
		if len(files) < 2 {
			continue
		}
		used++
		sort.Strings(files)
		for i := 0; i < len(files); i++ {
			for j := i + 1; j < len(files); j++ {
				counts[[2]string{files[i], files[j]}]++
			}
		}
	}
	pairs := []entirePair{}
	for k, n := range counts {
		pairs = append(pairs, entirePair{A: k[0], B: k[1], Count: n})
	}
	sort.Slice(pairs, func(i, j int) bool {
		if pairs[i].Count != pairs[j].Count {
			return pairs[i].Count > pairs[j].Count
		}
		if pairs[i].A != pairs[j].A {
			return pairs[i].A < pairs[j].A
		}
		return pairs[i].B < pairs[j].B
	})
	resp := entireCouplingResp{OK: true, Pairs: pairs, CheckpointsUsed: used}
	entireCouplingCache.Lock()
	// 只保留少量条目，避免长期运行堆积
	if len(entireCouplingCache.m) > 32 {
		entireCouplingCache.m = map[string]entireCouplingResp{}
	}
	entireCouplingCache.m[cacheKey] = resp
	entireCouplingCache.Unlock()
	writeJSON(w, 200, resp)
}

// handleEntireSync 从远端拉取 checkpoint refs（clone 默认不带 refs/entire/*）。
func (s *server) handleEntireSync(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	out, err := gitRun(p.Path, 15*time.Second, "remote")
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "no-remote"})
		return
	}
	remotes := []string{}
	for _, ln := range strings.Split(out, "\n") {
		if ln = strings.TrimSpace(ln); ln != "" {
			remotes = append(remotes, ln)
		}
	}
	if len(remotes) == 0 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "no-remote"})
		return
	}
	remote := remotes[0]
	for _, rm := range remotes {
		if rm == "origin" {
			remote = rm
			break
		}
	}
	if _, err := gitRun(p.Path, 120*time.Second, "fetch", remote,
		"+refs/entire/*:refs/entire/*"); err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "fetch-failed", "detail": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "synced": len(listEntireRefs(p.Path))})
}

// ---- 会话内容搜索 ----

type entireSearchHit struct {
	CheckpointID string   `json:"checkpointId"`
	Files        []string `json:"files"`
	Count        int      `json:"count"`
	Prompt       string   `json:"prompt"`
}

// gitGrepFiles 在一批 ref 上执行 git grep -l -i；无命中（exit 1）返回空而非错误。
func gitGrepFiles(dir, pattern string, refs []string) ([]string, error) {
	args := []string{"grep", "-l", "-i", "-e", pattern}
	args = append(args, refs...)
	args = append(args, "--")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var out, errBuf strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() == 1 {
			return nil, nil
		}
		msg := strings.TrimSpace(errBuf.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(msg)
	}
	files := []string{}
	for _, ln := range strings.Split(out.String(), "\n") {
		if ln = strings.TrimSpace(ln); ln != "" {
			files = append(files, ln)
		}
	}
	return files, nil
}

// entireFileKind 命中路径归类：prompt / transcript / metadata / 原路径
func entireFileKind(path string) string {
	switch {
	case strings.HasSuffix(path, "/prompt.txt"):
		return "prompt"
	case strings.HasSuffix(path, ".jsonl"):
		return "transcript"
	case strings.HasSuffix(path, "metadata.json"):
		return "metadata"
	default:
		return path
	}
}

// handleEntireSearch 跨 checkpoint 全文搜索（git grep，分批避免 Windows 命令行过长）。
// 结果按 checkpoint 聚合、按 committerdate 新到旧，最多 50 个；顺带返回首条 prompt 摘要。
func (s *server) handleEntireSearch(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, 400, "缺少 q 参数")
		return
	}
	refs := listEntireRefs(p.Path)
	if len(refs) > 300 {
		refs = refs[:300]
	}
	if len(refs) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "results": []entireSearchHit{}})
		return
	}
	// checkpointId → 命中文件归类（保持 refs 的新到旧顺序）
	type hit struct {
		set   map[string]bool
		files []string
	}
	byID := map[string]*hit{}
	for i := 0; i < len(refs); i += entireGrepBatch {
		end := i + entireGrepBatch
		if end > len(refs) {
			end = len(refs)
		}
		names := make([]string, 0, end-i)
		for _, rf := range refs[i:end] {
			names = append(names, rf.Ref)
		}
		lines, err := gitGrepFiles(p.Path, q, names)
		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "grep-failed", "detail": err.Error()})
			return
		}
		for _, ln := range lines {
			parts := strings.SplitN(ln, ":", 2)
			if len(parts) != 2 {
				continue
			}
			cpID := parts[0][strings.LastIndex(parts[0], "/")+1:]
			h := byID[cpID]
			if h == nil {
				h = &hit{set: map[string]bool{}}
				byID[cpID] = h
			}
			kind := entireFileKind(parts[1])
			if !h.set[kind] {
				h.set[kind] = true
				h.files = append(h.files, kind)
			}
		}
	}
	results := []entireSearchHit{}
	for _, rf := range refs {
		cpID := rf.Ref[strings.LastIndex(rf.Ref, "/")+1:]
		h := byID[cpID]
		if h == nil {
			continue
		}
		sort.Strings(h.files)
		res := entireSearchHit{CheckpointID: cpID, Files: h.files, Count: len(h.files)}
		// 顺带首条 prompt 摘要（截 120 字符）
		if root, err := entireRoot(p.Path, rf.Ref); err == nil && len(root.Sessions) > 0 {
			if pr := root.Sessions[0].Prompt; pr != "" {
				if raw, err := entireReadFile(p.Path, rf.Ref, pr); err == nil {
					first := strings.TrimSpace(strings.SplitN(raw, "\n", 2)[0])
					rs := []rune(first)
					if len(rs) > 120 {
						rs = rs[:120]
					}
					res.Prompt = string(rs)
				}
			}
		}
		results = append(results, res)
		if len(results) >= 50 {
			break
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "results": results})
}
