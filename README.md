# blive-tts — B站直播 TTS 油猴脚本

> Bilibili Live TTS — 在浏览器里把直播间的互动读出来。

一个 [Tampermonkey](https://www.tampermonkey.net/) 用户脚本：监听 B 站直播间的 **进房 / 关注 / 点赞 / 送礼 / 弹幕 / 醒目留言**，用 TTS 语音播报出来。带完整的图形设置页，TTS 后端可插拔切换，支持小米 MiMo 云端 TTS、任何 OpenAI 兼容 TTS，以及免费的浏览器语音。

**仓库地址**：https://github.com/AdoreJc/blive-tts

## 特性

- **六类互动播报**：进房、关注、点赞、送礼、弹幕、醒目留言，每类可单独开关、单独模板
- **TTS 后端可插拔**（三种模式）
  - 小米 MiMo 云端 TTS（`chat/completions` 音频接口，返回 WAV 直接播放）
  - 任何 OpenAI 兼容 `audio/speech` 接口（baseUrl / model / voice 自定义）
  - 浏览器 `speechSynthesis`（免费，无需任何服务）
- **插件化配置**：Base URL、API Key、模型、音色、风格、语速（0.5–2）、音调、音量全部可调
- **并发预取**：播放当前句时预取队列里后续 3 句的语音，播完无缝接下一句，不留空白
- **请求速率限制**：RPM 滑动窗口限流，`0` = 不限制
- **弹幕过滤**：可开关"屏蔽抽奖弹幕"，关键词自定义（口令 / 天选时刻 / 抽奖 等）
- **面板内调试日志**：设置页底部实时显示最近 100 条日志，含每条 TTS 的具体文本
- **不干扰页面**：原生 `protover=3`（Brotli）协议原样透传，直播页面的聊天区正常滚动

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击脚本文件安装，或在 Tampermonkey 中新建脚本并粘贴 [`bilibili-live-tts.user.js`](./bilibili-live-tts.user.js) 的全部内容
3. 打开任意 `live.bilibili.com` 直播间，点击 Tampermonkey 图标 → **打开 B站直播 TTS 设置**

## 配置

设置面板包含：

| 分组 | 说明 |
|---|---|
| 播报开关 / TTS 模式 | 开关；`浏览器语音` / `OpenAI 兼容` / `小米 MiMo 云端` |
| 服务配置 | Base URL、API Key（仅存本地）、模型、音色、语言、风格 |
| 声音参数 | 语速 0.5–2、音调、音量 |
| 队列与限流 | 播报间隔、最大排队、**请求速率限制 RPM（0=不限）** |
| 播报哪些互动 | 六类互动独立开关 |
| 弹幕过滤 | 屏蔽抽奖弹幕 + 自定义关键词（逗号分隔） |
| 播报模板 | 每类互动的模板，变量：`{user}` `{message}` `{gift}` `{count}` `{price}` |
| 调试 | 显示调试日志 / 清空日志，面板内实时日志区 |

### 使用小米 MiMo TTS

在 [小米 MiMo 开放平台](https://platform.xiaomimimo.com/) 获取 API Key，然后在设置页填写：

- **Base URL**：`https://token-plan-cn.xiaomimimo.com/v1`
- **模型**：`mimo-v2.5-tts`（或带 `voicedesign` 的音色设计模型）
- **音色**：如 `mimo_default` / `default_zh` / `Mia` / `Chloe` / `Milo` / `Dean`
- **风格**：自然语言描述，会作为 `<style>` 注入；语速值也会自动并入（`1.0` 时不注入）

> MiMo 没有原生 `speed` 参数，语速通过 `<style>语速加快/放慢到约 N 倍。</style>` 的自然语言指令实现。

## 协议处理说明

B 站直播默认 `protover=3`（**Brotli** 压缩）。经逆向 B 站页面播放器确认：**页面只支持 Brotli(v3) 与 JSON(v0)，没有 zlib(v2) 分支** —— 若把鉴权降级成 zlib，页面聊天区会因无法解包而冻结。

因此本脚本的做法是：

- **不修改鉴权包**（`protover` 保持 3），页面 UI 与脚本读同一份原始数据流；
- 脚本内部自解 Brotli，**复用页面自带的 `window.BrotliDecode`**（无外部依赖、零额外下载）；
- 心跳包（op 3）按协议头 `operation` 过滤；
- `INTERACT_WORD_V2` / `SEND_GIFT_V2` 等 Protobuf 命令用手写的最小 protobuf 解码器解析（无第三方库）。

### 当前限制

- B 站协议会变，若新增 `_V2` 变体会在控制台输出警告（含命令名），需同步更新解析器；
- 点赞事件由 B 站合并/限流，脚本只按实际收到的事件播报；
- 抽奖弹幕无协议级标记，只能按关键词识别。

## 开发

```bash
# 语法检查 + 契约测试（无需任何依赖）
node --check bilibili-live-tts.user.js
node test_bilibili_live_tts.mjs
```

契约测试断言关键不变量：Brotli 解码路径存在、鉴权 `protover` 不被篡改、`Reflect.construct` 子类安全、RPM/日志/过滤开关存在、认证头集中构造、`settings` 不外泄到页面全局等。

## License

[MIT](./LICENSE) © AdoreJc
