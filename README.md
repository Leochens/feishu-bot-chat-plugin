# Feishu Bot Chat Plugin

OpenClaw 插件，实现飞书群聊中多个 Bot 之间的 @ 互相通信。

## 为什么需要这个插件

飞书支持 Bot 之间通过 @ 直接通信（需开通权限），但 Bot 需要知道群里有哪些其他 Bot、如何正确使用 `<at>` 标签、以及何时该 @ 何时不该 @。

这个插件解决的问题：
1. **自动发现** — 自动识别群内所有 Bot 及其 open_id，无需手动配置
2. **协作规则注入** — 向每个 Bot 的 system prompt 注入可用 Bot 列表和协作规则
3. **格式转换** — 将 `@botName` 文本自动转为飞书 `<at>` 标签
4. **消息过滤** — 过滤非 @ 的 Bot 消息，避免无关触发

## 前置条件

每个参与协作的 Bot 应用需要在飞书开发者后台开通：

**`im:message.group_at_msg.include_bot:readonly`**（接收群聊中机器人 @机器人的消息）

路径：开发者后台 → 应用 → 权限管理 → 搜索上述权限 → 开通

开通后，Bot A 在群里 @ Bot B 时，Bot B 的 webhook 会原生收到这条消息。

## 工作原理

```
用户 @ Bot A → Bot A 回复并在消息中使用 <at> 标签 @ Bot B
                         ↓
              飞书原生投递：Bot B 的 webhook 收到消息
                         ↓
              Bot B 处理任务，回复时 @ 回 Bot A
                         ↓
              飞书原生投递：Bot A 收到结果，汇总回复用户
```

### 三个 Hook

| Hook | 作用 |
|------|------|
| `before_prompt_build` | 注入群内可用 Bot 列表和协作规则到 system prompt |
| `message_sending` | 将 `@botName` 文本替换为飞书 `<at user_id="...">` 标签 |
| `inbound_claim` | 过滤非 @ 的 Bot 消息；检测原生投递状态；注入发送者信息 |

### 自动发现

插件启动时自动从 OpenClaw 配置中发现所有飞书 Bot：

1. 读取 `bindings` — 找到所有 `channel=feishu` 且有 `accountId` 的 agent
2. 读取 `channels.feishu.accounts` — 获取每个 account 的 `appId`、`appSecret`
3. 调用飞书 `bot/v3/info` API — 获取每个 Bot 的 `open_id` 和真实名称
4. 缓存到 `~/.openclaw/fbc-registry/registry.json`（24 小时有效）

### 群成员过滤

`before_prompt_build` 时会调用飞书群成员 API，只向 Bot 展示当前群内实际存在的其他 Bot，避免 @ 不在群里的 Bot。

## 安装

```bash
# 从 ClawHub 安装
openclaw plugins install feishu-bot-chat

# 或从本地安装
openclaw plugins install .

# 启用插件
openclaw plugins enable feishu-bot-chat
```

重启 gateway：`openclaw gateway --force`

插件会自动发现所有绑定了飞书 account 的 agent，无需额外配置。

## 配置（可选）

默认零配置即可工作。如需手动指定 Bot 列表（覆盖自动发现），可在 `openclaw.json` 中配置：

```json
{
  "plugins": {
    "entries": {
      "feishu-bot-chat": {
        "enabled": true,
        "config": {
          "botRegistry": {
            "agent-id-1": {
              "accountId": "feishu-account-id",
              "botOpenId": "ou_xxxxxxxxxxxxxxxx",
              "botName": "显示名称"
            }
          }
        }
      }
    }
  }
}
```

## 自动发现缓存

发现结果缓存在 `~/.openclaw/fbc-registry/registry.json`，24 小时有效。

- gateway 重启时如果缓存有效，不重复调 API
- 删除该文件可强制重新发现
- 新增 agent 绑定后，缓存会自动检测到不完整并重新发现

## 调试

插件将详细日志写入 `logs/a2a-debug-YYYY-MM-DD.log`（按天轮转）：

```bash
tail -f logs/a2a-debug-$(date +%Y-%m-%d).log
```

## 构建

打包为 zip 用于上传 ClawHub：

```bash
npm run build
# 输出: dist/feishu-bot-chat-{version}.zip
```

## 限制

- 仅支持飞书群聊场景（`channelId === 'feishu'`）
- 需要每个 Bot 应用开通 `im:message.group_at_msg.include_bot:readonly` 权限
- 飞书卡片中的 `<at>` 标签不会触发 webhook 投递，Bot 需使用纯文本消息 @
- 自动发现需要 agent 在 bindings 中有 `accountId` 匹配

## 内置 Skills

插件提供 6 个 A2A 协作 Skill，群聊中自动生效：

| Skill | 说明 |
|-------|------|
| `a2a-collaboration-guide` | 协作规则速查手册（始终激活） |
| `a2a-task-decompose` | 任务分解与分配指南 |
| `a2a-result-merge` | 多 bot 结果汇总 |
| `a2a-interrupt` | 协作中断与取消处理 |
| `a2a-status-check` | 协作状态查询与进度汇报 |
| `a2a-mode-switch` | 协作模式切换（独立/指定/全力） |

## License

MIT
