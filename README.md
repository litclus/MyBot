# MyBot

一个以 QQ 群聊为第一个接入场景的通用 agent。核心是 **LangGraph 编排 + 原生 tool call + 长期记忆**，平台、模型、存储都通过端口/适配器隔离

## 当前形态

```text
QQ 群 @ 消息
   │  WebSocket (identify / 心跳 / resume)
   ▼
QQ Adapter ── 归一化 ── 入库(messages/persons/conversations)
   │
   ▼
LangGraph: agent ⇄ tools (memory_* / profile_get / image_* / meme_*)
   │
   ▼
OpenCode Go (deepseek-v4.1-flash) ── 原生 tool_calls
   │
   ▼
QQ OpenAPI 被动回复 (msg_id + msg_seq)
```

- 模型：只使用 OpenCode Go 的 `deepseek-v4.1-flash`，直连 `inference/go/openai/v1`，不经过 `opencode serve`
- 工具：在 MyBot 进程内执行，不依赖 MCP，也不依赖 OpenCode 的 agent 上下文；`group_members` 通过 QQ API 拉当前群成员，用于找人和 @
- 大白饭：`balance_get` 调 `GO_USAGE_URL`（默认 `https://opencode.ai/zen/go/v1/usage`，用同一个 API key），拿 5 小时/本周/本月三个窗口的已用百分比，按 `GO_MONTHLY_LIMIT_USD` 换美元、实时汇率换人民币、`RMB_PER_MILLION_TOKENS`（默认 0.1 元 / 百万 token）换 token；余额取最紧的那个窗口。搜索额度（`DEEPSEEK_API_KEY` 那个账号的钱）也并进总额一起换算
- 汇率：`src/services/fx.ts` 调 `FX_API_URL`（Frankfurter v2），按货币对内存缓存 `FX_CACHE_TTL_MINUTES`（默认 360 分钟），只有实时值，没有配置兜底；`fx_rate` 工具支持任意货币对，默认人民币兑美元
- 联网：`web_search` 调 `DEEPSEEK_BASE_URL/v1/tools/search`，返回 5 条标题+摘要+链接，总长压到 1400 字符；`search_balance` 查同一账号的余额，按 `SEARCH_PRICE_RMB_PER_1K`（默认 5 元/千次）判个档位，只回“还够用 / 不太够用 / 快见底了”，不报次数也不报金额
- 记忆：Postgres + `memories` 表；后台每 5 秒批量加工未读消息，自动生成 kind/重要度/tags/TTL/事实，并写回 `memories` 与 `persons.profile`。召回用本地 bge-small-zh 向量 + 关键词 + 重要度 + 时间衰减混合排序
- 图片：用户当前消息里的图片会直接作为 image part 交给多模态模型看；引用消息里的图片也会解析并下载给模型，缓存 10 分钟，可用 `image_view` + `quoted.viewId` 回看，`image_save` 传 `source: "quoted"` 可以入库；普通历史图片同样走内存缓存
- 图片库：统一存 `images` 表，用 `category` 区分 `image` / `sticker` / `meme`；sticker/meme 全局共享、永久保存，普通 image 归上传群、30 天后过期、随群删除；不再自动入库，主模型看图后调用 `image_save` 才保存，category/caption/emotion/tags 都由主模型给，不单独调视觉模型
- 回复里的图片和表情包都通过 JSON 里的 `images` / `stickers` id 指定，走 Markdown 媒体引用
- 健康检查：`http://127.0.0.1:8787/healthz`

## 回复策略

- 所有消息都交给同一个 agent，不再有单独的 triage 模型
- agent 判断不需要回复时直接输出 `{"messages":[]}`
- 被 @ 或明确点名时必须回
- 普通群聊只有在被问到、话题需要补充、或明显在接机器人时才会回
- 没有最小回复间隔，也没有窗口预算
- 同群不同用户可并行处理；同一用户 3 秒内又发消息会取消旧的 thinking 任务；群里 @ 不受 3 秒限制，直接取消同一个人上一条 thinking 任务
- thinking 可取消，sending 阶段不取消，已经开始的分片会全部发完
- 每轮历史按 `HISTORY_MAX_TOKENS`（默认 8000）估算裁剪，至少保留 `HISTORY_MIN_MESSAGES`（默认 20）条；超预算从最早直接丢；ToolMessage 只在本轮有效，不进入下一轮历史
- 历史和新消息统一成 JSON：`time`、`id`、`speaker`、`parts`、`attachments`；`parts` 用 `type` 区分 `text` / `emoji` / `sticker`
- 最后的 InfoMessages 只放本轮补充信息，不写入历史
- 写操作先进入图状态，第一片回复真正发出去后才提交；发送失败整轮丢弃，超过 `DEFERRED_ACTION_TTL_SECONDS` 也直接丢弃
- `memory_save` 例外：graph 结束后异步提交，不依赖回复是否发出
- 发送失败按 `SEND_MAX_RETRIES` 重试
- 消息超过 4.5 分钟直接跳过，避免回复过气上下文
- 全量模式**不是开发者后台的开关**，而是群主在手机 QQ 的群设置里给机器人开“获取群内全部消息”，每个群单独设置；WebSocket 模式不需要勾选回调事件（Webhook 才需要在回调配置里勾 `GROUP_MESSAGE_CREATE`）
- 私聊 `C2C_MESSAGE_CREATE` 已接入，和群聊共用同一套回复管线


