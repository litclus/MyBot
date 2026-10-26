---
title: "获取精华消息"
source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/get_pins_message.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 获取精华消息

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/get_pins_message.html（最后更新：11/22/2023, 4:19:57 PM）

## 接口

```http
GET /channels/{channel_id}/pins
```

## 功能描述

用于获取子频道 `channel_id` 内的精华消息。

## Content-Type

```http
application/json
```

## 返回

返回 [PinsMessage](model.md#PinsMessage) 对象。

## 错误码

详见[错误码](../../../../openapi/error/error.md)。

## 示例

响应数据包

```json
{
  "guild_id": "xxxxxx",
  "channel_id": "xxxxxx",
  "message_ids": ["xxxxx"]
}
```
