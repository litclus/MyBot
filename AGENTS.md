# AGENTS.md

给在这个仓库里工作的 agent 看的约定

## 项目是什么

QQ 群聊机器人，核心是 LangGraph 编排 + 原生 tool call + 长期记忆
平台、模型、存储都走端口/适配器隔离，不直接耦合

## 技术栈

- TypeScript + ESM，Node 22 以上，用 tsx 直接跑
- LangGraph 负责 agent ⇄ tools 循环
- Postgres + pgvector，Drizzle 只保留 schema，用 `db:push` 同步
- 模型走 OpenCode Go 的 OpenAI 兼容通道

## 当前方案

- 图片统一存 `images` 表，用 `category` 区分 `image` / `sticker` / `meme`
- 不再有 `stickers` 表、sticker 专用模块或 `[[sticker:id]]` token
- `sticker_images` 视图只取 `category` 为 sticker/meme 的图片
- sticker/meme 全局永久保存；普通 image 归上传群，30 天过期，删群级联删除
- 图片不自动入库；agent 调 `image_save` 才保存，category/caption/emotion/tags 由主模型给，不再单独调视觉模型
- 表情包按 sha256 全局去重；普通图片按群内 sha256 去重
- 最近 10 分钟内的历史图片放内存缓存，agent 通过 `image_view` 按需打开；过期后只剩附件元数据
- 引用消息里的图片会解析、下载并随当前消息一起给模型看，也缓存 10 分钟，可用 `image_view` + `quoted.viewId` 回看；`image_save` 传 `source: "quoted"` 可入库
- `image_save` 是回复发出后异步入库，失败只记日志，不向用户回报；这是预期行为，不算设计缺陷
- 记忆由 agent 主动写入和维护，没有用户删除/修改记忆的入口；`memory_save` 不依赖用户说“记住”
- memes 是通用梗用法库，网页来源放 `meme_sources`；真实使用只记 `memes.use_count` / `last_used_at`，不存流水表
- 回复由 agent 统一决定，没有单独 triage、插话窗口、窗口预算、唤醒词判断
- 固定口令也不直接回，统一走 agent
- agent 不需要回复时输出 `{"messages":[]}`
- 回复只接受 `{"messages":[{"plainText":"...","voiceText":"","images":[],"stickers":[]}]}`
- `plainText` 是纯文本；`voiceText` 非空时只发语音，不带 images/stickers，合成或发送失败只退回 `plainText`
- 没有最小回复间隔
- 同群不同用户可并行；同一用户短间隔新消息会取消旧的 thinking 任务；群里 @ 不受短间隔限制，直接取消同一个人上一条 thinking 任务
- `members` 只是最近活跃成员；要找不在列表里的人时用 `group_members` 调 QQ API 拉完整群成员，需要应用有群成员列表接口权限
- 消息里 @ 到的人会自动记为群成员，并把 QQ 昵称存成别名；完整名单拿不到时，靠这个仍能 @ 已知的人
- 主人 person_key 存在 `OWNER_PERSON_KEY`，命中时 InfoMessages 的 `speaker.isOwner` 为 true，agent 对主人客气
- thinking 可取消，sending 阶段不取消，已开始的分片全部发完
- 每轮历史按 `HISTORY_MAX_TOKENS`（默认 8000）估算裁剪，至少保留 `HISTORY_MIN_MESSAGES`（默认 20）条；超预算从最早直接丢；ToolMessage 只在本轮有效，不进入下一轮历史
- 历史和新消息统一为带 `time` / `id` / `speaker` / `parts` / `attachments` 的 JSON；`parts` 用 `type` 区分 text / emoji / sticker
- 最后的 InfoMessages 只用于本轮补充信息，不写入历史
- 写操作先进入图状态，第一片回复真正发出后才提交；异步执行，发送失败整轮丢弃，过期直接丢弃
- `memory_save` 例外：graph 结束后异步提交，不依赖回复是否发出
- 发送失败按 `SEND_MAX_RETRIES` 重试
- 配置走 `/admin` 控制面板，存 `app_settings`，默认账号密码 `litclus/litclus`
- 数据页 `/admin/data` 只做图片/梗查看删除和记忆查看；记忆没有用户删除入口
- 面板账号密码用 `.env` 的 `PANEL_USER` / `PANEL_PASSWORD`；`.env` 只保留数据库密码和面板账号密码
- 不兼容旧格式、旧表、旧数据、旧命令
- 用户引用消息解析到 `current.quoted`
- 收到撤回事件按平台消息 id 删除本地消息
- 主动消息每个群每天随机一次，按上海时间分时段调整语气，最后一条消息超过 5 分钟不补

