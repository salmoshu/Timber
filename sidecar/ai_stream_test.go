package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseKimiToolProgress(t *testing.T) {
	line := `{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":"{\"command\":\"pwd\"}"}}]}`
	events := parseAiCliProgress("kimi", line)
	if len(events) != 1 {
		t.Fatalf("expected one tool event, got %#v", events)
	}
	event := events[0]
	if event.Stage != "tool" || event.Status != "running" || event.Label != "执行只读命令" || event.Detail != "pwd" || event.ToolID != "tool_1" {
		t.Fatalf("unexpected tool event: %#v", event)
	}
	done := parseAiCliProgress("kimi", `{"role":"tool","tool_call_id":"tool_1","content":"/tmp\n"}`)
	if len(done) != 1 || done[0].Status != "done" || done[0].Detail != "/tmp" || done[0].ToolID != "tool_1" {
		t.Fatalf("unexpected tool result: %#v", done)
	}
}

func TestParseCodexCommandProgress(t *testing.T) {
	started := parseAiCliProgress("codex", `{"type":"item.started","item":{"id":"cmd_1","type":"command_execution","command":"git status"}}`)
	if len(started) != 1 || started[0].Status != "running" || started[0].Detail != "git status" {
		t.Fatalf("unexpected command start: %#v", started)
	}
	completed := parseAiCliProgress("codex", `{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","command":"git status","aggregated_output":"clean"}}`)
	if len(completed) != 1 || completed[0].Status != "done" || completed[0].Detail != "clean" {
		t.Fatalf("unexpected command completion: %#v", completed)
	}
}

func TestCliPipeWriterStreamsCompleteLines(t *testing.T) {
	raw := &aiCliRawOutput{}
	var events []aiArchProgress
	writer := &aiCliPipeWriter{cliName: "kimi", raw: raw, onProgress: func(event aiArchProgress) {
		events = append(events, event)
	}}
	line := `{"role":"assistant","content":"{\"answer\":\"OK\"}"}` + "\n"
	_, _ = writer.Write([]byte(line[:20]))
	if len(events) != 0 {
		t.Fatal("partial line emitted too early")
	}
	_, _ = writer.Write([]byte(line[20:]))
	writer.finish()
	if len(events) != 1 || events[0].Stage != "answer" {
		t.Fatalf("missing streamed answer event: %#v", events)
	}
	if raw.String() != line {
		t.Fatalf("raw output changed: %q", raw.String())
	}
}

func TestAiArchEmitterWritesProgressAndResult(t *testing.T) {
	recorder := httptest.NewRecorder()
	emitter := newAiArchEmitter(recorder, true)
	emitter.progress(aiArchProgress{Stage: "context", Status: "done", Label: "项目上下文已就绪"})
	emitter.result(aiArchResponse{Ok: true, Answer: "OK"})
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("unexpected NDJSON: %q", recorder.Body.String())
	}
	var progress map[string]any
	if json.Unmarshal([]byte(lines[0]), &progress) != nil || progress["event"] != "progress" || progress["label"] != "项目上下文已就绪" {
		t.Fatalf("unexpected progress frame: %q", lines[0])
	}
	var final map[string]any
	if json.Unmarshal([]byte(lines[1]), &final) != nil || final["event"] != "result" {
		t.Fatalf("unexpected result frame: %q", lines[1])
	}
	result := final["result"].(map[string]any)
	if result["ok"] != true || result["answer"] != "OK" {
		t.Fatalf("unexpected final response: %#v", result)
	}
}