## 快速开始

```bash
docker compose up -d          # Postgres + pgvector
pnpm install
cp .env.example .env          # 填 POSTGRES_PASSWORD；面板账号和端口也在 .env
pnpm db:push
pnpm dev
```

群里 @ 机器人即可；普通消息也会交给 agent 判断要不要回

## 控制面板

启动后打开：

```text
http://localhost:8788/admin
```

默认账号密码：

```env
PANEL_USER=litclus
PANEL_PASSWORD=litclus
```

- 面板默认监听 `localhost:8788`，只绑本机
- 登录后会话有效期 10 分钟，过期自动回到登录页
- 配置保存在数据库 `app_settings`，不再改 `.env`
- 保存时按启动用的 EnvSchema 校验，非法值直接拒绝，不会写一半
- 每项右侧的「默认」按钮会删掉数据库覆盖值，恢复 `.env` 里的值
- 大部分配置保存后立即生效
- 标了「重启」的配置需要重启进程
- 「主人 person_key」填对应用户的 `person_key`，agent 会对这个人更客气；留空不启用
- 密钥字段显示等长 `*`，聚焦后可输入新值；不输入则保持原值
- `.env` 只保留数据库密码、面板账号密码和面板端口
- 数据页：`http://localhost:8788/admin/data`，图片可查看/删除/上传（只收 sticker/meme）/编辑分类、描述、情绪、标签；梗可查看/编辑/删除；记忆只读

## 常用命令

```bash
pnpm typecheck
pnpm test             # 纯逻辑单元测试：切分、清洗、@、图片结果、尺寸
pnpm smoke:db         # 数据库读写 + 向量距离
pnpm smoke:gateway    # 本地 mock 网关：hello/identify/心跳/READY/事件
pnpm smoke:pipeline   # 假事件 → 入库 → LangGraph → 记忆工具 → 回复
pnpm smoke:enrich     # 记忆加工：一条偏好 → memories
pnpm smoke:embed      # 本地 embedding：512 维 + 语义相似度
pnpm smoke:search     # 语义召回：换个说法也能找到记忆
pnpm smoke:meme       # 梗检索与使用回写
pnpm smoke:image      # 当前消息图片进入模型
pnpm smoke:media      # 图片库 → JSON images/stickers → Markdown
pnpm smoke:format     # 回复 Markdown 清洗
pnpm smoke:mention    # @ 人：token 解析 + 不自动@提问者
pnpm smoke:agent      # LangGraph + memory_search 单独验证
pnpm smoke:prompt     # 系统提示词读取 + {{name}} / {{nicknames}} 注入
pnpm smoke:model      # 文本 / 工具 / 视觉（视觉请节制）
pnpm db:push          # 用 schema 直接同步数据库，并写表/字段注释，不保留迁移历史
pnpm db:comments      # 只重新写表/字段注释
pnpm db:studio        # 浏览器看表
```

## 目录

```text
src/
├─ adapters/
│  ├─ qq/              # auth / api / gateway / normalize
│  └─ models/          # OpenCode Go 直连
├─ agent/              # LangGraph、提示词、工具、延迟动作
├─ app/                # Bot、ingest、health、cleanup、日志、控制面板
├─ chat/               # mentions、回复 JSON、Markdown 清洗
├─ proactive/          # 主动消息调度与判断
├─ services/           # balance、fx、websearch
├─ settings/           # 面板配置定义与持久化
├─ media/              # 图片下载、压缩、存储、上传
├─ memory/             # 记忆召回、加工、摘要、embedding
├─ memes/              # 梗用法库、来源、使用记录
├─ db/                 # Drizzle schema / repository
├─ ports/              # 模型端口
├─ scripts/            # image CLI
└─ util/
tests/
├─ unit/               # 纯逻辑单元测试，按模块分目录
└─ smoke/              # 需要数据库/网络的冒烟脚本
docs/                  # QQ 官方文档离线镜像
```

