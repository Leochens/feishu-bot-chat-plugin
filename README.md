# Feishu Bot Chat Plugin

OpenClaw 插件，实现飞书群聊中多个 Bot 之间的 @ 互相通信。

## 为什么需要这个插件

飞书有两个平台限制导致 Bot 之间无法直接对话：

1. **飞书不会把 Bot 发送的消息通过 webhook 投递给其他 Bot** — 当经纪人 Bot 在群里 @ 文案助手 Bot 时，文案助手的 webhook 不会收到这条消息
2. **飞书 streaming 模式会绕过 `message_sending` hook** — 无法在消息发送阶段拦截和转发

这个插件通过 OpenClaw 内部的 system event 队列 + heartbeat 唤醒机制，在 Bot 之间建立了一条"内部通信通道"。

## 工作原理

### 核心流程

```
用户 @ 经纪人 → 经纪人回复并 @ 文案助手
                         ↓
              llm_output hook 检测到 <at> 标签
                         ↓
              enqueueSystemEvent 写入消息到文案助手的 session 队列
                         ↓
              runHeartbeatOnce 唤醒文案助手（带 retry）
                         ↓
              文案助手消费 system event，生成回复并 @ 经纪人
                         ↓
              同样的流程反向触发 → 形成对话链
```

### 自动发现

插件启动时自动从 OpenClaw 配置中发现所有飞书 Bot，无需手动配置 `botRegistry`：

1. 读取 `bindings` — 找到所有 `channel=feishu` 且有 `accountId` 的 agent
2. 读取 `channels.feishu.accounts` — 获取每个 account 的 `appId`、`appSecret`
3. 调用飞书 `bot/v3/info` API — 获取每个 Bot 的 `open_id` 和真实名称
4. 缓存到 `~/.openclaw/feishu-bot-chat/registry.json`（24 小时有效）

### 四个 Hook

| Hook | 作用 |
|------|------|
| `before_prompt_build` | 向每个 agent 的 system prompt 注入可用 Bot 列表和 `<at>` 标签格式 |
| `llm_output` | 检测回复中的 `<at>` 标签，通过 system event + heartbeat 转发给目标 agent |
| `message_sending` | 将 `@botName` 文本替换为飞书 `<at>` 标签（非流式路径的 fallback） |
| `inbound_claim` | 过滤 Bot 消息：人类消息放行并重置链深度，Bot 消息未 @ 当前 Bot 则吞掉 |

### 关键技术细节

**为什么用 `runHeartbeatOnce` 而不是 `requestHeartbeatNow`？**

`requestHeartbeatNow` 经过 heartbeat scheduler，当 gateway 有请求在处理时（`requests-in-flight`），会被静默跳过且不 retry。`runHeartbeatOnce` 是直接执行函数，配合 retry 循环可以等待队列空闲后立即执行。

**为什么 `enqueueSystemEvent` 要带 `contextKey: 'cron:...'`？**

heartbeat 运行时有两道门控：
- `shouldBypassFileGates` — 跳过 HEARTBEAT.md 文件检查（通过 `hook:` reason 满足）
- `shouldInspectPendingEvents` — 将 system event 注入到 prompt 中（需要 `cron:` 开头的 contextKey 触发 `hasTaggedCronEvents`）

两道门都要打开，转发的消息才能被目标 agent 正确消费。

**链深度控制**

每次转发时 depth +1，达到 `maxChainDepth` 后停止转发，防止 Bot 之间无限循环。人类发送新消息时重置计数器。

## 安装

```bash
openclaw plugins install github:Leochens/feishu-bot-chat-plugin
openclaw plugins enable feishu-bot-chat
```

确保参与通信的 agent 都配置了 heartbeat（interval 值不影响实际转发速度）：

```json
{
  "agents": {
    "list": [
      { "id": "agent-1", "heartbeat": { "every": "999m" } },
      { "id": "agent-2", "heartbeat": { "every": "999m" } }
    ]
  }
}
```

重启 gateway：`openclaw gateway --force`

插件会自动发现所有绑定了飞书 account 的 agent，无需额外配置。

## 配置（可选）

默认情况下插件零配置即可工作。如需自定义，可在 `openclaw.json` 的 `plugins.entries` 中配置：

```json
{
  "feishu-bot-chat": {
    "enabled": true,
    "config": {
      "maxChainDepth": 3
    }
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxChainDepth` | number | 3 | Bot 之间最大调用链深度，防止无限循环 |
| `botRegistry` | object | — | 手动指定参与通信的 Bot（覆盖自动发现） |

### 手动配置 botRegistry（高级）

如果只想让部分 Bot 参与通信，可以手动配置 `botRegistry`，此时跳过自动发现：

```json
{
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
```

## 自动发现缓存

发现结果缓存在 `~/.openclaw/feishu-bot-chat/registry.json`，24 小时有效。

- gateway 重启时如果缓存有效，不重复调 API
- 删除该文件可强制重新发现
- 新增 agent 绑定后，缓存会自动检测到不完整并重新发现

## 调试

插件会将详细日志写入 `/tmp/a2a-debug.log`，包括：
- 自动发现过程和结果
- 每次 `llm_output` 触发的详情
- `enqueueSystemEvent` 和 `runHeartbeatOnce` 的调用结果
- 转发目标和链深度

```bash
tail -f /tmp/a2a-debug.log
```

## 限制

- 仅支持飞书（`channelId === 'feishu'`）群聊场景
- 自动发现需要 agent 在 bindings 中有 `accountId` 匹配（仅 peer 匹配的 binding 不会被发现）
- Bot 必须使用飞书 `<at>` 标签格式来 @ 其他 Bot
- 依赖 OpenClaw 的 `runHeartbeatOnce` 和 `enqueueSystemEvent` 内部 API
