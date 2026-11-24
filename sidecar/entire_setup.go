package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
)

type entireSetupStatus struct {
	Repo               bool     `json:"repo"`
	Root               string   `json:"root"`
	CLI                bool     `json:"cli"`
	Version            string   `json:"version"`
	Configured         bool     `json:"configured"`
	Enabled            bool     `json:"enabled"`
	Agents             []string `json:"agents"`
	CodexAvailable     bool     `json:"codexAvailable"`
	PushDisabled       bool     `json:"pushDisabled"`
	Checkpoints        int      `json:"checkpoints"`
	CodexHookWarning   string   `json:"codexHookWarning,omitempty"`
	CodexNeedsApproval bool     `json:"codexNeedsApproval,omitempty"`
	ProbeError         string   `json:"probeError,omitempty"`
}

var entireSetups sync.Map // keyed by the Git common directory shared by linked worktrees

func (status entireSetupStatus) hasCodex() bool {
	return slices.ContainsFunc(status.Agents, func(agent string) bool { return strings.EqualFold(agent, "codex") })
}

func runEntire(parent context.Context, cwd, cli string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Dir = cwd
	hideWindow(cmd)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		for _, output := range []string{stderr.String(), stdout.String()} {
			if message := strings.TrimSpace(output); message != "" {
				return "", fmt.Errorf("%s", message)
			}
		}
		return "", err
	}
	return stdout.String(), nil
}

func entireRepoRoot(ctx context.Context, dir string) (string, error) {
	root, err := gitRunContext(ctx, dir, 10*time.Second, "rev-parse", "--show-toplevel")
	return strings.TrimSpace(root), err
}

func readEntireSetup(ctx context.Context, root, cli string) entireSetupStatus {
	status := entireSetupStatus{Repo: true, Root: root, CLI: cli != "", Agents: []string{}}
	locations, err := listEntireLocations(ctx, root)
	if err == nil {
		status.Checkpoints = len(locations)
	}
	if !status.CLI {
		return status
	}
	version, err := runEntire(ctx, root, cli, 5*time.Second, "--version")
	if err != nil {
		status.ProbeError = err.Error()
		return status
	}
	firstLine, _, _ := strings.Cut(version, "\n")
	status.Version = strings.TrimSpace(strings.TrimPrefix(firstLine, "Entire CLI "))
	status.CodexAvailable = detectNamedAiCli("codex") != nil
	data, err := runEntire(ctx, root, cli, 20*time.Second, "status", "--json")
	if err != nil {
		status.ProbeError = err.Error()
		return status
	}
	var report struct {
		Enabled      bool     `json:"enabled"`
		Agents       []string `json:"agents"`
		PushDisabled bool     `json:"checkpoint_push_disabled"`
		Error        string   `json:"error"`
		CodexHooks   *struct {
			Error            string   `json:"error"`
			MissingApprovals []string `json:"missing_approvals"`
		} `json:"codex_hooks"`
	}
	if err := json.Unmarshal([]byte(data), &report); err != nil {
		status.ProbeError = "Entire CLI 返回了无法读取的状态，请检查 CLI 版本"
		return status
	}
	status.Enabled = report.Enabled
	status.PushDisabled = report.PushDisabled
	status.Agents = append(status.Agents, report.Agents...)
	status.Configured = report.Error != "not set up"
	if report.Error != "" && report.Error != "not set up" && report.Error != "disabled" {
		status.ProbeError = report.Error
	}
	if report.CodexHooks != nil {
		status.CodexHookWarning = report.CodexHooks.Error
		status.CodexNeedsApproval = len(report.CodexHooks.MissingApprovals) > 0
	}
	return status
}

func (s *server) handleEntireStatus(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	root, err := entireRepoRoot(r.Context(), p.Path)
	if err != nil {
		writeJSON(w, 200, entireSetupStatus{Root: p.Path, Agents: []string{}})
		return
	}
	cli, _ := exec.LookPath("entire")
	writeJSON(w, 200, readEntireSetup(r.Context(), root, cli))
}

func (s *server) handleEntireEnable(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	root, err := entireRepoRoot(r.Context(), p.Path)
	if err != nil {
		writeError(w, 400, "当前项目不是 Git 仓库")
		return
	}
	cli, err := exec.LookPath("entire")
	if err != nil {
		writeError(w, 422, "项目所在环境未找到 Entire CLI")
		return
	}
	commonDir, err := gitRunContext(r.Context(), root, 10*time.Second, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	lockKey := filepath.Clean(strings.TrimSpace(commonDir))
	if runtime.GOOS == "windows" {
		lockKey = strings.ToLower(lockKey)
	}
	if _, running := entireSetups.LoadOrStore(lockKey, true); running {
		writeError(w, 409, "此仓库正在配置 Entire")
		return
	}
	defer entireSetups.Delete(lockKey)

	// Finish installing the hooks even if the user closes the dialog or changes projects.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 85*time.Second)
	defer cancel()
	status := readEntireSetup(ctx, root, cli)
	if status.ProbeError != "" {
		writeError(w, 422, status.ProbeError)
		return
	}
	if status.Enabled && status.hasCodex() {
		writeJSON(w, 200, status)
		return
	}
	if !status.CodexAvailable {
		writeError(w, 422, "项目所在环境未找到 Codex CLI")
		return
	}
	args := []string{"agent", "add", "codex"}
	if !status.Enabled {
		args = []string{"enable", "--agent", "codex", "--local", "--skip-push-sessions", "--no-init-repo", "--absolute-git-hook-path"}
		if !status.Configured {
			args = append(args, "--checkpoint-backend", "refs")
		}
	}
	if _, err := runEntire(ctx, root, cli, 30*time.Second, args...); err != nil {
		writeError(w, 500, "Entire 配置失败："+err.Error())
		return
	}
	status = readEntireSetup(ctx, root, cli)
	if status.ProbeError != "" {
		writeError(w, 500, status.ProbeError)
		return
	}
	if !status.Enabled || !status.hasCodex() {
		writeError(w, 500, "Entire 尚未检测到已启用的 Codex 钩子")
		return
	}
	writeJSON(w, 200, status)
}
