// ai.go：AI 架构图生成 —— 探测本机 agent CLI（kimi 优先、codex 兜底），
// 以非交互模式让 agent 阅读项目代码并产出 archify architecture spec JSON。
// 取消语义：r.Context() 随客户端断开（前端 AbortController）而取消，
// CommandContext + Cancel 联动 taskkill/进程组杀整棵进程树。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// aiArchTimeout 单次生成上限；agent 要读文件再成图，给足 3 分钟
const aiArchTimeout = 180 * time.Second

type aiArchRequest struct {
	Prompt string `json:"prompt"`
	Ref    string `json:"ref,omitempty"`
}

// aiArchResponse 统一 200 返回（错误在 error 字段分层：no-cli/exec/timeout/parse），前端按类提示
type aiArchResponse struct {
	Ok      bool           `json:"ok"`
	Spec    map[string]any `json:"spec,omitempty"`
	Cli     string         `json:"cli,omitempty"`
	Error   string         `json:"error,omitempty"`
	Message string         `json:"message,omitempty"`
	Output  string         `json:"output,omitempty"` // 截断的原始输出（排障用）
}

type aiCli struct {
	name string // kimi | codex
	path string
}

// detectAiCli 探测可用的 agent CLI：kimi 优先，codex 兜底
func detectAiCli() *aiCli {
	if p, err := exec.LookPath("kimi"); err == nil {
		return &aiCli{name: "kimi", path: p}
	}
	if p, err := exec.LookPath("codex"); err == nil {
		return &aiCli{name: "codex", path: p}
	}
	return nil
}

// wrapCmd Windows 上 npm 垫片（.cmd/.bat）无法被 CreateProcess 直接执行，经 cmd /c 启动
func wrapCmd(ctx context.Context, path string, args ...string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		low := strings.ToLower(path)
		if strings.HasSuffix(low, ".cmd") || strings.HasSuffix(low, ".bat") {
			return exec.CommandContext(ctx, "cmd", append([]string{"/c", path}, args...)...)
		}
	}
	return exec.CommandContext(ctx, path, args...)
}

// aiArchSpecGuide 给 agent 的 spec 契约说明。
// schema 摘要与 vendor/archify 的 architecture schema 对齐（additionalProperties=false）；
// 布局固定 grid 模式（组件给 row/col，免坐标计算，渲染校验最稳）。
const aiArchSpecGuide = `你是架构绘图 agent。请分析当前工作目录中的项目（可用 git ls-files、浏览目录树、阅读关键源码与配置文件了解模块结构），然后输出一份 archify 架构图 spec。

硬性要求：
1. 只输出 JSON 本体：不要用 markdown 代码围栏，不要输出任何解释或前后缀文字；第一个字符必须是 {，最后一个字符必须是 }。
2. 结构示例（照此形态填写真实数据；所有对象不允许额外字段）：
{
  "schema_version": 1,
  "diagram_type": "architecture",
  "meta": { "title": "示例系统架构", "output": "architecture.html" },
  "layout": { "mode": "grid", "cols": 3, "cellW": 220, "cellH": 84, "gapX": 56, "gapY": 64 },
  "components": [
    { "id": "web", "type": "frontend", "label": "Web 前端", "sublabel": "React", "row": 0, "col": 0 },
    { "id": "api", "type": "backend", "label": "API 服务", "row": 0, "col": 1 },
    { "id": "db", "type": "database", "label": "数据库", "row": 1, "col": 1 }
  ],
  "boundaries": [ { "kind": "region", "label": "服务端", "wraps": ["api", "db"] } ],
  "connections": [ { "from": "web", "to": "api", "label": "HTTP" }, { "from": "api", "to": "db" } ]
}
3. 字段约束：schema_version 是数字 1；cols 是 1~12 的整数；row/col 是非负整数且 col < cols；id 必须匹配 ^[a-zA-Z][a-zA-Z0-9_-]*$；type 只能是 frontend|backend|database|cloud|security|messagebus|external 之一；boundaries 的 kind 只能是 "region"；connections 的 variant 可省略，取值限 default|emphasis|security|dashed|return。
4. 每个组件必须占唯一的 (row, col) 格子；components 建议 4~12 个；connections 的 from/to 与 boundaries 的 wraps 必须引用已声明的组件 id。
5. boundaries/connections 可整个省略；存在时字段不得增减属性。
6. 所有枚举值（type/kind/variant/mode）必须原样使用上述英文取值；中文说明文字只能出现在 label/sublabel/connections 的 label 中。
7. 文字务必简短：label ≤ 8 个字符；sublabel ≤ 12 个字符（拿不准就省略）；connections 一律不要写 label 字段（自动布线下文字极易与组件重叠导致校验失败）。格子渲染空间优先用 layout 的 cellW/cellH 加大，不要塞长文本。
8. 只读取文件，不要创建或修改任何文件。`

func buildAiArchPrompt(prompt, ref string) string {
	var b strings.Builder
	b.WriteString(aiArchSpecGuide)
	if ref != "" {
		b.WriteString("\n\n用户指定参考 git ref：" + ref + "（可用 git show/git log 查看，勿切换工作区）。")
	}
	b.WriteString("\n\n用户描述：" + prompt + "\n")
	return b.String()
}

