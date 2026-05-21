# Loon TestFlight Auto Join

一个 Loon 插件骨架，用于定时检查公开 TestFlight 邀请码，在名额可用时自动加入。

## 为什么重写

常见的 `Auto_join_TF.js` 思路仍然可用：先从 TestFlight App 的 `testflight.apple.com/v3/accounts/...` 请求里抓会话头，再定时访问 `/ru/{code}`，可加入时请求 `/accept`。

旧脚本的问题主要是：

- 多数是 Surge 模块写法，依赖 `$httpAPI('/v1/modules')` 自动关闭模块，Loon 里不通用。
- 会话头字段过少或过旧，容易因为 TestFlight App 请求变化失效。
- 只用 `APP_ID` 这个逗号字符串做队列，成功、404、重复链接和插件输入不好管理。

这个版本保留接口思路，但改成单脚本、Loon 插件输入、状态去重和更保守的异常处理。

## 文件

- `testflight-autojoin.plugin`: Loon 插件入口。
- `scripts/testflight-autojoin.js`: 捕获会话和定时加入逻辑。

## 发布前要改

把 `testflight-autojoin.plugin` 里的两处地址改成你自己的仓库 raw 地址：

```text
https://raw.githubusercontent.com/WenJiazhi/loon-testflight-autojoin/main/scripts/testflight-autojoin.js
```

如果你的默认分支是 `master`，也要同步改掉 `main`。

## 使用

1. 把仓库推到 GitHub。
2. 在 Loon 添加插件 raw URL，例如：

```text
https://raw.githubusercontent.com/WenJiazhi/loon-testflight-autojoin/main/testflight-autojoin.plugin
```

3. 确认 Loon 已安装并信任 MITM 证书，插件里的 `hostname = testflight.apple.com` 已启用。
4. 打开 TestFlight App，刷新一次任意页面，让插件捕获账号会话。
5. 在插件参数 `TF_CODES` 填公开邀请链接或邀请码，支持逗号、空格、换行：

```text
https://testflight.apple.com/join/ABCDEFGH
ABCDEFGH,IJKLMNO1
```

6. 默认每 5 分钟检查一次。名额未满时会请求加入，成功后从队列移除并记录到 `tfaj.done`，避免重复加入。

## 参数

- `TF_CODES`: 邀请码或完整公开链接。
- `MAX_PER_RUN`: 每次 cron 最多检查多少个，默认 `8`，最大 `20`。
- `REMOVE_404`: `0` 保留 404 链接，`1` 自动删除 404 链接。

## 兼容旧脚本

如果你之前用过旧脚本，`APP_ID` 里的邀请码会被自动导入。成功加入后，新队列会移除对应 code；如果旧 `APP_ID` 里还有其他 code，会尽量同步写回。

## 注意

- 只处理公开 TestFlight 邀请链接，不绕过 Apple、开发者或 TestFlight 的限制。
- 不做高频扫描，默认 5 分钟一次，并且遇到 `401/403/429` 会停止本轮。
- 会话过期后需要重新打开 TestFlight App，让 Loon 再抓一次请求头。
