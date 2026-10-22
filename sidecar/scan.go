package main

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Project 一个已导入的文档项目（本地目录）。
type Project struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Path     string    `json:"path"`
	AddedAt  time.Time `json:"addedAt"`
	DocCount int       `json:"docCount"`
}

// DocNode 文档树节点（目录或文档）。
type DocNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"` // 相对项目根（/ 分隔）
	Type     string     `json:"type"` // dir | doc
	Ext      string     `json:"ext,omitempty"`
	Size     int64      `json:"size,omitempty"`
	Children []*DocNode `json:"children,omitempty"`
}

var docExts = map[string]bool{
	".md": true, ".markdown": true, ".mdown": true, ".mkd": true,
	".html": true, ".htm": true,
	".txt": true,
}

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "out": true,
	"build": true, "release": true, ".venv": true, "venv": true,
	"__pycache__": true, ".next": true, "target": true,
	".idea": true, ".vscode": true, ".toolchain": true,
}

// skipName 目录是否跳过：具名黑名单 + electron-builder 临时输出目录（release-v*）
func skipName(name string) bool {
	return skipDirs[name] || strings.HasPrefix(name, "release-")
}

// parseExts 解析请求传入的扩展名列表（".md,.html"）；空则用默认全量。
func parseExts(raw string) map[string]bool {
	if raw == "" {
		return docExts
	}
	m := map[string]bool{}
	for _, e := range strings.Split(raw, ",") {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" {
			continue
		}
		if !strings.HasPrefix(e, ".") {
			e = "." + e
		}
		m[e] = true
	}
	if len(m) == 0 {
		return docExts
	}
	return m
}

// registry 项目注册表（projects.json）。
type registry struct {
	mu       sync.Mutex
	file     string
	Projects []*Project `json:"projects"`
}

func newRegistry(file string) *registry {
	r := &registry{file: file}
	if data, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(data, r)
	}
	return r
}

func (r *registry) saveLocked() error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	tmp := r.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, r.file)
}

func (r *registry) list() []*Project {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*Project, len(r.Projects))
	copy(out, r.Projects)
	return out
}

func (r *registry) get(id string) *Project {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.Projects {
		if p.ID == id {
			return p
		}
	}
	return nil
}

// add 注册项目目录并扫描文档数；同路径幂等复用。
func (r *registry) add(path string) (*Project, error) {
	abs := path
	if !filepath.IsAbs(path) && !strings.HasPrefix(path, `\\`) {
		var err error
		abs, err = filepath.Abs(path)
		if err != nil {
			return nil, err
		}
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("目录不存在或不可读: %s", path)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	for _, p := range r.Projects {
		if strings.EqualFold(p.Path, abs) {
			return p, nil
		}
	}
	sum := sha1.Sum([]byte(strings.ToLower(abs)))
	p := &Project{
		ID:      hex.EncodeToString(sum[:])[:10],
		Name:    filepath.Base(abs),
		Path:    abs,
		AddedAt: time.Now(),
	}
	p.DocCount = countDocs(abs)
	r.Projects = append(r.Projects, p)
	if err := r.saveLocked(); err != nil {
		return nil, err
	}
	return p, nil
}

func (r *registry) remove(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, p := range r.Projects {
		if p.ID == id {
			r.Projects = append(r.Projects[:i], r.Projects[i+1:]...)
			_ = r.saveLocked()
			return true
		}
	}
	return false
}

// countDocs 统计项目内文档数量。
func countDocs(root string) int {
	n := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipName(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if docExts[strings.ToLower(filepath.Ext(d.Name()))] {
			n++
		}
		return nil
	})
	return n
}

// countDocsExts 按指定扩展名集统计文档数量。
func countDocsExts(root string, exts map[string]bool) int {
	n := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if skipName(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		}
		if exts[strings.ToLower(filepath.Ext(d.Name()))] {
			n++
		}
		return nil
	})
	return n
}

// scanTreeExts 按指定扩展名集构建文档树。
// v0.5.9 前经全局 docExts 暂存传参——/tree 并发请求（文档树 + 源码树同时加载）会互相
// 覆盖扩展名集，导致源码树偶尔只剩文档格式；改为显式传参，无共享状态。
func scanTreeExts(root string, exts map[string]bool) (*DocNode, error) {
	return scanTree(root, exts)
}

// scanTree 构建文档树（目录在前、名字排序；上限 5000 篇防失控）。
func scanTree(root string, exts map[string]bool) (*DocNode, error) {
	const maxDocs = 5000
	count := 0
	var walk func(dir, rel string) *DocNode
	walk = func(dir, rel string) *DocNode {
		node := &DocNode{Name: filepath.Base(dir), Path: rel, Type: "dir"}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return node
		}
		sort.Slice(entries, func(i, j int) bool {
			a, b := entries[i], entries[j]
			if a.IsDir() != b.IsDir() {
				return a.IsDir()
			}
			return strings.ToLower(a.Name()) < strings.ToLower(b.Name())
		})
		for _, e := range entries {
			name := e.Name()
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			if e.IsDir() {
				if skipName(name) {
					continue
				}
				sub := walk(filepath.Join(dir, name), childRel)
				if len(sub.Children) > 0 {
					node.Children = append(node.Children, sub)
				}
				continue
			}
			ext := strings.ToLower(filepath.Ext(name))
			if !exts[ext] || count >= maxDocs {
				continue
			}
			info, _ := e.Info()
			var size int64
			if info != nil {
				size = info.Size()
			}
			count++
			node.Children = append(node.Children, &DocNode{
				Name: name, Path: childRel, Type: "doc", Ext: ext, Size: size,
			})
		}
		return node
	}
	rootNode := walk(root, "")
	rootNode.Name = filepath.Base(root)
	return rootNode, nil
}

// resolveDoc 安全地把相对路径解析为项目内绝对路径（拒绝越界）。
func resolveDoc(projectPath, rel string) (string, error) {
	if rel == "" || strings.Contains(rel, "..") {
		return "", fmt.Errorf("非法文档路径: %q", rel)
	}
	abs := filepath.Join(projectPath, filepath.FromSlash(rel))
	cleanRoot := filepath.Clean(projectPath) + string(filepath.Separator)
	if !strings.HasPrefix(filepath.Clean(abs)+string(filepath.Separator), cleanRoot) &&
		filepath.Clean(abs) != filepath.Clean(projectPath) {
		return "", fmt.Errorf("路径越界: %q", rel)
	}
	return abs, nil
}
