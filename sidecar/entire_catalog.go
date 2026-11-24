package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

type entireLocation struct {
	id     string
	tree   string
	time   int64
	legacy bool
}

func checkpointIDFromRef(ref string) string {
	return ref[strings.LastIndex(ref, "/")+1:]
}

func entireObjectFile(tree, file string) string {
	separator := ":"
	if strings.Contains(tree, ":") {
		separator = "/"
	}
	return tree + separator + strings.TrimPrefix(file, "/")
}

func listLegacyEntireLocations(ctx context.Context, dir string) ([]entireLocation, error) {
	refs, err := gitRunContext(ctx, dir, 10*time.Second, "for-each-ref", "--format=%(objectname) %(committerdate:unix)",
		"--sort=-committerdate", "refs/heads/entire/checkpoints/v1", "refs/remotes/*/entire/checkpoints/v1")
	if err != nil {
		return nil, err
	}
	var locations []entireLocation
	seenTrees := map[string]bool{}
	for _, line := range strings.Split(refs, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || seenTrees[fields[0]] {
			continue
		}
		seenTrees[fields[0]] = true
		timeValue, _ := strconv.ParseInt(fields[1], 10, 64)
		files, err := gitRunContext(ctx, dir, 20*time.Second, "ls-tree", "-r", "--name-only", fields[0])
		if err != nil {
			return nil, err
		}
		for _, file := range strings.Split(files, "\n") {
			parts := strings.Split(file, "/")
			if len(parts) != 3 || len(parts[0]) != 2 || parts[2] != "metadata.json" {
				continue
			}
			id := parts[0] + parts[1]
			if entireIDRe.MatchString(id) {
				locations = append(locations, entireLocation{id: id, tree: fields[0] + ":" + path.Dir(file), time: timeValue, legacy: true})
			}
		}
	}
	return locations, nil
}

func listEntireLocations(ctx context.Context, dir string) ([]entireLocation, error) {
	refs, err := readEntireRefs(ctx, dir)
	if err != nil {
		return nil, err
	}
	locations := make([]entireLocation, 0, len(refs))
	seen := map[string]bool{}
	for _, ref := range refs {
		id := checkpointIDFromRef(ref.Ref)
		key := strings.ToLower(id)
		if entireIDRe.MatchString(id) && !seen[key] {
			locations = append(locations, entireLocation{id: id, tree: ref.Sha, time: ref.Date})
			seen[key] = true
		}
	}
	legacy, err := listLegacyEntireLocations(ctx, dir)
	if err != nil {
		return nil, err
	}
	for _, location := range legacy {
		key := strings.ToLower(location.id)
		if !seen[key] {
			locations = append(locations, location)
			seen[key] = true
		}
	}
	sort.SliceStable(locations, func(i, j int) bool {
		if locations[i].time == locations[j].time {
			return locations[i].id < locations[j].id
		}
		return locations[i].time > locations[j].time
	})
	return locations, nil
}

// A batch keeps browsing fast even when a page contains many sessions.
func readEntireBlobs(parent context.Context, dir string, objects []string) (map[string][]byte, error) {
	blobs := make(map[string][]byte, len(objects))
	if len(objects) == 0 {
		return blobs, nil
	}
	ctx, cancel := context.WithTimeout(parent, 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "cat-file", "--batch")
	cmd.Dir = dir
	hideWindow(cmd)
	cmd.Stdin = strings.NewReader(strings.Join(objects, "\n") + "\n")
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(stdout)
	read := func() error {
		for _, object := range objects {
			header, err := reader.ReadString('\n')
			if err != nil {
				return err
			}
			if strings.HasSuffix(header, " missing\n") || strings.HasSuffix(header, " ambiguous\n") {
				continue
			}
			fields := strings.Fields(header)
			if len(fields) != 3 {
				return fmt.Errorf("Git 返回了无法解析的对象头")
			}
			size, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil || size < 0 {
				return fmt.Errorf("Git 返回了无效的对象大小")
			}
			if fields[1] == "blob" && size <= 256<<10 {
				buffer := make([]byte, int(size))
				if _, err := io.ReadFull(reader, buffer); err != nil {
					return err
				}
				blobs[object] = buffer
			} else if _, err := io.CopyN(io.Discard, reader, size); err != nil {
				return err
			}
			if _, err := reader.ReadByte(); err != nil {
				return err
			}
		}
		return nil
	}
	if err := read(); err != nil {
		cancel()
		_ = cmd.Wait()
		return nil, err
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("读取 Entire 对象失败：%w %s", err, strings.TrimSpace(stderr.String()))
	}
	return blobs, nil
}

