package main

// analyze.go：架构 spec 生成与公共分析 —— analyzeProject 为 spec 与 insights 两端点的
// 公共分析入口（文件枚举/import 解析/符号/行数/git churn/IPC 配对只跑一遍），buildSpec
// 从产物组装 archify architecture v1 spec（sublabel 含行数/热度，connections 含 import
// 与 IPC 两类边），缓存于 <项目>/.timber/arch/<sha>.v2.json。
// 另含 arch refs 端点（分支/标签列表，供架构视图 ref 下拉）。

import (
	"encoding/json"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ---- spec schema（archify architecture v1） ----

type archSpec struct {
	SchemaVersion int               `json:"schema_version"`
	DiagramType   string            `json:"diagram_type"`
	Meta          archMeta          `json:"meta"`
	Components    []*archComponent  `json:"components"`
	Boundaries    []*archBoundary   `json:"boundaries,omitempty"`
	Connections   []*archConnection `json:"connections"`
}

type archMeta struct {
	Title          string    `json:"title"`
	QualityProfile string    `json:"quality_profile"`
	Output         string    `json:"output"` // archify 渲染器 schema 必填（占位，实际路径由主进程 argv 决定）
	Repository     *archRepo `json:"repository,omitempty"`
}

type archRepo struct {
	URL      string `json:"url,omitempty"`
	Revision string `json:"revision"`
	Provider string `json:"provider,omitempty"`
}

type archComponent struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"` // frontend/backend/database/cloud/external...
	Label    string       `json:"label"`
	Sublabel string       `json:"sublabel,omitempty"`
	Pos      [2]int       `json:"pos"`
	Size     [2]int       `json:"size"`
	Sources  []archSource `json:"sources,omitempty"`
}

type archSource struct {
	Path string `json:"path"`
}

type archBoundary struct {
	Kind  string   `json:"kind"` // region
	Label string   `json:"label"`
	Wraps []string `json:"wraps"`
}

type archConnection struct {
	ID    string `json:"id"`
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label,omitempty"`
}

// ---- arch refs ----

func (s *server) handleArchRefs(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	type refInfo struct {
		Name string `json:"name"`
		Sha  string `json:"sha"`
		Ref  string `json:"ref"`
	}
	listRefs := func(namespace string) []refInfo {
		out, err := gitRun(p.Path, 15*time.Second, "for-each-ref",
			"--sort=-committerdate", "--count=20",
			"--format=%(refname:short)%00%(objectname)%00%(refname)", namespace)
		if err != nil {
			return []refInfo{}
		}
		refs := []refInfo{}
		for _, ln := range strings.Split(out, "\n") {
			fields := strings.Split(strings.TrimRight(ln, "\r"), "\x00")
			if len(fields) == 3 && fields[0] != "" {
				refs = append(refs, refInfo{Name: fields[0], Sha: fields[1], Ref: fields[2]})
			}
		}
		return refs
	}
	head := ""
	if out, err := gitRun(p.Path, 10*time.Second, "rev-parse", "HEAD"); err == nil {
		head = strings.TrimSpace(out)
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "head": head,
		"branches": listRefs("refs/heads"), "tags": listRefs("refs/tags"),
	})
}

// ---- arch spec ----

// 源码扩展名集（契约）
var sourceExts = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true,
	".cjs": true, ".go": true, ".py": true, ".rs": true, ".java": true,
	".kt": true, ".vue": true, ".svelte": true, ".c": true, ".cc": true,
	".cpp": true, ".h": true, ".hpp": true, ".cs": true, ".rb": true,
	".php": true, ".swift": true, ".scala": true, ".sh": true, ".ps1": true,
	".css": true, ".scss": true, ".html": true,
}

// 磁盘扫描排除目录
var archSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true,
	"out": true, "release": true, "tmp": true, "vendor": true,
	".toolchain": true, ".timber": true,
}

const maxArchFileBytes = 1 << 20 // 1MB

// srcFile 一个待分析的源码文件（路径为项目相对、/ 分隔）。
type srcFile struct {
	path    string
	content []byte
}