## 系统提示词

分成两个 Markdown 文件，都是 system prompt：

| 文件 | 内容 | 名字 |
|---|---|---|
| `prompts/system.md` | 运行规则：工具调用、记忆、输出约束、上下文格式 | 不注入名字 |
| `prompts/persona.md` | 人设：名字、昵称、性格、说话风格、边界 | 用 `{{name}}` 和 `{{nicknames}}` 注入 |

昵称取 `WAKE_WORDS`，**顺序就是注入顺序**（默认 `大肥鱼,肥鱼,吃白饭的,吃大白饭的,哦鲸鲸,鲸鲸,鲸鱼,ds,deepseek`），用顿号连起来注入；同一昵称写两遍只留一次，与名字相同也照留

启动时分别读取 `SYSTEM_PROMPT_FILE` 和 `PERSONA_PROMPT_FILE`，先用 `BOT_NAME`（默认 `MyBot`）渲染一版；QQ 网关 READY 后拿到机器人真实昵称，再重新渲染：

```text
gateway READY e4075587-...
bot name updated DeepSeek
```

发给模型时是两条 system 消息：先运行规则，后人设。改文件后重启生效

## 向量召回

- 模型：`Xenova/bge-small-zh-v1.5`，512 维，CPU 本地跑，无外部 API
- 运行环境：Node 22；`onnxruntime-node` 锁在 **1.20.1**（1.30.0 的 Windows 二进制在本机会 `0xC0000005`）
- 写入：记忆加工、episode 摘要、用户明确要求记住时生成向量，写进 `memories.embedding`
- 查询：先用 pgvector HNSW 索引按 `embedding <=> query` 取最近 50 条，再合并关键词命中，混合打分：

```text
0.5 * 余弦 + 0.2 * 关键词命中 + 0.2 * 重要度 + 0.1 * 时间衰减
```

- 低于阈值且没有关键词命中就返回空；embedding 不可用时自动退回关键词
- 记忆由 agent 主动判断并调用 `memory_save`，不依赖用户说“记住”，graph 结束后异步提交
- 没有用户删除或修改记忆的入口；记忆只由 agent 写入，旧记忆由加工流程标记失效或过期
- 首次使用会从 `hf-mirror.com` 下载模型，之后走本地缓存
- 索引：`memories_embedding_hnsw_idx`、`memes_embedding_hnsw_idx`、`images_embedding_hnsw_idx`，`vector_cosine_ops`
- 查询时设置 `hnsw.iterative_scan = relaxed_order`、`hnsw.ef_search = 100`，带会话过滤时不会因为第一轮候选太少而漏结果
- 关键词候选单独查，避免没有 embedding 的旧记忆被漏掉

## 梗知识库

- `memes` 表是通用梗用法库：`keyword`、`aliases`、`title`、`meaning`、`reply_guide`、`examples`、`tags`、`heat`、`status`、`embedding`
- `meme_sources` 存网页来源：`url`、`title`、`site`、`summary`、`published_at`、`fetched_at`、`authority`、`content_hash`
- 不存检索/使用流水；真实使用只记 `memes.use_count` 和 `last_used_at`
- 检索：带关键词时 `0.45 * 向量 + 0.2 * 关键词 + 0.15 * 热度 + 0.1 * 时间 + 0.1 * 使用次数`，不带关键词时 `0.6 * 热度 + 0.25 * 时间 + 0.15 * 使用次数`，只取 `status=active`
- 检索不增加 `use_count`；agent 真的用了梗之后调 `meme_mark_used`，`use_count + 1`
- Agent 工具：`meme_search`、`meme_mark_used`、`meme_upsert`、`meme_delete`、`meme_set_status`、`meme_set_heat`，可以自己增删改、标记过时、调整热度
- 网页搜到梗后，`meme_upsert` 可以带 `sourceUrl` / `sourceTitle` / `sourceSummary` / `sourceSite`
- `meme_search` 返回含义、回复方式和示例，由 agent 按 `replyGuide` 和 `examples` 自己组织回复；没有固定口令策略
- 不再有固定口令快速回复，所有回复都经过 agent
- 种子：`seeds/memes.json`，启动时只补缺失的条目，不覆盖 agent 之后的修改

## @ 人

