package main

// fops.go：文件树操作 —— 重命名/移动（move）、复制（copy）、删除（delete）、
// 新建目录（mkdir）、新建文档（create）。供前端文件树右键菜单与拖拽移动使用。
// 所有路径相对项目根（/ 分隔），经 resolveDoc 防越界；移动/删除会同步迁移
// .timber/annotations.json 里的批注锚点，避免批注指向已不存在的路径。

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func (s *server) handleFsOp(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req struct {
		Op      string `json:"op"` // move | copy | delete | mkdir | create
		From    string `json:"from"`
		To      string `json:"to"`
		Content string `json:"content"`
	}
	if err := readJSON(r, &req); err != nil {
		writeError(w, 400, "请求体解析失败")
		return
	}

	resolve := func(rel string) (string, error) {
		clean := path.Clean("/" + rel) // 归一：去掉 ./ 与重复斜杠
		clean = strings.TrimPrefix(clean, "/")
		if clean == "" || clean == "." {
			return "", fmt.Errorf("路径不能为空")
		}
		return resolveDoc(p.Path, clean)
	}

	var err error
	switch req.Op {
	case "move":
		var fromAbs, toAbs string
		if fromAbs, err = resolve(req.From); err == nil {
			toAbs, err = resolve(req.To)
		}
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		err = s.fsMove(p.Path, req.From, req.To, fromAbs, toAbs)
	case "copy":
		var fromAbs, toAbs string
		if fromAbs, err = resolve(req.From); err == nil {
			toAbs, err = resolve(req.To)
		}
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		err = fsCopy(fromAbs, toAbs)
	case "delete":
		var fromAbs string
		if fromAbs, err = resolve(req.From); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if err = fsDelete(fromAbs); err == nil {
			err = s.anns.removeDoc(p.Path, path.Clean(req.From))
		}
	case "mkdir":
		var toAbs string
		if toAbs, err = resolve(req.To); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		err = os.Mkdir(toAbs, 0o755)
	case "create":
		var toAbs string
		if toAbs, err = resolve(req.To); err != nil {
			writeError(w, 400, err.Error())
			return
		}
		if err = os.MkdirAll(filepath.Dir(toAbs), 0o755); err == nil {
			// O_EXCL：同名文件已存在时报错而不是静默覆盖
			var f *os.File
			if f, err = os.OpenFile(toAbs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644); err == nil {
				_, err = f.WriteString(req.Content)
				if cerr := f.Close(); err == nil {
					err = cerr
				}
			}
		}
	default:
		writeError(w, 400, "不支持的 op："+req.Op)
		return
	}
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// fsMove 移动/重命名：目标不得已存在、目录不得移入自身内部；成功后迁移批注。
func (s *server) fsMove(projectPath, from, to, fromAbs, toAbs string) error {
	if from == to {
		return fmt.Errorf("源路径与目标路径相同")
	}
	if strings.HasPrefix(to, from+"/") {
		return fmt.Errorf("不能把目录移动到它自身内部")
	}
	if _, err := os.Stat(fromAbs); err != nil {
		return fmt.Errorf("源路径不存在：%w", err)
	}
	if _, err := os.Lstat(toAbs); err == nil {
		return fmt.Errorf("目标已存在：%s", to)
	}
	if err := os.Rename(fromAbs, toAbs); err != nil {
		return err
	}
	return s.anns.renameDoc(projectPath, path.Clean(from), path.Clean(to))
}

// fsCopy 复制：文件直拷，目录递归复制（目标不得已存在）。
func fsCopy(fromAbs, toAbs string) error {
	if _, err := os.Lstat(toAbs); err == nil {
		return fmt.Errorf("目标已存在")
	}
	info, err := os.Stat(fromAbs)
	if err != nil {
		return fmt.Errorf("源路径不存在：%w", err)
	}
	if !info.IsDir() {
		return copyFile(fromAbs, toAbs, info)
	}
	return filepath.WalkDir(fromAbs, func(cur string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(fromAbs, cur)
		dst := filepath.Join(toAbs, rel)
		if d.IsDir() {
			return os.Mkdir(dst, 0o755)
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		return copyFile(cur, dst, fi)
	})
}

func copyFile(src, dst string, info os.FileInfo) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// fsDelete 删除文件或目录（目录递归）；调用方（前端）负责确认。
func fsDelete(abs string) error {
	info, err := os.Stat(abs)
	if err != nil {
		return fmt.Errorf("路径不存在：%w", err)
	}
	if info.IsDir() {
		return os.RemoveAll(abs)
	}
	return os.Remove(abs)
}
