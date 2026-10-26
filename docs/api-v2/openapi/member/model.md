---
title: "成员对象(Member)"
source: "https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/model.html"
last_updated: "11/22/2023, 4:19:57 PM"
---
# 成员对象(Member)

> 原文：https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/model.html（最后更新：11/22/2023, 4:19:57 PM）

### Member

| 字段名 | 类型 | 描述 |
| --- | --- | --- |
| user | [User](../user/model.md#user) | 用户的频道基础信息，只有成员相关接口中会填充此信息 |
| nick | string | 用户的昵称 |
| roles | string 数组 | 用户在频道内的身份组ID, 默认值可参考[DefaultRoles](../guild/role_model.md#DefaultRoles) |
| joined_at | ISO8601 timestamp | 用户加入频道的时间 |

### MemberWithGuildID

| 字段名 | 类型 | 描述 |
| --- | --- | --- |
| guild_id | string | 频道id |
| user | [User](../user/model.md#user) | 用户的频道基础信息 |
| nick | string | 用户的昵称 |
| roles | string 数组 | 用户在频道内的身份 |
| joined_at | ISO8601 timestamp | 用户加入频道的时间 |
