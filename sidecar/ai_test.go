package main

import (
	"encoding/json"
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
