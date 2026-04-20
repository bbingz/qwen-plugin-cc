# Qwen prompt antipatterns

## ❌ 不要

- 把整个仓库 dump 进 prompt 指望 qwen 自己找相关文件
- 让 qwen 跑 shell 命令除非 foreground yolo + 用户在看(auto-edit 会 auto-deny)
- 开放式提问("看看这段代码有什么问题")—— 总是给明确 output contract
- retry 时在原 prompt 后面追加更多指令(超 context;重写新 prompt 带上一轮 raw)
- 期望 qwen 在 auto-edit 模式下跨多个文件自动应用 patch

## ✅ 应该

- 明确告诉 qwen 只基于提供的 diff 工作
- output contract 越严越好(JSON schema + "output ONLY this JSON")
- grounding rules 列出证据来源
- 诊断类任务加 verification_loop 让它自己跑测试