// runAiArchCli 非交互执行 agent CLI：kimi 走 -p argv（shell:false 等价），codex 走 exec -（stdin 传 prompt）。
// 返回合并的 stdout+stderr 文本。
func runAiArchCli(ctx context.Context, cli *aiCli, dir, prompt string) (string, error) {
	var cmd *exec.Cmd
	if cli.name == "kimi" {
		cmd = wrapCmd(ctx, cli.path, "-p", prompt, "--output-format", "stream-json")
	} else {
		cmd = wrapCmd(ctx, cli.path, "exec", "-", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never")
		cmd.Stdin = strings.NewReader(prompt)
	}
	prepTreeCmd(cmd)
	// 取消/超时默认只杀直接子进程；cmd /c 垫片会再拖起 node 等孙进程，必须整树终止
	cmd.Cancel = func() error {
		if err := killTree(cmd); err != nil {
			_ = cmd.Process.Kill()
			return err
		}
		return nil
	}
	// 进程已退但孙进程仍占着 stdout 管道时，Run 会在拷贝上阻塞；WaitDelay 兜底放行
	cmd.WaitDelay = 10 * time.Second
	cmd.Dir = dir
	var out strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// extractAssistantText 从 stream-json 事件流拼接 assistant 文本；解析不出时返回空串
func extractAssistantText(cliName, raw string) string {
	var b strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var ev map[string]any
		if json.Unmarshal([]byte(line), &ev) != nil {
			continue
		}
		if cliName == "kimi" {
			if ev["role"] == "assistant" {
				if c, ok := ev["content"].(string); ok {
					b.WriteString(c)
				}
			}
			continue
		}
		// codex --json：item.completed 且 item.type=agent_message 时文本在 item.text（兼容 content 数组）
		if ev["type"] == "item.completed" {
			item, ok := ev["item"].(map[string]any)
			if !ok || item["type"] != "agent_message" {
				continue
			}
			if t, ok := item["text"].(string); ok {
				b.WriteString(t)
				continue
			}
			if arr, ok := item["content"].([]any); ok {
				for _, c := range arr {
					if m, ok := c.(map[string]any); ok {
						if t, ok := m["text"].(string); ok {
							b.WriteString(t)
						}
					}
				}
			}
		}
	}
	return b.String()
}

// extractSpec 从文本中提取 JSON（首个 { 到末个 }）并做最低限度校验；
// 严格的 schema/布局校验由前端 archRender 的 vendor 渲染器把关
func extractSpec(text string) (map[string]any, error) {
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return nil, fmt.Errorf("输出中未找到 JSON 对象")
	}
	var spec map[string]any
	if err := json.Unmarshal([]byte(text[start:end+1]), &spec); err != nil {
		return nil, fmt.Errorf("JSON 解析失败：%v", err)
	}
	if spec["diagram_type"] != "architecture" {
		return nil, fmt.Errorf("diagram_type 不是 architecture")
	}
	comps, ok := spec["components"].([]any)
	if !ok || len(comps) == 0 {
		return nil, fmt.Errorf("components 缺失或为空")
	}
	return spec, nil
}

// normalizeSpec 修剪 AI 产出中常见的非法枚举值（宁可降级也不让整体渲染失败）：
// component.type 非法 → external；boundary.kind 非法 → region；connection.variant 非法 → 删除该字段。
func normalizeSpec(spec map[string]any) {
	types := map[string]bool{"frontend": true, "backend": true, "database": true, "cloud": true, "security": true, "messagebus": true, "external": true}
	variants := map[string]bool{"default": true, "emphasis": true, "security": true, "dashed": true, "return": true}
	for _, c := range spec["components"].([]any) {
		if m, ok := c.(map[string]any); ok {
			if t, ok := m["type"].(string); !ok || !types[t] {
				m["type"] = "external"
			}
		}
	}
	if bs, ok := spec["boundaries"].([]any); ok {
		for _, b := range bs {
			if m, ok := b.(map[string]any); ok {
				if k, ok := m["kind"].(string); !ok || k != "region" && k != "security-group" {
					m["kind"] = "region"
				}
			}
		}
	}
	if cs, ok := spec["connections"].([]any); ok {
		for _, c := range cs {
			if m, ok := c.(map[string]any); ok {
				if v, ok := m["variant"]; ok {
					if vs, ok2 := v.(string); !ok2 || !variants[vs] {
						delete(m, "variant")
					}
				}
			}
		}
	}
}

func tailStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return "…" + s[len(s)-n:]
}

func (s *server) handleAiArch(w http.ResponseWriter, r *http.Request) {
	p := s.project(w, r)
	if p == nil {
		return
	}
	var req aiArchRequest
	if err := readJSON(r, &req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "bad-request", Message: "请求体需包含非空 prompt"})
		return
	}
	cli := detectAiCli()
	if cli == nil {
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "no-cli", Message: "未检测到 kimi 或 codex CLI，请先安装并登录其中一个"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), aiArchTimeout)
	defer cancel()
	raw, err := runAiArchCli(ctx, cli, p.Path, buildAiArchPrompt(req.Prompt, strings.TrimSpace(req.Ref)))
	if ctx.Err() == context.DeadlineExceeded {
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "timeout", Cli: cli.name, Message: "AI 生成超时（180 秒），可简化描述后重试", Output: tailStr(raw, 500)})
		return
	}
	if err != nil {
		// 客户端断开（前端取消）时请求上下文已取消，无需再写响应
		if r.Context().Err() != nil {
			return
		}
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "exec", Cli: cli.name, Message: fmt.Sprintf("AI CLI 执行失败：%v", err), Output: tailStr(raw, 500)})
		return
	}
	text := extractAssistantText(cli.name, raw)
	spec, perr := extractSpec(text)
	if perr != nil && text != raw {
		// 兜底：对整体输出做一次括号提取
		spec, perr = extractSpec(raw)
	}
	if perr != nil {
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "parse", Cli: cli.name, Message: perr.Error(), Output: tailStr(raw, 500)})
		return
	}
	normalizeSpec(spec)
	writeJSON(w, 200, aiArchResponse{Ok: true, Cli: cli.name, Spec: spec})
}
