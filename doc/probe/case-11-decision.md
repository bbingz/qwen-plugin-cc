# Case 11 决策 — auto-edit 无 TTY 行为

**实测日期**: 2026-04-20
**qwen 版本**: 0.14.5

## 观察

- `qwen --approval-mode auto-edit`(stdin = /dev/null)遇 `run_shell_command`
- `exit_code: 0`(非 hang,非 crash)
- `is_error: false`
- `permission_denials: [{ tool_name: "run_shell_command", tool_input: {...} }]`
- 最终 `result` 字段:`"I don't have permission to run shell commands. The run_shell_command tool was declined."`
- qwen 自然完成 turn,只是 shell 被拒

## 决策

**维持 spec v3 §3.3 的默认 `auto-edit`**。Foreground rescue 不改为对称 `--unsafe`。

**理由**:
- 无 TTY 环境下 `auto-edit` 是 **auto-deny**,不是 hang。
- 不需要用户每次都打 `--unsafe`。
- 安全姿态正确:默认不放行 shell,用户需要时显式 `--unsafe`。

## 新发现:`permission_denials` 数组

qwen 在 `type=result` 事件里有 `permission_denials: []` 字段,明示被拒的工具调用。

**建议改动 spec**:
- `§4.6 job.json` 新增字段 `permissionDenials[]`(从 resultEvent 透传)
- `§5.2` 无需加新 kind(auto-deny 属正常行为)
- **`/qwen:result` 渲染**:若 `permissionDenials` 非空,高亮"Qwen wanted to do X but was denied; rerun with `--unsafe` if you want it to proceed"

## 影响 tasks

- **Task 4.2 `runResult`**:渲染 permissionDenials 提示
- **Task 2.11 `runTask`**:把 resultEvent.permission_denials 透传到 writeJobFile
- **Task 2.13 rescue 命令**:command/rescue.md 的"自救引导"加一条:"若 `/qwen:result` 显示 permission_denials,意味着 qwen 被 auto-deny 了 shell/write 工具;加 `--unsafe` 重跑"