## 用户已考量

以下不是待修问题，不要反复提

- 语音由其他人负责，不在本仓库当前范围
- 梗使用次数只由 agent 调 `meme_mark_used` 记录，不做 keyword 自动匹配
- `image_save` 异步入库，失败只记日志，不向用户回报；无回复时也不提交
- 面板登录限流、密钥明文存储不在当前范围
- `cleanup` 只在每天上海时间 0 点跑，不做启动即清
- `drizzle-kit` 保持现状，不引入迁移文件，也不做旧格式兼容
- 数据页图片支持查看、删除、上传（只收 sticker/meme）和编辑分类/描述/情绪/标签；梗支持编辑和删除，记忆只读

## 目录

- `src/adapters/` 外部系统：QQ 网关、模型 provider
- `src/agent/` LangGraph、工具注册表、提示词、延迟动作
- `src/app/` Bot、ingest、health、cleanup、日志、控制面板
- `src/chat/` @ 解析、回复 JSON、Markdown 清洗
- `src/proactive/` 主动消息调度
- `src/services/` 汇率、余额、网页搜索、语音合成
- `src/settings/` 面板配置定义与持久化
- `src/memory/` 记忆与画像
- `src/memes/` 梗知识库
- `src/media/` 图片下载、压缩、存储、上传
- `src/db/` schema 与 repository
- `src/scripts/` image CLI
- `tests/unit/` 纯逻辑单元测试
- `tests/smoke/` 冒烟脚本
- `prompts/` 人设与运行规则，两个 Markdown 文件
- `docs/` 第三方接口文档，只读，不要改

## 写文档和提示词

- 句末不加句号，标题、列表项、正文都按这个来
- 中文为主，句子短，少用连接词
- 提示词里用 `#` 的数量表示重要程度：`#` 硬约束，`##` 主干，`###` 细节和样例

## 写工具

- 工具定义放 `src/agent/tools.ts`，语义判断交给模型，这里只做机械查询和格式化
- 工具的返回值是给模型看的一句话，**句末不加句号**，查不到就直说，不编
- 什么时候该调这个工具，写进 `prompts/system.md` 的工具小节，不要写进人设
- 查不到数据的路径要显式返回失败原因，不要用 0 或空值代替

## 写人设

- 只放名字、昵称、性格、说话风格、语气样例，不放工具规则
- 名字用 `{{name}}`，昵称用 `{{nicknames}}`，由 `src/app/bot.ts` 注入
- 改完跑 `pnpm smoke:prompt`，它要求人设里有 `{{name}}`、没有工具名

## 改配置

- `.env` 只放启动必须项，例如 `POSTGRES_PASSWORD`、`PANEL_USER`、`PANEL_PASSWORD`
- 其它配置一律进控制面板，存 `app_settings`，不要写进 `.env`
- 新增配置先看 `src/settings/schema.ts`，能面板配置就不要加环境变量
- 只有启动前必须读到的配置才加环境变量
- 新增环境变量要同时改三处：`src/config.ts` 的 zod schema、`.env.example`、README 的说明
- 数值型配置给合理的默认值，启动期校验失败就直接报错

## 回复风格

- 回复正文不用 Markdown：无标题、无加粗、无列表符号、无表格、无代码围栏
- 回复句末不加句号，逗号尽量用空格代替
- 长度一到两行，被要求解释时才放宽

## 命令

- `pnpm typecheck`
- `pnpm test` 纯逻辑单元测试
- `pnpm smoke:prompt` 提示词读取与占位符注入
- `pnpm smoke:agent` 工具循环
- `pnpm smoke:pipeline` 从假事件到回复
- `pnpm smoke:media` 图片 JSON → Markdown
- `pnpm db:push` 改 schema 后直接同步数据库，并写表/字段注释
- `pnpm db:comments` 只重新写表/字段注释

## 不要做

- 不改 `docs/` 里的第三方文档
- 不提交 `.env`
- 不在提示词里提工具名之外还写死内部字段
- 不为了让测试过而改测试的断言
- 不保留 Drizzle 迁移文件和迁移历史，最终 schema 直接用 `db:push`
- 不保留旧表、旧字段、旧格式兼容代码，冲突数据直接删
- 不新增 sticker 专用表、模块、命令或 token
