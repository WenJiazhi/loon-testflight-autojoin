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

- `testflight-autojoin.plugin`: 主插件，只负责定时加入，不包含 MITM。
- `testflight-capture.plugin`: 临时抓令牌插件，包含 `testflight.apple.com` MITM，抓完就删除或禁用。
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

3. 主插件不包含 MITM，长期启用它不应影响 TestFlight 正常打开。
4. 在主插件参数 `App_ID` 填公开邀请链接或邀请码，支持逗号、空格、换行：

```text
https://testflight.apple.com/join/ABCDEFGH
ABCDEFGH,IJKLMNO1
```

5. 默认每 2 分钟检查一次。名额未满时会请求加入，成功后从队列移除并记录到 `tfaj.done`，避免重复加入。

## 抓令牌

自动加入需要 TestFlight 的账号令牌。这个令牌只能从 TestFlight App 的 HTTPS 请求里抓到，因此需要临时启用 MITM：

```text
https://raw.githubusercontent.com/WenJiazhi/loon-testflight-autojoin/main/testflight-capture.plugin
```

流程：

1. 临时启用 `TestFlight Token Capture`。
2. 重启 Loon VPN。
3. 杀掉 TestFlight 后重新打开，进入任意页面。
4. 看到“令牌获取成功”后，立刻禁用或删除 `TestFlight Token Capture`。
5. 保留主插件 `TestFlight Auto Join` 运行。

如果启用 `TestFlight Token Capture` 后 TestFlight 直接报 Apple Connection 错误，说明当前设备/系统/网络下 TestFlight 不能被 Loon 解密。此时主插件不会影响 TestFlight，但无法在这台设备上自动抓令牌；可以复用旧可莉/fmz200 插件已经保存的 `fmz200_TF_header`，或在另一台能抓到令牌的环境导入该持久化数据。

## 参数

- `App_ID`: 邀请码或完整公开链接，兼容可莉/fmz200 版本。
- `MAX_PER_RUN`: 每次 cron 最多检查多少个，默认 `8`，最大 `20`。
- `REMOVE_404`: `0` 保留 404 链接，`1` 自动删除 404 链接。

## 兼容旧脚本

如果你之前用过旧脚本，`App_ID`、`APP_ID` 或可莉版本的 `fmz200_TF_header` 会被自动导入。成功加入后，新队列会移除对应 code；如果旧 key 里还有其他 code，会尽量同步写回。

## 注意

- 只处理公开 TestFlight 邀请链接，不绕过 Apple、开发者或 TestFlight 的限制。
- 不做高频扫描，默认 5 分钟一次，并且遇到 `401/403/429` 会停止本轮。
- 会话过期后需要临时启用 `testflight-capture.plugin` 重新抓一次；抓完继续禁用。