- 当前消息的 JSON 里会带 `members`：最近活跃成员的名字、角色和短 token，不暴露 openid
- 要找的人不在最近活跃列表时，Agent 调 `group_members` 拉当前群完整成员列表，可按群名片、QQ 昵称或别名筛选；每页 30 人，完整名单需要 QQ 应用有群成员列表接口权限
- 消息里 @ 到的人会自动记入成员表，并把 QQ 昵称记成别名；所以群名片和 QQ 昵称不一致时也能搜到并 @，不依赖群成员接口权限
- `group_members` 返回的 token 会临时加入本轮 @ 候选，发送前同样解析成真正的 @
- Agent 决定要不要 @、@ 谁；如果要，就在回复里写 `[[mention:token]]`，可以写多个
- Bot 在发送前把 token 换成 QQ 的 `<qqbot-at-user id="..." />`；私聊降级成 `@名字`
- **不会自动 @ 提问者**。模型不写 token，回复里就不会出现任何 @
- 模型编造/写错的 token 会被剥掉，不会把内部标记发给用户

## 引用与撤回

- 用户引用消息时，QQ 用 `message_type=103` 下发，被引用内容在 `msg_elements` 里
- Bot 解析出 `current.quoted`：`author` + `text`，模型回答“这条/他说的”时以它为准
- 收到 `GROUP_MESSAGE_DELETE` / `C2C_MESSAGE_DELETE` / `MESSAGE_DELETE` 等撤回事件时，按平台消息 id 删除本地 `messages` 记录
- 撤回只删消息，不自动删已经加工出的记忆

## 分片回复

- 模型最终回复只输出 JSON：`{"messages":[{"plainText":"...","voiceText":"","images":[],"stickers":[]}]}`
- `messages` 为空表示不回复
- 每项字段固定为 `plainText` / `voiceText` / `images` / `stickers`
- `plainText` 是纯文本；`voiceText` 非空时只发语音，不带 images/stickers，失败只退回 `plainText`
- `images` 填 category=image 的 id，`stickers` 填 category=sticker/meme 的 id
- 最多发 3 条，多出的合并到最后一条
- 文字和图片仍走 Markdown 接口；语音走 TTS 合成后上传 QQ 富媒体消息
- 分片之间按文本长度随机等待 0.3–2.5 秒，模拟人类输入
- 每条分片都会写入 assistant 历史，下一轮上下文能看到

## 语音回复

- 面板「语音」组配置 `MIMO_API_KEY`、接口、模型、音色和音色描述
- 默认用 `mimo-v2.5-tts-voicedesign`，`MIMO_TTS_STYLE` 固定为小萝莉、软糯、轻、偏高，保证每次音色和语气一致
- `MIMO_TTS_VOICE` 只在 `mimo-v2.5-tts` 预置音色模型下生效
- `voiceText` 可以用 `(风格)` 或 `[音频标签]` 控制这一句的语气；音色由固定配置控制，模型只负责风格
- `voiceText` 非空时只发语音，不会同时发 `plainText`、图片或表情包
- 语音合成或发送失败时只退回 `plainText` 纯文本，不带图片或表情包；`plainText` 为空则发固定兜底文案
- 语音和表情包可以分两条发，一条语音一条表情包
- 语音音频不落库，按需合成，避免占存储

## 图片与表情包

- 图片统一存 `images` 表，`category` 为 `image` / `sticker` / `meme`
- sticker/meme 全局共享，`conversation_id` 为 null；普通 image 归上传群，删群时级联删除
- `sticker_images` 视图只取 category=sticker/meme，给需要单独看表情包的场景用
- 用户发图时，当前消息里的图片全部下载后交给模型；单张超过 4MB 或格式不支持就只留文字
- 下载过的图片按消息 id 在内存里留 10 分钟，后面几轮可以调 `image_view` 按需回看
- 附件不再自动入库；用户要保存、或这张图以后能当表情包/梗图复用时，agent 调 `image_save`，下载后按 sha256 去重；sticker/meme 全局永久保存，普通图片归上传群、30 天后过期
- `image_save` 的 `index` 指来源里的第几张图；`source: "quoted"` 保存引用图片，`viewId` 可以保存 10 分钟缓存里的历史图片
- `image_save` 会给每张图写 caption/emotion/tags 并生成 embedding；只有 caption 非空的图能被 `image_search` 搜到
- `image_search` 用 pgvector HNSW + 关键词混合检索，打分 `0.45 * 余弦 + 0.3 * 关键词 + 0.15 * 时间衰减 + 0.1 * 使用次数`；sticker/meme 搜全库，普通图片只搜本群
- 面板「允许保存图片」（`IMAGE_SAVE`）关闭后，`image_save` 工具不注册，图片库只能靠 `image:add`
- Agent 需要图片时先 `image_search` / `image_list` 拿 id，再把 id 写进回复 JSON
- 图片或表情包真的发出去后回写 `use_count` 和 `last_used_at`
- `image_update` 改 category/caption/情绪/标签；改成 sticker/meme 会转全局，改回 image 会归当前群并重新计算 30 天
- `image_delete` 只能删本群普通图片或任意 sticker/meme
- Bot 把图片上传成 `qqbot-media://` 引用
- 所有回复统一走 Markdown：可以是单文本、单图片、文本 + 多张图片
- 一条回复最多取前 4 个媒体 id
- GIF 和静态图统一处理：文字和图片放进同一条 Markdown
- Markdown 显示尺寸按原图比例缩到最长边 200px，不放大
- 显示尺寸由 `IMAGE_DISPLAY_MAX_WIDTH`、`IMAGE_DISPLAY_MAX_HEIGHT` 控制
- 实际文件尺寸不受影响：GIF 保留原动画，静态图仍按压缩规则处理