func catalogObject(tree, file string) string {
	file = strings.TrimPrefix(file, "/")
	clean := path.Clean(file)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") || strings.HasPrefix(clean, "/") || strings.ContainsAny(file, "\r\n\x00") {
		return ""
	}
	return entireObjectFile(tree, clean)
}

type entireCommitLink struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
}

type entireCatalogEntry struct {
	CheckpointID string             `json:"checkpointId"`
	Index        int                `json:"index"`
	SessionID    string             `json:"sessionId"`
	Agent        string             `json:"agent"`
	Model        string             `json:"model"`
	Branch       string             `json:"branch"`
	Time         int64              `json:"time"`
	Prompt       string             `json:"prompt"`
	Files        int                `json:"files"`
	Commits      []entireCommitLink `json:"commits,omitempty"`
}

func entireCommitLinks(ctx context.Context, dir string, locations []entireLocation) (map[string][]entireCommitLink, error) {
	ids := map[string]bool{}
	for _, location := range locations {
		ids[strings.ToLower(location.id)] = true
	}
	links := map[string][]entireCommitLink{}
	out, err := gitRunContext(ctx, dir, 25*time.Second, "log", "--all", "--date-order", "--regexp-ignore-case",
		"--grep=^Entire-Checkpoint:", "--format=%H%x1f%s%x1f"+checkpointTrailers, "--")
	if err != nil {
		return nil, err
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(line, "\x1f", 3)
		if len(fields) != 3 {
			continue
		}
		for _, id := range checkpointIDs(fields[2]) {
			id = strings.ToLower(id)
			if ids[id] {
				links[id] = append(links[id], entireCommitLink{SHA: fields[0], Subject: fields[1]})
			}
		}
	}
	return links, nil
}

func (s *server) handleEntireSessions(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	if !isGitRepo(p.Path) {
		writeNotRepo(w)
		return
	}
	locations, err := listEntireLocations(r.Context(), p.Path)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
	offset = min(max(0, offset), len(locations))
	end := min(offset+40, len(locations))
	page := locations[offset:end]
	entries := []entireCatalogEntry{}
	unreadable := 0
	linksUnavailable := false
	if len(page) > 0 {
		blobs, err := readEntireBlobs(r.Context(), p.Path, checkpointRootObjects(page))
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		roots := make([]entireRootMeta, len(page))
		var objects []string
		for i, location := range page {
			if json.Unmarshal(blobs[entireObjectFile(location.tree, "metadata.json")], &roots[i]) != nil {
				unreadable++
				continue
			}
			for _, session := range roots[i].Sessions {
				for _, file := range []string{session.Metadata, session.Prompt} {
					if object := catalogObject(location.tree, file); object != "" {
						objects = append(objects, object)
					}
				}
			}
		}
		blobs, err = readEntireBlobs(r.Context(), p.Path, objects)
		if err != nil {
			writeError(w, 500, err.Error())
			return
		}
		links, err := entireCommitLinks(r.Context(), p.Path, page)
		linksUnavailable = err != nil
		for i, location := range page {
			for index, session := range roots[i].Sessions {
				var meta entireSessionMeta
				_ = json.Unmarshal(blobs[catalogObject(location.tree, session.Metadata)], &meta)
				prompt := strings.TrimSpace(string(blobs[catalogObject(location.tree, session.Prompt)]))
				prompt, _, _ = strings.Cut(prompt, "\n")
				if runes := []rune(prompt); len(runes) > 180 {
					prompt = string(runes[:180]) + "…"
				}
				date := location.time
				if location.legacy {
					created := roots[i].CreatedAt
					if created == "" {
						created = meta.CreatedAt
					}
					if parsed, err := time.Parse(time.RFC3339, created); err == nil {
						date = parsed.Unix()
					}
				}
				branch := roots[i].Branch
				if branch == "" {
					branch = meta.Branch
				}
				entries = append(entries, entireCatalogEntry{CheckpointID: location.id, Index: index, SessionID: meta.SessionID,
					Agent: meta.Agent, Model: meta.Model, Branch: branch, Time: date, Prompt: prompt, Files: len(meta.FilesTouched),
					Commits: links[strings.ToLower(location.id)]})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "entries": entries, "total": len(locations), "nextOffset": end,
		"unreadable": unreadable, "linksUnavailable": linksUnavailable})
}

func checkpointRootObjects(locations []entireLocation) []string {
	objects := make([]string, 0, len(locations))
	for _, location := range locations {
		objects = append(objects, entireObjectFile(location.tree, "metadata.json"))
	}
	return objects
}
