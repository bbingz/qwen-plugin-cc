# Changelog

## 0.1.0 (unreleased)

- **Phase 1 完成**(11 code tasks + 17 unit tests 全绿)
  - marketplace.json + plugin.json manifest
  - `scripts/lib/{args,process,qwen}.mjs`(args/process 字节拷自 gemini v0.5.2;qwen.mjs 新写)
  - qwen.mjs 导出:`getQwenAvailability`(F-1 `--version`)、`buildSpawnEnv`(proxy 四键 + 冲突检测 + NO_PROXY merge)、`readQwenSettings`、`parseAuthStatusText`(4 种 mode + fallback)、`detectInstallers`、`runQwenPing`(F-6 跳 thinking)、`QWEN_BIN`、`CompanionError`
  - `scripts/qwen-companion.mjs`:setup 子命令 dispatcher(JSON + 文本两模式)
  - `commands/setup.md`:/qwen:setup 命令 frontmatter
- Phase 1 发现 F-1b:`qwen --version` 输出裸版本号 `0.14.5`(见 `doc/probe/FINDINGS.md`)
