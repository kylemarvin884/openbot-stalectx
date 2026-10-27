# stalectx

扫描 coding agent 的会话记录，找出**读过之后磁盘上又被改过**的文件——在它继续改代码之前，把这些已经过期的上下文揪出来。

```bash
node src/cli.mjs scan ~/.claude/projects/<project>/<session>.jsonl
```

Node >= 22，零依赖，不需要 API key，不调用任何模型。

## 为什么需要

agent 在第 30 轮读了 `checkout.ts`，你在第 45 轮改了同一个文件，agent 第 60 轮仍然按旧内容生成 patch。
它不会报错，只会写出一个基于过期快照的改动。

现有工具解决的是别的问题：

- `/context`、ctxlens、tokenscope 算的是 token 花在哪；
- handoffcheck 校验的是 `HANDOFF.md` 里的文件 hash；
- CLAUDE.md linter 检查的是静态规则文件；
- Concord / CORVUS 这类论文原型要求你改 agent runtime。

`stalectx` 只做一件事：**拿会话里最后一次读文件的时间，和文件现在的 mtime 比**。
确定性、可复现、事后可审计。

## 示例输出

以下输出由 `npm run demo` 生成（临时目录里的 5 个文件，固定相对时间戳）：

```text
stalectx 0.1.0  session demo-session.jsonl (claude-code)
root  C:\...\Temp\stalectx-demo-xxxx    reads 5 / files 5    stale 3

STALE  src/checkout.ts                 last read 2026-10-27 14:14:52Z (line 5)   changed 2026-10-27 14:31:52Z (+17m)   used later: command
STALE  config/pricing.json             last read 2026-10-27 14:13:52Z (line 3)   changed 2026-10-27 14:38:52Z (+25m)
GONE   src/legacy/cart.ts              last read 2026-10-27 14:15:52Z (line 6)   file no longer exists
ok     src/agent-edited.ts             last read 2026-10-27 14:14:52Z (line 4)   changed by the agent itself
ok     src/api.ts                      last read 2026-10-27 14:13:52Z (line 2)   unchanged

3 stale / 5 files, 1 used after going stale -> re-read them before continuing
```

- `STALE`：读完之后被外部改过（人、另一个 agent、另一个进程）。
- `GONE`：读过的文件已经不在了。
- `ok ... changed by the agent itself`：agent 自己 Edit 过，不算过期。
- `used later`：过期之后 agent 还对这个路径发起了 edit / 命令——风险最高。

退出码：有 stale 时 `1`，否则 `0`（`--fail-on=none` 可关闭，供历史会话扫描用）。

## 用法

```bash
# 扫一个 Claude Code 会话
node src/cli.mjs scan ~/.claude/projects/-Users-me-shop/2f1c.jsonl

# 显式指定仓库根目录（相对路径按它解析）
node src/cli.mjs scan session.jsonl --root /path/to/repo

# JSON，给 CI 或上层脚本
node src/cli.mjs scan session.jsonl --json

# 忽略生成目录
node src/cli.mjs scan session.jsonl --ignore "dist/**" --ignore "*.lock"

# 历史会话，只报告不失败
node src/cli.mjs scan old-session.jsonl --fail-on=none
```

选项：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--root <dir>` | transcript 里的 `cwd` | 相对路径的解析基准 |
| `--json` | 关 | 输出机器可读 JSON |
| `--fail-on=stale\|none` | `stale` | 有 stale 时是否 exit 1 |
| `--tolerance-ms <n>` | `2000` | 读写时间与 mtime 的容差 |
| `--ignore <glob>` | 无 | 可重复；匹配绝对路径或文件名 |
| `--no-color` | 自动 | 关闭 ANSI 颜色 |

## 支持的 transcript

1. **Claude Code JSONL**（主要目标）：`message.content[]` 里的 `tool_use`，带 `timestamp` 和 `cwd`。
2. **OpenAI 风格**：`{ role: "assistant", tool_calls: [{ function: { name, arguments } }] }`。
3. **通用顶层事件**：`{ tool: "read_file", input: { path }, timestamp }`。

读写工具名按归一化后的名字识别（`Read` / `read_file` / `view` / `Edit` / `Write` / `apply_patch` 等），
路径取 `file_path` / `filePath` / `path` / `file` / `target_file`。

## 它不做什么

- **不读内容，只比时间**。拿不到可靠的读时快照，所以不做逐字 diff。`git checkout` 之类会改 mtime
  但内容没变的操作会误报——这是已知代价，用 `--tolerance-ms` 和 `--ignore` 收敛。
- **agent 若在外部改动之后又自己 Edit 了同一文件，mtime 会被它覆盖**，中间那次外部改动就看不到了。
  要把这一类也抓出来，需要读时内容快照，不在首版范围内。
- **不统计 shell 里的 cat / Get-Content**。只认结构化工具调用；用 Bash 读文件不会被计入。
- **不跨机器校正时钟**。transcript 和文件系统要在同一台机器上。
- **不判断内容是否仍然"语义正确"**。文件没变不等于结论没变。
- 不支持 OpenCode 的 sqlite 存储，不做 GUI。

## 测试

```bash
npm test
```

覆盖：两种 transcript 格式解析、相对路径解析、fresh / changed / missing / self-edited 四种判定、
忽略规则、CLI 退出码与 JSON 结构。

## License

MIT
