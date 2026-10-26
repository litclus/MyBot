---
title: "获取机器人在频道可用权限列表"
source: "https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/get_guild_api_permission.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 获取机器人在频道可用权限列表

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/get_guild_api_permission.html（最后更新：11/22/2023, 4:19:57 PM）

## 接口

```http
GET /guilds/{guild_id}/api_permission
```

## 功能描述

用于获取机器人在频道 `guild_id` 内可以使用的权限列表。

## Content-Type

```http
application/json
```

## 返回

| 字段名 | 类型 | 描述 |
| --- | --- | --- |
| apis | [APIPermission](model.md#APIPermission) 对象数组 | 机器人可用权限列表 |

## 错误码

详见[错误码](../../../openapi/error/error.md)。

## 示例

响应数据包

```json
{
  "apis": [
    {
      "path": "/guilds/{guild_id}/members/{user_id}",
      "method": "GET",
      "desc": "获取当前频道成员信息",
      "auth_status": 0
    },
    {
      "path": "/channels/{channel_id}/messages",
      "method": "POST",
      "desc": "创建消息",
      "auth_status": 1
    }
  ]
}
```
