# Probe result schema

每条 case 一个对象,字段:
- `case`: 编号 + 简述
- `cmd`: 实际跑的命令(完整 CLI)
- `env`: 环境变量(只记关键的,如 HTTP_PROXY、QWEN_CODE_DISABLE_OAUTH)
- `stdout_excerpt`: 输出头 2KB(JSONL 按行压缩)
- `stderr_excerpt`: stderr 头 1KB
- `exit_code`: 数字或 null(timeout)
- `observed_structure`: "type=system,assistant,result" 等事件顺序摘要
- `parsed`: 对关键字段的提取,如 `{ session_id, is_error, result_field }`
- `notes`: 人工观察到的异常,比如 "assistant.text 以 [API Error: 开头但 is_error:false"
