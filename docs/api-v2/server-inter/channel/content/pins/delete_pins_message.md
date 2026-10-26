---
title: "删除精华消息"
source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/delete_pins_message.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 删除精华消息

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/delete_pins_message.html（最后更新：11/22/2023, 4:19:57 PM）

## 接口

```http
DELETE /channels/{channel_id}/pins/{message_id}
```

## 功能描述

用于删除子频道 `channel_id` 下指定 `message_id` 的精华消息。

- 删除子频道内全部精华消息，请将 `message_id` 设置为 `all`。

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
DELETE /channels/123456/pins/112233
```
