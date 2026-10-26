---
title: "删除频道公告"
source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_guild_announces.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 删除频道公告

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_guild_announces.html（最后更新：11/22/2023, 4:19:57 PM）

## 接口

```http
DELETE /guilds/{guild_id}/announces/{message_id}
```

## 功能描述

用于删除频道 `guild_id` 下指定 `message_id` 的全局公告。

- `message_id` 有值时，会校验 `message_id` 合法性，若不校验校验 `message_id`，请将 `message_id` 设置为 `all`。

## Content-Type

```http
application/json
```

## 返回

成功返回 HTTP 状态码 `204`。

## 错误码

详见[错误码](../../../../openapi/error/error.md)。

## 示例

请求数据包

```text
DELETE /guilds/123456/announces/112233
```