## 测试图片

1. 在群里发一张 GIF 或图片
2. 让机器人保存这张图（或 `pnpm image:add`），再 `pnpm image:list` 看有没有入库，记下 `#id`
3. `pnpm image:media <id>` 测真实上传，成功会打印 `qqbot-media://...`
4. `pnpm image:send <id> "测试"` 直接往该群发一条文字+图片（被动回复，需要最近 4.5 分钟内的 msg_id）
5. `pnpm image:send <id> "测试" [group_openid] --active` 走主动消息，不需要 msg_id
6. 群里 @ 机器人说“发个表情包”，走 agent：`image_search` → JSON `stickers` → Markdown
7. `pnpm smoke:media` 只测 JSON 分片和 Markdown 组装，不碰 QQ 网络

## 图片压缩

- GIF **不压缩**，保留原始动画，最大 10MB
- PNG/JPEG/WebP 最长边 512，优先转 webp，目标 ≤1.5MB
- 显示尺寸按原图比例缩到最长边 200px，可在控制面板调整；GIF 同样只缩显示尺寸，不改文件
- 历史数据 `pnpm image:recompress`；GIF 会被跳过
- 如果 GIF 很大又必须小于限制，只能转静态或接受原文件大小，不建议自动做

## 数据清理

- 每天上海时间 0 点跑一次
- sticker/meme 永久保存
- 其它图片按 `expires_at` 删除，保留 30 天；历史普通图片没有 `expires_at` 时按 `created_at + 30 天` 补上
- 过期消息再宽限 7 天删除，过期记忆再宽限 30 天删除

## 主动消息

- 每个群每天随机抽一个时间点做一次主动回复判断，时间落在 1–24 小时内，任何时段都可能触发
- 触发后按上海时间判断时段：深夜 / 清晨 / 上午 / 中午 / 下午 / 晚上 / 夜深，prompt 里带对应的话题和语气要求，回复内容贴合时间但不直接报时间
- 到点时先看最后一条消息：
  - 必须是用户消息
  - 距离现在不能超过 `PROACTIVE_MAX_AGE_MINUTES`（默认 5 分钟）
  - 超过就当天不回复，不补之前没来得及回的消息
- 最后一条是机器人消息、群已经冷掉、模型判断没有自然接话点，都直接跳过
- 机器人离线错过随机时间超过 `PROACTIVE_MISS_GRACE_MINUTES`（默认 10 分钟）也不补，直接排下一天
- 发送走主动消息，不带 `msg_id`；发完写入 assistant 历史
- 调度状态存在 `proactive_schedules`，重启不会重复抽当天的时间
- 请求体不传 `msg_id` / `msg_seq` 就是主动消息
- 群聊频控：Bot 维度 60/qpm，单群 20/qpm，每天 1000 条/群（未认证是 30/qpm）
- 用户可以在 QQ 客户端关闭「允许主动发送」，关闭后主动消息会失败
- 手动测试：`pnpm image:send 1 "测试" <group_openid> --active`
- 被动回复仍然按 `msg_id` 去重，同一个消息多次回复要递增 `msg_seq`

## 尚未完成

- 主动消息目前只有每日随机判断，没有事件触发（未回复问题、到期提醒等）
- 配置中心热更新、场景清单、指标面板
- 多平台/多场景还只有 QQ
