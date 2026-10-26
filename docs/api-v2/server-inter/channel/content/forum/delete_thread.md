---
title: "删除帖子"
source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/delete_thread.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 删除帖子

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/delete_thread.html（最后更新：11/22/2023, 4:19:57 PM）

## 接口

```http
DELETE /channels/{channel_id}/threads/{thread_id}
```

## 功能描述

- 该接口用于删除指定子频道下的某个帖子。

> **注意**
>
> - 公域机器人暂不支持申请，仅私域机器人可用，选择私域机器人后默认开通。
> - 注意: 开通后需要先将机器人从频道移除，然后重新添加，方可生效。

## Content-Type

```http
application/json
```

## 错误码

详见[错误码](../../../../openapi/error/error.md)。

## 返回

HTTP 状态码 `204`
