package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestArchitectureQuestionUsesCurrentContextWithoutDrawingContract(t *testing.T) {
	context := json.RawMessage(`{"mode":"delta","ref":"HEAD","baseRef":"v0.6.0","spec":{"components":[{"id":"current_api"}]}}`)
	prompt := buildAiArchRequestPrompt(aiArchRequest{Action: "ask", Prompt: "为什么 API 依赖存储？", Context: context})
	for _, text := range []string{"为什么 API 依赖存储？", `"answer"`, string(context), "只读"} {
		if !strings.Contains(prompt, text) {
			t.Errorf("question prompt missing %q", text)
		}
	}
	if strings.Contains(prompt, "schema_version") {
		t.Fatal("question inherited drawing-only output contract")
	}
}

func TestArchitectureEditPreservesCurrentSpecAndReference(t *testing.T) {
	context := json.RawMessage(`{"mode":"current","spec":{"components":[{"id":"user_group"}]}}`)
	prompt := buildAiArchRequestPrompt(aiArchRequest{Action: "edit", Prompt: "保留模块，调整分组", Ref: "release", Context: context})
	for _, text := range []string{"保留模块，调整分组", "release", string(context), "完整 spec", "不要创建或修改任何文件"} {
		if !strings.Contains(prompt, text) {
			t.Errorf("edit prompt missing %q", text)
		}
	}
}

func TestCodexQuestionStreamExtractsOnlyFinalAnswer(t *testing.T) {
	raw := "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"aggregated_output\":\"internal output\"}}\n" +
		"{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"{\\\"answer\\\":\\\"API 通过接口访问存储\\\"}\"}}\n"
	got := extractAssistantText("codex", raw)
	if got != `{"answer":"API 通过接口访问存储"}` {
		t.Fatalf("unexpected answer: %q", got)
	}
}

func TestInvalidArchitectureCannotReplaceCurrentDiagram(t *testing.T) {
	for _, input := range []string{`{"answer":"说明"}`, `{"diagram_type":"architecture","components":[]}`, `not json`} {
		if _, err := extractSpec(input); err == nil {
			t.Errorf("accepted invalid replacement: %s", input)
		}
	}
}

func TestAiHttpErrorMessageExtractsProviderDetail(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{name: "error object", raw: `{"error":{"message":"API key 已过期","type":"auth_error"}}`, want: "API key 已过期"},
		{name: "error string", raw: `{"error":"模型不存在"}`, want: "模型不存在"},
		{name: "top-level message", raw: `{"message":"请求频率过高"}`, want: "请求频率过高"},
		{name: "plain response", raw: `<html>Bad Gateway</html>`, want: `<html>Bad Gateway</html>`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := aiHttpErrorMessage([]byte(tc.raw)); got != tc.want {
				t.Fatalf("unexpected message: got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRunAiHttpReportsStatusAndRedactsKey(t *testing.T) {
	const secret = "test-secret-key"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"message":"密钥 ` + secret + ` 已失效"}}`))
	}))
	defer server.Close()
	_, err := runAiHttp(context.Background(), aiConfig{BaseURL: server.URL, APIKey: secret, Model: "test-model"}, "test")
	if err == nil {
		t.Fatal("expected HTTP error")
	}
	message := err.Error()
	if !strings.Contains(message, "HTTP 401") || !strings.Contains(message, "密钥 [已隐藏] 已失效") {
		t.Fatalf("missing actionable detail: %q", message)
	}
	if strings.Contains(message, secret) {
		t.Fatalf("API key leaked in error: %q", message)
	}
}

func TestDetectAiCliFindsUserLevelInstallations(t *testing.T) {
	cases := []struct {
		name     string
		cliName  string
		relative []string
	}{
		{name: "Kimi official directory", cliName: "kimi", relative: []string{".kimi-code", "bin", "kimi"}},
		{name: "Codex user bin", cliName: "codex", relative: []string{".local", "bin", "codex"}},
		{name: "Codex under nvm", cliName: "codex", relative: []string{".nvm", "versions", "node", "v24.18.1", "bin", "codex"}},
		{name: "Kimi under mise", cliName: "kimi", relative: []string{".local", "share", "mise", "shims", "kimi"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(append([]string{home}, tc.relative...)...)
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0755); err != nil {
				t.Fatal(err)
			}
			notInPath := func(string) (string, error) { return "", os.ErrNotExist }
			cli := detectAiCliAt(home, notInPath)
			if cli == nil || cli.name != tc.cliName || cli.path != path {
				t.Fatalf("detection failed: got %#v, want %s at %s", cli, tc.cliName, path)
			}
		})
	}
}

func TestWithAiCliPathPrependsRuntimeDirectory(t *testing.T) {
	dir := filepath.Join("home", "user", ".local", "bin")
	env := withAiCliPath([]string{"HOME=/home/user", "Path=/usr/bin"}, dir)
	wantPath := "Path=" + dir + string(os.PathListSeparator) + "/usr/bin"
	if env[1] != wantPath || env[0] != "HOME=/home/user" {
		t.Fatalf("unexpected environment: %#v", env)
	}
	env = withAiCliPath([]string{"HOME=/home/user"}, dir)
	if len(env) != 2 || env[1] != "PATH="+dir {
		t.Fatalf("missing PATH fallback: %#v", env)
	}
}
