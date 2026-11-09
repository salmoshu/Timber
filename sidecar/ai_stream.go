package main

// AI 过程事件：NDJSON 传输与 Kimi/Codex 流式输出解析。
// 只暴露可操作的阶段和工具摘要，不转发隐藏推理或完整会话记录。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

type aiArchProgress struct {
	Event  string `json:"event"`
	Stage  string `json:"stage"`
	Status string `json:"status,omitempty"`
	Label  string `json:"label"`
	Detail string `json:"detail,omitempty"`
	ToolID string `json:"toolId,omitempty"`
}

type aiArchEmitter struct {
	w      http.ResponseWriter
	enc    *json.Encoder
	stream bool
	mu     sync.Mutex
}

func newAiArchEmitter(w http.ResponseWriter, stream bool) *aiArchEmitter {
	e := &aiArchEmitter{w: w, stream: stream}
	if stream {
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		e.enc = json.NewEncoder(w)
	}
	return e
}

func (e *aiArchEmitter) flush() {
	if flusher, ok := e.w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (e *aiArchEmitter) progress(p aiArchProgress) {
	if !e.stream {
		return
	}
	p.Event = "progress"
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(p)
	e.flush()
}

func (e *aiArchEmitter) result(v aiArchResponse) {
	if !e.stream {
		writeJSON(e.w, 200, v)
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.enc.Encode(map[string]any{"event": "result", "result": v})
	e.flush()
}

func processDetail(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 500 {
		return text[:500] + "…"
	}
	return text
}

func aiToolLabel(name string) string {
	switch strings.ToLower(name) {
	case "bash", "shell", "command_execution", "exec":
		return "执行只读命令"
	case "read", "readfile", "read_file":
		return "读取项目文件"
	case "glob", "list", "ls":
		return "查找项目文件"
	case "grep", "search":
		return "搜索项目代码"
	default:
		return "调用工具 " + name
	}
}

func aiToolArguments(raw string) string {
	var args map[string]any
	if json.Unmarshal([]byte(raw), &args) != nil {
		return processDetail(raw)
	}
	for _, key := range []string{"command", "path", "file_path", "pattern", "query", "url"} {
		if value, ok := args[key].(string); ok && strings.TrimSpace(value) != "" {
			return processDetail(value)
		}
	}
	return processDetail(raw)
}

func codexItemText(item map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := item[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func parseAiCliProgress(cliName, line string) []aiArchProgress {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "{") {
		return nil
	}
	var event map[string]any
	if json.Unmarshal([]byte(line), &event) != nil {
		return nil
	}
	if cliName == "kimi" {
		switch event["role"] {
		case "assistant":
			progress := make([]aiArchProgress, 0, 2)
			if content, ok := event["content"].(string); ok && strings.TrimSpace(content) != "" {
				progress = append(progress, aiArchProgress{Stage: "answer", Status: "running", Label: "正在整理回答"})
			}
			if calls, ok := event["tool_calls"].([]any); ok {
				for _, rawCall := range calls {
					call, ok := rawCall.(map[string]any)
					if !ok {
						continue
					}
					function, _ := call["function"].(map[string]any)
					name, _ := function["name"].(string)
					if name == "" {
						continue
					}
					arguments, _ := function["arguments"].(string)
					id, _ := call["id"].(string)
					progress = append(progress, aiArchProgress{Stage: "tool", Status: "running", Label: aiToolLabel(name), Detail: aiToolArguments(arguments), ToolID: id})
				}
			}
			return progress
		case "tool":
			id, _ := event["tool_call_id"].(string)
			content, _ := event["content"].(string)
			return []aiArchProgress{{Stage: "tool", Status: "done", Label: "工具执行完成", Detail: processDetail(content), ToolID: id}}
		}
		return nil
	}

	eventType, _ := event["type"].(string)
	switch eventType {
	case "turn.started":
		return []aiArchProgress{{Stage: "agent", Status: "running", Label: "Codex 已开始执行"}}
	case "turn.completed":
		return []aiArchProgress{{Stage: "agent", Status: "done", Label: "Codex 执行完成"}}
	case "error":
		message, _ := event["message"].(string)
		return []aiArchProgress{{Stage: "agent", Status: "error", Label: "Codex 执行失败", Detail: processDetail(message)}}
	case "item.started", "item.completed":
		item, ok := event["item"].(map[string]any)
		if !ok {
			return nil
		}
		itemType, _ := item["type"].(string)
		id, _ := item["id"].(string)
		status := "running"
		if eventType == "item.completed" {
			status = "done"
		}
		switch itemType {
		case "command_execution":
			detail := codexItemText(item, "command")
			if status == "done" {
				if output := codexItemText(item, "aggregated_output", "output"); output != "" {
					detail = output
				}
			}
			return []aiArchProgress{{Stage: "tool", Status: status, Label: aiToolLabel(itemType), Detail: processDetail(detail), ToolID: id}}
		case "agent_message":
			if status == "done" {
				return []aiArchProgress{{Stage: "answer", Status: "running", Label: "正在整理回答"}}
			}
		case "reasoning":
			label := "正在分析项目结构"
			if status == "done" {
				label = "项目结构分析完成"
			}
			return []aiArchProgress{{Stage: "analysis", Status: status, Label: label}}
		default:
			if itemType != "" {
				return []aiArchProgress{{Stage: "tool", Status: status, Label: aiToolLabel(itemType), ToolID: id}}
			}
		}
	}
	return nil
}

type aiCliRawOutput struct {
	mu  sync.Mutex
	raw strings.Builder
}

func (o *aiCliRawOutput) append(p []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	_, _ = o.raw.Write(p)
}

func (o *aiCliRawOutput) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.raw.String()
}

// aiCliPipeWriter 按行解析过程事件，同时完整保留原始输出供最终答案与错误诊断使用。
type aiCliPipeWriter struct {
	cliName    string
	raw        *aiCliRawOutput
	pending    strings.Builder
	onProgress func(aiArchProgress)
}

func (w *aiCliPipeWriter) emit(line string) {
	if w.onProgress == nil {
		return
	}
	for _, progress := range parseAiCliProgress(w.cliName, line) {
		w.onProgress(progress)
	}
}

func (w *aiCliPipeWriter) Write(p []byte) (int, error) {
	w.raw.append(p)
	_, _ = w.pending.Write(p)
	for {
		current := w.pending.String()
		index := strings.IndexByte(current, '\n')
		if index < 0 {
			break
		}
		line := current[:index]
		rest := current[index+1:]
		w.pending.Reset()
		_, _ = w.pending.WriteString(rest)
		w.emit(line)
	}
	return len(p), nil
}

func (w *aiCliPipeWriter) finish() {
	line := strings.TrimSpace(w.pending.String())
	w.pending.Reset()
	if line != "" {
		w.emit(line)
	}
}

func aiBackendLabel(backend, cli, model string) string {
	if backend == "api" {
		return fmt.Sprintf("使用 API 模型 %s", model)
	}
	if cli == "codex" {
		return "使用 Codex CLI"
	}
	return "使用 Kimi CLI"
}
