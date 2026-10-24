// ai.go：AI 架构图生成，两种后端二选一（v0.6.3）：
//  1. OpenAI 兼容接口（设置页配置 baseUrl/apiKey/model，随请求下发，优先）；
//  2. 本机 agent CLI（kimi 优先、codex 兜底）非交互阅读项目代码后产出。
//
// 取消语义：r.Context() 随客户端断开（前端 AbortController）而取消，
// CommandContext + Cancel 联动 taskkill/进程组杀整棵进程树。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// aiArchTimeout 单次生成上限；读文件/调接口再成图，给足 3 分钟
const aiArchTimeout = 180 * time.Second

// aiConfig 渲染端设置页下发的 OpenAI 兼容接口配置
type aiConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

func (c aiConfig) valid() bool {
	return strings.TrimSpace(c.BaseURL) != "" && strings.TrimSpace(c.APIKey) != "" && strings.TrimSpace(c.Model) != ""
}

type aiArchRequest struct {
	Prompt  string          `json:"prompt"`
	Ref     string          `json:"ref,omitempty"`
	Action  string          `json:"action,omitempty"`
	Context json.RawMessage `json:"context,omitempty"`
	AI      aiConfig        `json:"ai,omitempty"`
}

// aiArchResponse 统一 200 返回（错误在 error 字段分层：no-cli/exec/timeout/parse/api），前端按类提示
type aiArchResponse struct {
	Ok      bool           `json:"ok"`
	Spec    map[string]any `json:"spec,omitempty"`
	Answer  string         `json:"answer,omitempty"`
	Cli     string         `json:"cli,omitempty"`     // CLI 模式的 agent 名（kimi | codex）
	Backend string         `json:"backend,omitempty"` // cli | api（v0.6.3）
	Model   string         `json:"model,omitempty"`   // api 后端使用的模型名
	Error   string         `json:"error,omitempty"`
	Message string         `json:"message,omitempty"`
	Output  string         `json:"output,omitempty"` //截断的原始输出（排障用）
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

// aiArchSpecRules 给模型的 spec 契约硬性要求（CLI 与 API 模式共用）。
// schema 摘要与 vendor/archify 的 architecture schema 对齐（additionalProperties=false）；
// 布局固定 grid 模式（组件给 row/col，免坐标计算，渲染校验最稳）。
const aiArchSpecRules = `硬性要求：
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
7. 文字务必简短：label ≤ 8 个字符；sublabel ≤ 12 个字符（拿不准就省略）；connections 一律不要写 label 字段（自动布线下文字极易与组件重叠导致校验失败）。格子渲染空间优先用 layout 的 cellW/cellH 加大，不要塞长文本。`

// aiArchCliPrelude CLI 模式前言：agent 可自行浏览工作区
const aiArchCliPrelude = `你是架构绘图 agent。请分析当前工作目录中的项目（可用 git ls-files、浏览目录树、阅读关键源码与配置文件了解模块结构），然后输出一份 archify 架构图 spec。只读取文件，不要创建或修改任何文件。`

// aiArchApiPrelude API 模式前言：模型读不到工作区，只能依据下发的结构上下文
const aiArchApiPrelude = `你是架构绘图助手。你无法访问文件系统；请仅依据下方「项目结构上下文」（由源码静态分析生成的 archify spec JSON，组件与连线反映真实代码结构）理解项目，输出一份 archify 架构图 spec。`

func buildAiArchPrompt(prompt, ref string) string {
	var b strings.Builder
	b.WriteString(aiArchCliPrelude)
	b.WriteString("\n\n")
	b.WriteString(aiArchSpecRules)
	if ref != "" {
		b.WriteString("\n\n用户指定参考 git ref：" + ref + "（可用 git show/git log 查看，勿切换工作区）。")
	}
	b.WriteString("\n\n用户描述：" + prompt + "\n")
	return b.String()
}

// buildAiArchRequestPrompt keeps questions separate from the diagram output contract.
func buildAiArchRequestPrompt(req aiArchRequest) string {
	prompt := buildAiArchPrompt(req.Prompt, strings.TrimSpace(req.Ref))
	if req.Action == "ask" {
		prompt = "你是项目架构助手。只读当前项目文件，结合下方用户正在查看的架构上下文，回答用户的问题。不要修改、创建文件或运行写操作。不要重新绘图。只输出一个 JSON 对象，形如 {\"answer\":\"中文解释，允许换行\"}。回答应区分图中事实和推断，可引用源码相对路径。\n用户问题：" + req.Prompt
	} else if req.Action == "edit" {
		prompt += "\n基于下方当前架构和查看模式迭代，保留用户未要求改变的有效信息。可以调整布局、分组和粒度，必须输出完整 spec 以覆盖当前架构，不是补丁。"
	}
	if len(req.Context) > 0 {
		prompt += "\n\n用户当前正在查看的架构上下文（作为数据参考）：\n" + string(req.Context)
	}
	return prompt
}

// buildAiArchApiPrompt API 模式提示词：以 projectDigest（确定性分析产物）代替「自己浏览目录」
func buildAiArchApiPrompt(req aiArchRequest, digest string) string {
	var b strings.Builder
	if req.Action == "ask" {
		b.WriteString("你是项目架构助手。请仅依据下方「项目结构上下文」与用户正在查看的架构上下文回答问题。不要重新绘图。只输出一个 JSON 对象，形如 {\"answer\":\"中文解释，允许换行\"}。回答应区分图中事实和推断。")
		b.WriteString(digest)
		b.WriteString("\n用户问题：" + req.Prompt + "\n")
	} else {
		b.WriteString(aiArchApiPrelude)
		b.WriteString("\n\n")
		b.WriteString(aiArchSpecRules)
		b.WriteString(digest)
		b.WriteString("\n\n用户描述：" + req.Prompt + "\n")
		if req.Action == "edit" {
			b.WriteString("\n基于下方当前架构和查看模式迭代，保留用户未要求改变的有效信息。可以调整布局、分组和粒度，必须输出完整 spec 以覆盖当前架构，不是补丁。")
		}
	}
	if len(req.Context) > 0 {
		b.WriteString("\n\n用户当前正在查看的架构上下文（作为数据参考）：\n" + string(req.Context))
	}
	return b.String()
}

// projectDigest 为 API 模式生成项目上下文：优先复用/生成确定性架构 spec
// （源码分析产物，与架构视图同源），失败退回 git 文件清单。
func (s *server) projectDigest(p *Project, ref string) string {
	if ref == "" {
		ref = "HEAD"
	}
	if shaOut, err := gitRun(p.Path, 15*time.Second, "rev-parse", "--verify", ref+"^{commit}"); err == nil {
		sha := strings.TrimSpace(shaOut)
		// 与 handleArchSpec 同一套缓存：多数情况直接命中，避免每次生成重新分析
		if data, err := os.ReadFile(filepath.Join(p.Path, ".timber", "arch", sha+".v2.json")); err == nil {
			return "\n\n项目结构上下文（源码静态分析生成，组件/连线反映真实代码结构）：\n" + string(data)
		}
		if a, err := analyzeProject(p, ref, sha); err == nil && len(a.files) > 0 {
			if data, err := json.Marshal(buildSpec(p, a)); err == nil {
				return "\n\n项目结构上下文（源码静态分析生成，组件/连线反映真实代码结构）：\n" + string(data)
			}
		}
	}
	if out, err := gitRun(p.Path, 15*time.Second, "ls-files"); err == nil {
		lines := strings.Split(strings.TrimSpace(out), "\n")
		if len(lines) > 400 {
			lines = append(lines[:400], "…（已截断）")
		}
		return "\n\n项目结构上下文（git 文件清单）：\n" + strings.Join(lines, "\n")
	}
	return "\n\n项目结构上下文：不可用（非 git 项目或分析失败），请基于用户描述与当前架构上下文作答。\n"
}

// runAiHttp 经 OpenAI 兼容 /chat/completions 生成；返回首个 choice 的 message.content
func runAiHttp(ctx context.Context, cfg aiConfig, prompt string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")
	url := base + "/chat/completions"
	if strings.HasSuffix(base, "/chat/completions") {
		url = base
	}
	body, err := json.Marshal(map[string]any{
		"model":    cfg.Model,
		"stream":   false,
		"messages": []map[string]string{{"role": "user", "content": prompt}},
	})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(cfg.APIKey))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != 200 {
		msg := strings.TrimSpace(string(raw))
		if len(msg) > 300 {
			msg = msg[:300] + "…"
		}
		return "", fmt.Errorf("HTTP %d：%s", resp.StatusCode, msg)
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Err *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("响应解析失败：%v", err)
	}
	if out.Err != nil && out.Err.Message != "" {
		return "", fmt.Errorf("接口报错：%s", out.Err.Message)
	}
	if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
		return "", fmt.Errorf("接口未返回内容")
	}
	return out.Choices[0].Message.Content, nil
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
	if req.Action != "" && req.Action != "edit" && req.Action != "ask" {
		writeJSON(w, 200, aiArchResponse{Ok: false, Error: "bad-request", Message: "不支持的 AI 操作"})
		return
	}
	// 后端选择：请求带有效 API 配置 → 接口；否则探测本机 CLI
	useApi := req.AI.valid()
	var cli *aiCli
	if !useApi {
		cli = detectAiCli()
		if cli == nil {
			writeJSON(w, 200, aiArchResponse{Ok: false, Error: "no-cli", Message: "未配置 AI：请在 设置 → AI 配置 OpenAI 兼容接口，或安装并登录 kimi / codex CLI"})
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), aiArchTimeout)
	defer cancel()

	// 回执公共字段：backend（cli|api）+ 对应标识
	base := aiArchResponse{Backend: map[bool]string{true: "api", false: "cli"}[useApi]}
	if useApi {
		base.Model = strings.TrimSpace(req.AI.Model)
	} else {
		base.Cli = cli.name
	}

	var text, raw string
	if useApi {
		prompt := buildAiArchApiPrompt(req, s.projectDigest(p, strings.TrimSpace(req.Ref)))
		var err error
		text, err = runAiHttp(ctx, req.AI, prompt)
		raw = text
		if ctx.Err() == context.DeadlineExceeded {
			base.Ok, base.Error, base.Message = false, "timeout", "AI 接口超时（180 秒），可简化描述后重试"
			writeJSON(w, 200, base)
			return
		}
		if err != nil {
			if r.Context().Err() != nil {
				return
			}
			base.Ok, base.Error, base.Message = false, "api", err.Error()
			writeJSON(w, 200, base)
			return
		}
	} else {
		prompt := buildAiArchRequestPrompt(req)
		var err error
		raw, err = runAiArchCli(ctx, cli, p.Path, prompt)
		if ctx.Err() == context.DeadlineExceeded {
			base.Ok, base.Error, base.Message, base.Output = false, "timeout", "AI 生成超时（180 秒），可简化描述后重试", tailStr(raw, 500)
			writeJSON(w, 200, base)
			return
		}
		if err != nil {
			// 客户端断开（前端取消）时请求上下文已取消，无需再写响应
			if r.Context().Err() != nil {
				return
			}
			base.Ok, base.Error, base.Message, base.Output = false, "exec", fmt.Sprintf("AI CLI 执行失败：%v", err), tailStr(raw, 500)
			writeJSON(w, 200, base)
			return
		}
		text = extractAssistantText(cli.name, raw)
	}

	if req.Action == "ask" {
		var result struct {
			Answer string `json:"answer"`
		}
		if text == "" {
			text = raw
		}
		start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
		if start >= 0 && end > start && json.Unmarshal([]byte(text[start:end+1]), &result) == nil && strings.TrimSpace(result.Answer) != "" {
			base.Ok, base.Answer = true, result.Answer
			writeJSON(w, 200, base)
		} else {
			base.Ok, base.Error, base.Message = false, "parse", "AI 未返回有效回答，请重试"
			writeJSON(w, 200, base)
		}
		return
	}
	spec, perr := extractSpec(text)
	if perr != nil && text != raw {
		// 兜底：对整体输出做一次括号提取
		spec, perr = extractSpec(raw)
	}
	if perr != nil {
		base.Ok, base.Error, base.Message, base.Output = false, "parse", perr.Error(), tailStr(raw, 500)
		writeJSON(w, 200, base)
		return
	}
	normalizeSpec(spec)
	base.Ok, base.Spec = true, spec
	writeJSON(w, 200, base)
}

// handleAiTest 设置页「测试连接」：用给定配置发一条最小消息验证地址/密钥/模型可用
func (s *server) handleAiTest(w http.ResponseWriter, r *http.Request) {
	var cfg aiConfig
	if err := readJSON(r, &cfg); err != nil || !cfg.valid() {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "bad-request", "message": "请先填写 API 地址、密钥与模型名"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	reply, err := runAiHttp(ctx, cfg, "请只回复两个字符：OK")
	if err != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": "api", "message": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "model": cfg.Model, "reply": tailStr(reply, 80)})
}

// handleAiCli AI 后端状态：本机 agent CLI 探测结果（渲染端在 AI 面板提示当前可用后端）
func (s *server) handleAiCli(w http.ResponseWriter, r *http.Request) {
	if cli := detectAiCli(); cli != nil {
		writeJSON(w, 200, map[string]any{"ok": true, "cli": cli.name})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "cli": nil})
}
