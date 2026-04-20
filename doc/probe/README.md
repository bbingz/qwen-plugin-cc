# Phase 0 探针

目的:抓 qwen CLI 真实行为样本,喂给单元测试作为 fixture,喂给 spec 作为 design 校验。

13 case 清单见 spec §6.2;每条对应一个 `case-NN-*.sh` 脚本。

跑法:
```bash
bash doc/probe/case-01-ping.sh
# ... 依次跑
bash doc/probe/aggregate.sh
```
