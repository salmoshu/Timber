package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxPastedImageBytes = 8 * 1024 * 1024

type imageAsset struct {
	Path         string `json:"path"`
	MarkdownPath string `json:"markdownPath"`
}

func (s *server) handleImageUpload(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPastedImageBytes*4/3+4096)
	var req struct {
		DocPath string `json:"docPath"`
		Data    string `json:"data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, "图片请求无效或超过 8 MB")
		return
	}
	asset, err := storeProjectImage(p.Path, req.DocPath, req.Data)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 201, asset)
}

func pathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Paste images beside their Markdown document. Names are generated and never overwrite files.
func storeProjectImage(root, docPath, encoded string) (*imageAsset, error) {
	if len(encoded) > maxPastedImageBytes*4/3+4 {
		return nil, fmt.Errorf("图片超过 8 MB")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > maxPastedImageBytes {
		return nil, fmt.Errorf("图片内容无效或超过 8 MB")
	}
	ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[http.DetectContentType(data)]
	if ext == "" {
		return nil, fmt.Errorf("支持 PNG、JPEG、GIF、WebP 图片")
	}
	if ext != ".webp" {
		config, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || config.Width <= 0 || config.Height <= 0 || int64(config.Width)*int64(config.Height) > 100_000_000 {
			return nil, fmt.Errorf("图片损坏或像素尺寸过大")
		}
	}
	doc, err := resolveDoc(root, docPath)
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(doc))
	if err != nil || !pathWithin(root, parent) {
		return nil, fmt.Errorf("图片必须保存在项目内")
	}
	dir := filepath.Join(parent, "assets")
	if err := os.Mkdir(dir, 0o755); err != nil && !os.IsExist(err) {
		return nil, err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil || !pathWithin(root, dir) {
		return nil, fmt.Errorf("图片目录不能指向项目外")
	}
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	name := "image-" + hex.EncodeToString(random[:]) + ext
	abs := filepath.Join(dir, name)
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(abs)
		return nil, fmt.Errorf("图片保存失败")
	}
	rel, _ := filepath.Rel(root, abs)
	return &imageAsset{Path: filepath.ToSlash(rel), MarkdownPath: "assets/" + name}, nil
}