func (s *server) handleArchSpec(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	ref := r.URL.Query().Get("ref")
	if ref == "" {
		ref = "HEAD"
	}
	if strings.HasPrefix(ref, "-") { // 防选项注入
		writeJSON(w, 200, map[string]any{"ok": false, "error": "unknown-ref"})
		return
	}
	shaOut, err := gitRun(p.Path, 15*time.Second, "rev-parse", "--verify", ref+"^{commit}")
	if err != nil {
		if ref == "HEAD" {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "no-commits"})
		} else {
			writeJSON(w, 200, map[string]any{"ok": false, "error": "unknown-ref"})
		}
		return
	}
	sha := strings.TrimSpace(shaOut)

	// 缓存命中直接回传；文件名带 spec 内容格式版本（v2：sublabel 含行数/热度、
	// connections 并入 IPC 边）——spec 内容格式变更须 bump vN，旧版本文件不再读取。
	cacheDir := filepath.Join(p.Path, ".timber", "arch")
	cacheFile := filepath.Join(cacheDir, sha+".v2.json")
	if data, err := os.ReadFile(cacheFile); err == nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write(data)
		return
	}

	a, err := analyzeProject(p, ref, sha)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if len(a.files) == 0 {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "no-source"})
		return
	}
	spec := buildSpec(p, a)
	data, err := json.Marshal(spec)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	// 原子写缓存：tmp + rename
	if err := os.MkdirAll(cacheDir, 0o755); err == nil {
		tmp := cacheFile + ".tmp"
		if err := os.WriteFile(tmp, data, 0o644); err == nil {
			_ = os.Rename(tmp, cacheFile)
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(data)
}

// collectSourceFiles 枚举源码文件：HEAD 用磁盘扫描，其余 ref 用 git ls-tree + git show。
func collectSourceFiles(p *Project, ref, sha string) ([]srcFile, error) {
	if ref == "HEAD" {
		return scanSourceFiles(p.Path)
	}
	prefix := repoPrefix(p.Path)
	out, err := gitRun(p.Path, 30*time.Second, "ls-tree", "-r", "--name-only", sha)
	if err != nil {
		return nil, err
	}
	files := []srcFile{}
	for _, ln := range strings.Split(out, "\n") {
		repoRel := strings.TrimRight(ln, "\r")
		rel := strings.TrimPrefix(repoRel, prefix)
		if prefix != "" && rel == repoRel {
			continue // 不在项目子树内
		}
		if !sourceExts[strings.ToLower(path.Ext(rel))] {
			continue
		}
		content, err := gitRun(p.Path, 15*time.Second, "show", sha+":"+repoRel)
		if err != nil || len(content) > maxArchFileBytes {
			continue
		}
		files = append(files, srcFile{path: rel, content: []byte(content)})
	}
	return files, nil
}

// scanSourceFiles 磁盘扫描（ref=HEAD）。
func scanSourceFiles(root string) ([]srcFile, error) {
	files := []srcFile{}
	err := filepath.Walk(root, func(abs string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if abs != root && archSkipDirs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !sourceExts[strings.ToLower(filepath.Ext(info.Name()))] || info.Size() > maxArchFileBytes {
			return nil
		}
		content, err := os.ReadFile(abs)
		if err != nil {
			return nil
		}
		rel, err := filepath.Rel(root, abs)
		if err != nil {
			return nil
		}
		files = append(files, srcFile{path: toSlash(rel), content: content})
		return nil
	})
	return files, err
}

// ---- 公共分析产物 ----

// analysis 一次项目分析的中间产物，spec 与 insights 两端点共用：文件枚举、import
// 解析、符号、行数、git churn、IPC 通道配对只跑一遍，两端点各从产物组装输出。
type analysis struct {
	sha    string
	files  []srcFile
	groups map[string][]srcFile // 组件目录 → 文件
	dirs   []string             // 组件目录（sortCompDirs 序，两端点组件集与顺序一致）
	idOf   map[string]string    // 组件目录 → 组件 id
	infos  map[string]*fileInfo // 文件路径 → 预分析（import/符号/行数）
	churn  map[string]int       // 文件路径 → 触及提交数
	counts map[dirEdge]int      // import 目录级边计数
	// IPC 通道表：channel → 组件 id 集（按角色分三张表）
	rendCh map[string]map[string]bool // ipcRenderer.invoke/send/on（消费方，含 preload）
	mainCh map[string]map[string]bool // ipcMain.handle/on（提供方）
	wcCh   map[string]map[string]bool // webContents.send（主→渲染推送方）
}

// analyzeProject 跑一次完整分析。无源码文件不视为错误：返回的 analysis.files 为空。
func analyzeProject(p *Project, ref, sha string) (*analysis, error) {
	files, err := collectSourceFiles(p, ref, sha)
	if err != nil {
		return nil, err
	}
	a := &analysis{sha: sha, files: files}
	if len(files) == 0 {
		return a, nil
	}
	a.groups = groupDirs(files)
	for d := range a.groups {
		a.dirs = append(a.dirs, d)
	}
	sortCompDirs(a.dirs)
	a.idOf = make(map[string]string, len(a.dirs))
	for _, d := range a.dirs {
		a.idOf[d] = kebabID(d)
	}
	// 单文件预分析：import / 顶层符号 / 行数（Go 文件走 go/ast）
	a.infos = make(map[string]*fileInfo, len(files))
	for _, f := range files {
		a.infos[f.path] = analyzeFile(f)
	}
	// git churn：近 300 提交窗口内各文件的触及提交数
	a.churn = gitChurn(p.Path, sha)
	// IPC 通道扫描（组件 id 级）
	a.rendCh = map[string]map[string]bool{}
	a.mainCh = map[string]map[string]bool{}
	a.wcCh = map[string]map[string]bool{}
	for _, f := range files {
		fileDir := path.Dir(f.path)
		if fileDir == "/" {
			fileDir = "."
		}
		if id, ok := a.idOf[fileCompDir(a.groups, fileDir)]; ok {
			scanIpc(f, id, a.rendCh, a.mainCh, a.wcCh)
		}
	}
	// import 目录级边（import 取自单文件预分析结果）
	a.counts = importEdges(p, a.groups, a.dirs, files, a.idOf, a.infos)
	return a, nil
}

// ---- 组件划分 ----

const maxComponents = 24

// groupDirs 以文件父目录为组件键；超过上限时逐级向上聚合。
func groupDirs(files []srcFile) map[string][]srcFile {
	dirOf := func(f string) string {
		d := path.Dir(f)
		if d == "." || d == "/" {
			return "."
		}
		return d
	}
	groups := map[string][]srcFile{}
	for _, f := range files {
		d := dirOf(f.path)
		groups[d] = append(groups[d], f)
	}
	for len(groups) > maxComponents {
		next := map[string][]srcFile{}
		for d, fs := range groups {
			pd := dirOf(d)
			if d == "." { // 根组件无法再上聚合，但文件数已超限也只能保留
				pd = "."
			}
			next[pd] = append(next[pd], fs...)
		}
		if len(next) == len(groups) { // 无法收敛（极端情况），防死循环
			break
		}
		groups = next
	}
	return groups
}

var langByExt = map[string]string{
	".go": "Go", ".ts": "TS", ".tsx": "TS", ".js": "JS", ".jsx": "JS",
	".mjs": "JS", ".cjs": "JS", ".py": "Py", ".rs": "Rust", ".java": "Java",
	".kt": "Kotlin", ".vue": "Vue", ".svelte": "Svelte", ".c": "C",
	".cc": "C++", ".cpp": "C++", ".h": "C/C++", ".hpp": "C++", ".cs": "C#",
	".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".scala": "Scala",
	".sh": "Shell", ".ps1": "PS", ".css": "CSS", ".scss": "SCSS", ".html": "HTML",
}

// primaryLang 组件内出现最多的语言。
func primaryLang(files []srcFile) string {
	counts := map[string]int{}
	best, bestN := "", 0
	for _, f := range files {
		lang := langByExt[strings.ToLower(path.Ext(f.path))]
		if lang == "" {
			continue
		}
		counts[lang]++
		if counts[lang] > bestN {
			best, bestN = lang, counts[lang]
		}
	}
	return best
}

// componentType 按目录名启发推断组件类型。
func componentType(dir string) string {
	l := strings.ToLower(dir)
	has := func(keys ...string) bool {
		for _, seg := range strings.Split(l, "/") {
			for _, k := range keys {
				if seg == k || strings.Contains(seg, k) {
					return true
				}
			}
		}
		return false
	}
	switch {
	case has("renderer", "frontend", "web", "ui", "client", "pages"):
		return "frontend"
	case has("docs", "doc", "documentation"):
		return "external"
	case has("scripts", "script", "tools", "tool", "ci", "deploy", "infra"):
		return "cloud"
	case has("db", "database", "sql", "migration"):
		return "database"
	default:
		return "backend"
	}
}

// kebabID 目录路径转 kebab id（"." → "root"）。
func kebabID(dir string) string {
	if dir == "." {
		return "root"
	}
	id := strings.ToLower(strings.ReplaceAll(dir, "/", "-"))
	var b strings.Builder
	for _, r := range id {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// ---- import 提取与解析 ----

var (
	reJSImport  = regexp.MustCompile(`(?:import\s+[^'"]*?\sfrom\s+|import\s+|from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]`)
	reGoBlock   = regexp.MustCompile(`(?s)import\s*\((.*?)\)`)
	reGoSingle  = regexp.MustCompile(`import\s+(?:[\w.]+\s+)?"([^"]+)"`)
	reQuoted    = regexp.MustCompile(`"([^"]+)"`)
	rePyImport  = regexp.MustCompile(`(?m)^\s*(?:from|import)\s+([A-Za-z0-9_.]+)`)
	reRustUse   = regexp.MustCompile(`(?m)^\s*use\s+([\w:]+)`)
	reCInclude  = regexp.MustCompile(`(?m)#include\s*[<"]([^>"]+)[>"]`)
	reJavaImprt = regexp.MustCompile(`(?m)^\s*import\s+(?:static\s+)?([\w.]+)`)
)

// extractImports 按扩展名提取 import 目标模块串。
func extractImports(f srcFile) []string {
	text := string(f.content)
	var out []string
	switch strings.ToLower(path.Ext(f.path)) {
	case ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte":
		for _, m := range reJSImport.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	case ".go":
		for _, m := range reGoBlock.FindAllStringSubmatch(text, -1) {
			for _, q := range reQuoted.FindAllStringSubmatch(m[1], -1) {
				out = append(out, q[1])
			}
		}
		for _, m := range reGoSingle.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	case ".py":
		for _, m := range rePyImport.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	case ".rs":
		for _, m := range reRustUse.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	case ".c", ".cc", ".cpp", ".h", ".hpp":
		for _, m := range reCInclude.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	case ".java", ".kt", ".scala":
		for _, m := range reJavaImprt.FindAllStringSubmatch(text, -1) {
			out = append(out, m[1])
		}
	}
	return out
}

// resolver 把 import 目标映射到仓内目录（外部包返回空串）。
type resolver struct {
	dirs       []string // 组件目录（长前缀优先）
	dirSet     map[string]bool
	fileSet    map[string]bool
	goModPath  string
	existCache map[string]bool
}

func newResolver(compDirs []string, files []srcFile) *resolver {
	r := &resolver{dirSet: map[string]bool{}, fileSet: map[string]bool{}, existCache: map[string]bool{}}
	r.dirs = append(r.dirs, compDirs...)
	for _, f := range files {
		r.fileSet[f.path] = true
		for d := path.Dir(f.path); d != "." && d != "/"; d = path.Dir(d) {
			r.dirSet[d] = true
		}
	}
	return r
}

// targetExists 目标路径是否真实落在仓内（目录、文件，或可补扩展名/下级的模块路径）。
func (r *resolver) targetExists(p string) bool {
	if v, ok := r.existCache[p]; ok {
		return v
	}
	ex := r.dirSet[p] || r.fileSet[p]
	if !ex {
		for f := range r.fileSet {
			if strings.HasPrefix(f, p+"/") || strings.HasPrefix(f, p+".") {
				ex = true
				break
			}
		}
	}
	r.existCache[p] = ex
	return ex
}

// resolve 返回目标所属组件目录；无法映射到仓内返回 false。
func (r *resolver) resolve(target, fileDir string) (string, bool) {
	var p string
	relative := false
	switch {
	case strings.HasPrefix(target, "./") || strings.HasPrefix(target, "../"):
		relative = true
		p = path.Clean(path.Join(fileDir, target))
		if p == ".." || strings.HasPrefix(p, "../") {
			return "", false
		}
	case r.goModPath != "" && (target == r.goModPath || strings.HasPrefix(target, r.goModPath+"/")):
		p = strings.TrimPrefix(target, r.goModPath+"/")
		p = strings.TrimPrefix(p, r.goModPath)
		p = strings.TrimPrefix(p, "/")
	case strings.HasPrefix(target, "crate::"): // rust 仓内模块
		p = strings.ReplaceAll(strings.TrimPrefix(target, "crate::"), "::", "/")
	case !strings.Contains(target, "/"):
		// python/java 点分包名，仅在确为仓内目录时映射（避免 npm 裸包名误配）
		if dot := strings.ReplaceAll(target, ".", "/"); r.dirSet[dot] {
			p = dot
		} else {
			return "", false
		}
	default:
		// 含 / 的非相对路径：可能是仓内路径（go module 之外的 mono-repo）或外部包
		if r.targetExists(target) {
			p = target
		} else if dot := strings.ReplaceAll(target, ".", "/"); r.targetExists(dot) {
			p = dot
		} else {
			return "", false
		}
	}
	// 非相对 import 须确认目标真实存在，否则视为外部包丢弃
	//（相对 import 本身即仓内引用，免验）
	if !relative && !r.targetExists(p) {
		return "", false
	}
	// 目标是文件则取其目录，再向组件目录做最长前缀匹配
	tdir := p
	if !r.dirSet[tdir] && tdir != "." {
		tdir = path.Dir(tdir)
	}
	if tdir == "/" {
		tdir = "."
	}
	best, bestLen := "", -1
	for _, d := range r.dirs {
		if d == "." {
			if tdir == "." && bestLen < 0 {
				best, bestLen = ".", 0
			}
			continue
		}
		if tdir == d || strings.HasPrefix(tdir, d+"/") {
			if len(d) > bestLen {
				best, bestLen = d, len(d)
			}
		}
	}
	if best == "" {
		return "", false
	}
	return best, true
}

// ---- spec 构建 ----

// topDir 组件目录的第一层（boundary 键）；根组件返回 "\x00" 使其排最前。
func topDir(d string) string {
	if d == "." {
		return "\x00"
	}
	if i := strings.IndexByte(d, '/'); i >= 0 {
		return d[:i]
	}
	return d
}

// sortCompDirs 组件目录排序：按 boundary（第一层目录）分组，组内按目录名。
// spec 与 insights 共用，保证两端点组件集合、id 与顺序完全一致。
func sortCompDirs(dirs []string) {
	sort.Slice(dirs, func(i, j int) bool {
		ti, tj := topDir(dirs[i]), topDir(dirs[j])
		if ti != tj {
			return ti < tj
		}
		return dirs[i] < dirs[j]
	})
}

// fileCompDir 文件所属组件目录（聚合后可能不等于父目录）。
func fileCompDir(groups map[string][]srcFile, fileDir string) string {
	for d := fileDir; ; d = path.Dir(d) {
		if _, ok := groups[d]; ok {
			return d
		}
		if d == "." || d == "/" {
			return "."
		}
	}
}

// dirEdge 目录级有向边。
type dirEdge struct{ from, to string }

// importEdges 把 import 解析聚合为目录级边计数；import 取自各文件预分析结果
// （Go 文件为 go/ast 精确结果，其余语言为正则近似）。
func importEdges(p *Project, groups map[string][]srcFile, dirs []string, files []srcFile, idOf map[string]string, infos map[string]*fileInfo) map[dirEdge]int {
	rsv := newResolver(dirs, files)
	rsv.goModPath = detectGoModule(p.Path, files)
	counts := map[dirEdge]int{}
	for _, f := range files {
		fileDir := path.Dir(f.path)
		if fileDir == "/" {
			fileDir = "."
		}
		from := fileCompDir(groups, fileDir)
		if _, ok := idOf[from]; !ok {
			continue // 文件所属组件目录不在最终组件集中（理论上不发生）
		}
		for _, target := range infos[f.path].imports {
			to, ok := rsv.resolve(target, fileDir)
			if !ok || to == from {
				continue // 外部包与自环丢弃
			}
			if _, ok := idOf[to]; !ok {
				continue
			}
			counts[dirEdge{from, to}]++
		}
	}
	return counts
}

// compactNum 行数紧凑格式：<1k 原样；1k–10k 保留一位小数（如 1.2k）；≥10k 取整（如 12k）。
func compactNum(n int) string {
	if n < 1000 {
		return itoa(n)
	}
	if n < 10000 {
		w, f := n/1000, (n%1000)/100
		if f == 0 {
			return itoa(w) + "k"
		}
		return itoa(w) + "." + itoa(f) + "k"
	}
	return itoa(n/1000) + "k"
}

// fullwidthRanges 与 vendor/archify FULLWIDTH_RE 等价的 East Asian Wide/Fullwidth 码点区间。
var fullwidthRanges = [][2]rune{
	{0x1100, 0x115F}, {0x231A, 0x231B}, {0x2329, 0x232A}, {0x23E9, 0x23EC},
	{0x23F0, 0x23F0}, {0x23F3, 0x23F3}, {0x25FD, 0x25FE}, {0x2614, 0x2615},
	{0x2630, 0x2637}, {0x2648, 0x2653}, {0x267F, 0x267F}, {0x268A, 0x268F},
	{0x2693, 0x2693}, {0x26A1, 0x26A1}, {0x26AA, 0x26AB}, {0x26BD, 0x26BE},
	{0x26C4, 0x26C5}, {0x26CE, 0x26CE}, {0x26D4, 0x26D4}, {0x26EA, 0x26EA},
	{0x26F2, 0x26F3}, {0x26F5, 0x26F5}, {0x26FA, 0x26FA}, {0x26FD, 0x26FD},
	{0x2705, 0x2705}, {0x270A, 0x270B}, {0x2728, 0x2728}, {0x274C, 0x274C},
	{0x274E, 0x274E}, {0x2753, 0x2755}, {0x2757, 0x2757}, {0x2795, 0x2797},
	{0x27B0, 0x27B0}, {0x27BF, 0x27BF}, {0x2B1B, 0x2B1C}, {0x2B50, 0x2B50},
	{0x2B55, 0x2B55}, {0x2E80, 0xA4CF}, {0xA960, 0xA97C}, {0xAC00, 0xD7A3},
	{0xF900, 0xFAFF}, {0xFE10, 0xFE19}, {0xFE30, 0xFE6F}, {0xFF01, 0xFF60},
	{0xFFE0, 0xFFE6}, {0x16FE0, 0x18DFF}, {0x1AFF0, 0x1AFFF}, {0x1B000, 0x1B2FF},
	{0x1F000, 0x1FAFF}, {0x20000, 0x3FFFD},
}

// textUnits 与 vendor/archify 的 textUnits 同款估算：全角码点计 2，其余计 1。
// （变体选择符序列未特判——生成的 sublabel 不含 emoji，label 为目录名，差异可忽略。）
func textUnits(s string) int {
	u := 0
	for _, r := range s {
		w := 1
		for _, rg := range fullwidthRanges {
			if r >= rg[0] && r <= rg[1] {
				w = 2
				break
			}
		}
		u += w
	}
	return u
}

// compWidth 组件宽度：默认 120，按 label/sublabel 最小可读宽度自适应加宽，与
// vendor/archify 布局校验同款估算（sublabel 最小 6px 字号、单位宽 0.6、横向留白 8；
// label 按 6.6px/单位、允许超出宽度 8）。+2 为估算余量。上限 202：网格 x 向间距
// 210，相邻组件须留 ≥8px 间隙，超出此上限的超长 sublabel 仍会被渲染器拒绝。
func compWidth(label, sublabel string) int {
	w := 120
	if need := (textUnits(sublabel)*36+9)/10 + 8 + 2; need > w {
		w = need
	}
	if need := (textUnits(label)*66+9)/10 - 8 + 2; need > w {
		w = need
	}
	if w > 202 {
		w = 202
	}
	return w
}

// buildSpec 从共享分析产物组装 archify architecture v1 spec（严格保持 schema 兼容：
// component 仅 id/type/label/sublabel/pos/size/sources，connection 仅 id/from/to/label）。
func buildSpec(p *Project, a *analysis) *archSpec {
	spec := &archSpec{
		SchemaVersion: 1,
		DiagramType:   "architecture",
		Components:    []*archComponent{},
		Connections:   []*archConnection{},
	}
	for i, d := range a.dirs {
		fs := a.groups[d]
		id := a.idOf[d]
		label := path.Base(d)
		if d == "." {
			label = p.Name
		}
		// sublabel：N files · Lang · X 行 · 热 H（heat=0 时省略热度段）
		lines, heat := 0, 0
		for _, f := range fs {
			lines += a.infos[f.path].lines
			heat += a.churn[f.path]
		}
		sublabel := itoa(len(fs)) + " files"
		if lang := primaryLang(fs); lang != "" {
			sublabel += " · " + lang
		}
		sublabel += " · " + compactNum(lines) + " 行"
		if heat > 0 {
			sublabel += " · 热 " + itoa(heat)
		}
		sources := []archSource{}
		for j, f := range fs {
			if j >= 3 { // 代表文件最多列 3 个
				break
			}
			sources = append(sources, archSource{Path: f.path})
		}
		spec.Components = append(spec.Components, &archComponent{
			ID:       id,
			Type:     componentType(d),
			Label:    label,
			Sublabel: sublabel,
			Pos:      [2]int{40 + (i%4)*210, 40 + (i/4)*140},
			Size:     [2]int{compWidth(label, sublabel), 60},
			Sources:  sources,
		})
	}

	// boundary：第一层目录分组（根组件不 wrap）
	topGroups := map[string][]string{}
	topOrder := []string{}
	for _, d := range a.dirs {
		top := topDir(d)
		if top == "\x00" {
			continue
		}
		if _, ok := topGroups[top]; !ok {
			topOrder = append(topOrder, top)
		}
		topGroups[top] = append(topGroups[top], a.idOf[d])
	}
	sort.Strings(topOrder)
	for _, top := range topOrder {
		spec.Boundaries = append(spec.Boundaries, &archBoundary{
			Kind: "region", Label: top, Wraps: topGroups[top],
		})
	}

	// 连接一：import 目录级边（计数 >1 时 label "×N"）。
	// 与 IPC 边同对的 import 边省略——实测 archify showcase 的 label-route-clearance
	// 校验要求边标签与所有路线（含平行边路线）留 ≥4px 间隙，平行边各带标签必然
	// 校验失败（路线本身只隔 14px，标签高 14px），故同对冲突时仅保留信息更稀缺的
	// IPC 边；被省略的 import 依赖关系仍可从 /arch/insights 的 import 边取得。
	ipcEdges := aggregateIpcEdges(a.rendCh, a.mainCh, a.wcCh)
	ipcPair := map[string]bool{}
	for _, e := range ipcEdges {
		ipcPair[e.from+"\x00"+e.to] = true
	}
	edges := make([]dirEdge, 0, len(a.counts))
	for e := range a.counts {
		edges = append(edges, e)
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].from != edges[j].from {
			return edges[i].from < edges[j].from
		}
		return edges[i].to < edges[j].to
	})
	for _, e := range edges {
		from, to := a.idOf[e.from], a.idOf[e.to]
		if ipcPair[from+"\x00"+to] {
			continue
		}
		c := &archConnection{
			ID:   from + "-to-" + to,
			From: from,
			To:   to,
		}
		if n := a.counts[e]; n > 1 {
			c.Label = "×" + itoa(n)
		}
		spec.Connections = append(spec.Connections, c)
	}
	// 连接二：IPC 通道边（id 加 -ipc 后缀，label "IPC ×N"，N=配对通道数）。
	for _, e := range ipcEdges {
		spec.Connections = append(spec.Connections, &archConnection{
			ID:    e.from + "-to-" + e.to + "-ipc",
			From:  e.from,
			To:    e.to,
			Label: "IPC ×" + itoa(len(e.channels)),
		})
	}

	// meta
	short := a.sha
	if len(short) > 7 {
		short = short[:7]
	}
	spec.Meta = archMeta{
		Title:          p.Name + " @ " + short,
		QualityProfile: "showcase",
		Output:         "architecture.html",
	}
	repo := &archRepo{Revision: a.sha}
	if out, err := gitRun(p.Path, 10*time.Second, "config", "--get", "remote.origin.url"); err == nil {
		if url := strings.TrimSpace(out); url != "" {
			repo.URL = url
			switch {
			case strings.Contains(url, "github.com"):
				repo.Provider = "github"
			case strings.Contains(url, "gitlab.com"):
				repo.Provider = "gitlab"
			}
		}
	}
	spec.Meta.Repository = repo
	return spec
}

// detectGoModule 读取 go.mod 的 module 路径（用于把 module 内 import 映射回目录）。
func detectGoModule(root string, files []srcFile) string {
	var data []byte
	for _, f := range files {
		if f.path == "go.mod" {
			data = f.content
			break
		}
	}
	if data == nil {
		if d, err := os.ReadFile(filepath.Join(root, "go.mod")); err == nil {
			data = d
		}
	}
	for _, ln := range strings.Split(string(data), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(ln), "module "); ok {
			return strings.TrimSpace(rest)
		}
	}
	return ""
}
