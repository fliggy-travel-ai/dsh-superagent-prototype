# 细粒度令牌接口权限实测（2026-11-06，只读 GET，令牌内容未记录）

| 仓库 | issues | issue_comments | pulls_comments | actions_runs | pulls_list | pull_detail | pull_reviews | check_runs | commit_status |
|---|---|---|---|---|---|---|---|---|---|
| content-wx | 200 | 200 | 200 | 200 | 200 | - | - | - | - |
| deepseek-harness | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 200 |
| hypit | 200 | 200 | 200 | 200 | 200 | - | - | - | - |
| gestalt-travel-server | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 200 |
| WeKnora | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 200 |
| sub2api | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 200 |
| rea | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 403 | 200 |
| harness2 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 |
| dsh-superagent-prototype | 200 | 200 | 200 | 200 | 200 | - | - | - | - |

- `-` 表示该仓库没有 PR，未测。
- `check_runs` 在 4 个私有受监听仓库都是 403：`Resource not accessible by personal access token`，接口要求 `checks=read`。公开仓库 harness2 为 200。
- 另测：`actions/runs?head_sha=` 200（含 `status`、`conclusion`、`pull_requests[]`）；`actions/runs/{id}/jobs` 200（`actions=read`）；`commits/{sha}/status` 200（`statuses=read`）；`issues/{n}/timeline` 200；`pulls/{n}/comments` 200。
