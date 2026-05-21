# Loon TestFlight Auto Join

一个 Loon 插件骨架，用于定时检查公开 TestFlight 邀请码，在名额可用时自动加入。

## 为什么重写

常见的 `Auto_join_TF.js` 思路仍然可用：先从 TestFlight App 的 `testflight.apple.com/v3/accounts/...` 请求里抓会话头，再定时访问 `/ru/{code}`，可加入时请求 `/accept`。

旧脚本的问题主要是：

- 多数是 Surge 模块写法，依赖 `$httpAPI('/v1/modules')` 自动关闭模块，Loon 里不通用。
- 会话头字段过少或过旧，容易因为 TestFlight App 请求变化失效。
- 只用 `APP_ID` 这个逗号字符串做队列，成功、404、重复链接和插件输入不好管理。

这个版本借鉴可莉/fmz200 的 Loon 插件结构，使用 `App_ID` 和 `fmz200_TF_header` 兼容已有数据，同时保留状态去重和更保守的异常处理。

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
4. 保持插件参数里的 `捕获账号令牌` 为开启，重启 TestFlight App，进入任意页面，看到“令牌获取成功”后即可。
5. 在插件参数 `App_ID` 填公开邀请链接或邀请码，支持逗号、空格、换行：

```text
https://testflight.apple.com/join/ABCDEFGH
ABCDEFGH,IJKLMNO1
```

6. 默认每 5 分钟检查一次。名额未满时会请求加入，成功后从队列移除并记录到 `tfaj.done`，避免重复加入。

如果打开 TestFlight 时出现 Apple Connection 相关错误，先确认插件已更新到使用 `DIRECT` 的版本。抓到“令牌获取成功”后，可以把插件参数里的 `捕获账号令牌` 关掉，自动加入任务仍会使用已保存的令牌运行。

## 参数

- `App_ID`: 邀请码或完整公开链接，兼容可莉/fmz200 版本。
- `MAX_PER_RUN`: 每次 cron 最多检查多少个，默认 `8`，最大 `20`。
- `REMOVE_404`: `0` 保留 404 链接，`1` 自动删除 404 链接。

## 兼容旧脚本

如果你之前用过旧脚本，`App_ID`、`APP_ID` 或可莉版本的 `fmz200_TF_header` 会被自动导入。成功加入后，新队列会移除对应 code；如果旧 key 里还有其他 code，会尽量同步写回。

## 注意

- 只处理公开 TestFlight 邀请链接，不绕过 Apple、开发者或 TestFlight 的限制。
- 不做高频扫描，默认 5 分钟一次，并且遇到 `401/403/429` 会停止本轮。
- 会话过期后需要重新打开 TestFlight App，让 Loon 再抓一次请求头。
