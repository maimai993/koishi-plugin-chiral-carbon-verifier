![koishi-plugin-chiral-carbon-verifier](https://socialify.git.ci/VincentZyuApps/koishi-plugin-chiral-carbon-verifier/image?description=1&font=Bitter&forks=1&issues=1&language=1&logo=https%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2Ff%2Ff3%2FKoishi.js_Logo.png&name=1&owner=1&pattern=Plus&pulls=1&stargazers=1&theme=Auto)

# koishi-plugin-chiral-carbon-verifier

[![npm](https://img.shields.io/npm/v/koishi-plugin-chiral-carbon-verifier?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chiral-carbon-verifier)
[![npm-download](https://img.shields.io/npm/dm/koishi-plugin-chiral-carbon-verifier?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chiral-carbon-verifier)
[![GitHub](https://img.shields.io/badge/GitHub-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/VincentZyuApps/koishi-plugin-chiral-carbon-verifier)
[![Gitee](https://img.shields.io/badge/Gitee-C71D23?style=for-the-badge&logo=gitee&logoColor=white)](https://gitee.com/vincent-zyu/koishi-plugin-chiral-carbon-verifier)

<p><del>💬 插件使用问题 / 🐛 Bug反馈 / 👨‍💻 插件开发交流，欢迎加入QQ群：<b>259248174</b>   🎉（这个群G了）</del></p> 
<p>💬 插件使用问题 / 🐛 Bug反馈 / 👨‍💻 插件开发交流，欢迎加入新QQ群：<b>1085190201</b> 🎉</p>
<p>💡 在群里直接艾特我，回复的更快哦~ ✨</p>

# 🧪 手性碳入群验证 - 用有机化学知识守护你的群聊

## ✨ 功能特点

- 🧪 **手性碳验证**：发送有机化学分子结构图，要求新成员识别手性碳原子所在区域
- 🔢 **数字验证**：简单的数学计算题作为备选方案
- 🔄 **自动降级**：当手性碳 API 不可用时，自动切换为数字验证
- 🖼️ **QQ markdown 发图**：QQ 平台用 markdown 发送题目图片（图片走 assets 服务拿公网地址），不会被二次压缩
- 🔘 **区域按钮作答**：QQ 题目消息带 A1、B2… 一组**回调按钮**（A1–E3 默认全给），点按钮直接作答
- 🌐 **网页验证**：进群静默禁言 30 天 + 只发一条链接，题目和选项都在网页里，答对自动解禁（**完全不刷屏**）
- 📈 **禁言翻倍**：禁言模式下同一成员每失败一轮，禁言时长翻倍（10→20→40→80…），并受上限约束
- 💾 **状态持久化**：验证状态写入数据库，**禁言等待中重启 koishi 也不会漏掉验证**
- ⚙️ **灵活配置**：支持全局配置 + 群单独配置
- 💪 **困难模式**：可要求答出所有手性碳区域
- 📊 **统计功能**：记录验证历史，可查看通过率
- 👢 **失败处理**：可配置踢出 / 禁言后重试 / 不处理

## 📦 安装

```bash
npm install koishi-plugin-chiral-carbon-verifier
# 或
yarn add koishi-plugin-chiral-carbon-verifier
```

## 🔧 配置项

### 基础配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否全局启用入群验证 |
| `carbonApiUrl` | string | `https://carbon.crystelf.top` | 手性碳验证 API 地址 |
| `apiTimeout` | number | `10000` | API 请求超时时间（毫秒） |
| `qqMarkdownImage` | boolean | `true` | QQ 平台用 markdown 发送题目图片（需 assets 服务；失败自动退回普通图片） |
| `markdownImageWidth` | number | `420` | markdown 图片的显示宽度上限（px），高度按真实比例缩放 |

> 🖼️ **QQ 平台发图说明**：QQ 官方 / qq-crack 适配器上，普通图片消息会被二次压缩，题目图上的小字会糊掉，
> 所以题目图改走 **markdown 图片** `![#宽px #高px](地址)`：
> - 图片地址必须是**可公网访问的 http(s)**，base64 不行 → 插件会把 API 返回的图片先上传到 **assets 服务**（`koishi-plugin-assets-local` 等）拿地址；
> - markdown 图片**必须写尺寸**，否则手机端不显示；尺寸从图片二进制头读真实值（PNG/JPEG/GIF/WebP），按比例缩放，不会拉伸；
> - 没装 assets / 上传失败 / 读不出尺寸 → 自动退回普通图片段，消息照常能发；
> - 只在 `qq` 系平台生效（OneBot / NapCat / Satori / QQ 频道都不走 md，否则会变成一串乱码）。

### 验证行为配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `verifyTimeout` | number | `120` | 验证超时时间（秒），**填 `0` 表示不限时**（不超时、不因超时踢人/禁言）；网页验证模式下不生效 |
| `verifyMode` | `message` / `web` | `message` | 验证方式：群内作答 / **网页作答**（可随时切换，见下方「🌐 网页验证」） |
| `maxAttempts` | number | `3` | 最大尝试次数（群内作答） |
| `recallWrongAnswer` | boolean | `true` | 是否撤回错误回答 |
| `failAction` | `kick` / `ban` / `none` | `kick` | 验证失败（次数用完或超时）时的处理方式 |
| `banDuration` | number | `10` | **基础**禁言时长（分钟），仅 `failAction = ban` 时生效，禁言结束后自动重新发送题目 |
| `banDurationDoubling` | boolean | `true` | 禁言时长逐轮翻倍（1→2→4→8…），同一个成员在禁言—作答循环里每失败一次就乘 2 |
| `banDurationMax` | number | `60` | 禁言时长上限（分钟），翻倍涨到这里就不再增加 |
| `verifyButtons` | boolean | `true` | QQ 平台在题目消息里附带区域代号按钮（详见下方按钮说明） |
| `buttonRegions` | string | `A1,…,E3` | 候选区域代号（默认 A1–E3 共 15 个，题目图最大就到 E3），群里按钮和网页选项都用它 |
| `reminderBeforeTimeout` | number | `60` | 超时前提醒时间（秒），0 为不提醒 |

### 🌐 网页验证（`verifyMode = web`）

不想让验证刷屏就用这个模式：**进群直接禁言 + 群里只发一条链接**，题目和选项全在网页里，答对自动解禁。

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `webServer` | string | 空 | 对外访问地址，如 `https://verify.example.com:5140`。**最终验证地址 = `服务器地址/openid`**（必填） |
| `webPort` | number | `5140` | 页面**独占的端口**：插件自己起一个 HTTP 服务监听它，和 koishi 主端口互不影响 |
| `webBanMinutes` | number | `43200` | 进群先禁言多少分钟（默认 43200 = **30 天**），验证通过自动解禁 |
| `webMaxAttempts` | number | `3` | 一轮里允许提交几次答案 |
| `webCooldownMinutes` | number | `10` | 次数用完后冷却多少分钟才能再试 |

流程：

1. 新成员进群 → 插件立即禁言（默认 30 天），往群里发**一条**链接消息（QQ 上带一个「🌐 点我验证」跳转按钮，点了直接开网页），**不 @ 人、不提示、不刷屏**；
2. 用户打开 `服务器地址/openid` → 页面里是题目图 + A1…E3 选项（点一下就是提交，不用打字）；
3. 答错 → **网页里**提示还剩几次；次数用完 → 进入冷却，网页里显示剩余时间；
4. 答对 → 立刻解除禁言，网页显示「✅ 验证通过」（群里也不发消息）。

安全性：链接里只有 openid，别人拿到链接最多只能帮这个人答题；答案只在服务端校验，页面源码里没有答案。

> 部署提示：端口要对外开放（或让 Nginx 反代到 `webPort`），`webServer` 填用户实际能访问的地址；
> 走反代时 `webServer` 填域名即可（端口由反代处理）。


### 主人账号配置

配置主人账号可自动绕过验证：

| 字段 | 类型 | 说明 |
|------|------|------|
| `platform` | string | 平台名称，如 `onebot` |
| `userId` | string | 用户 ID |
| `enabled` | boolean | 是否启用 |

### 群单独配置

可为每个群设置不同的验证模式：

| 字段 | 类型 | 说明 |
|------|------|------|
| `guildId` | string | 群号 |
| `enabled` | boolean | 是否启用验证 |
| `useCarbonMode` | boolean | 是否使用手性碳模式 |
| `hardMode` | boolean | 困难模式（需答出所有区域） |
| `showHint` | boolean | 是否显示提示 |

## 📝 可用命令

| 命令 | 别名 | 说明 |
|------|------|------|
| `chiral.bypass <@用户>` | 绕过验证 | 管理员绕过指定用户的验证 |
| `chiral.reverify <@用户>` | 重新验证 | 对指定用户重新发起验证 |
| `chiral.enable` | 开启验证 | 开启本群入群验证 |
| `chiral.disable` | 关闭验证 | 关闭本群入群验证 |
| `chiral.mode [carbon/math]` | 切换验证模式 | 切换验证模式 |
| `chiral.hard [true/false]` | 设置困难模式 | 设置手性碳困难模式 |
| `chiral.stats` | 验证统计 | 查看本群验证统计 |
| `chiral.config` | 验证配置 | 查看本群验证配置 |

## 🎯 工作流程

```
新成员入群
    ↓
检查是否为主人 → 是 → 跳过验证
    ↓ 否
检查群是否启用验证 → 否 → 跳过验证
    ↓ 是
尝试请求手性碳 API
    ↓
┌─ 成功 → 发送分子结构图 + 验证提示
│
└─ 失败 → 降级为数字验证（发送数学题）
    ↓
等待用户回答（打字发区域代号 / 点题目里的区域按钮）
    ↓
┌─ 答对 → 验证通过，欢迎入群
│
├─ 答错 → 减少剩余次数，提示重试（答案里混入错误区域也直接算错）
│   └─ 次数用完 → 按 failAction 处理
│
└─ 超时 → 按 failAction 处理

failAction:
  kick → 直接踢出群
  ban  → 禁言 N 分钟（banDuration），禁言结束后自动重新发送题目，可以再试一次
  none → 只提示，不做处理
```

## ✍️ 答案判定规则

- 支持 `A1,B1` / `A1 B1` / `A1、B1` / `A1A2B1`（连写）等写法
- **答案里只要出现一个错误的区域代号，立即判为本次答错**（防止「把区域全写一遍总有一个中」）
- 简单模式下答对任意一个区域即可通过；困难模式下必须答出全部区域

## 🔘 区域代号按钮（点按钮作答，只有本人点了才有反应）

QQ 平台的题目消息里，除了图之外还带一组**回调按钮**：

```
[A1] [A2] [A3] [B1] [B2]  ← 每行 5 个，共 15 个（A1–E3）
[B3] [C1] [C2] [C3] [D1]
[D2] [D3] [E1] [E2] [E3]
[✅ 提交答案] [🧹 清空]     ← 只在困难模式出现
```

- **点区域按钮就是作答**：
  - 简单模式：点哪个就按哪个判，点中就通过；
  - 困难模式：点按钮 = 选中（可多选），点「✅ 提交答案」才判定，点「🧹 清空」重选。
- **全部是回调按钮**（`action.type = 1`）：点击只把 `data` 回调给后台、触发 `INTERACTION_CREATE`，
  **不会在输入框插入 `@bot 指令`、也不会多发一条消息**，所以不存在「指令消息被自动撤回」的问题。
  按官方文档 `action.type` 是 `0 跳转 / 1 回调 / 2 指令`——不写的话 qq-crack 默认按 **2（指令）** 处理，
  这里显式写 1，并且把只对指令按钮生效的 `enter`/`reply` 关掉。
  （文档：[消息按钮](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html) ／
  [互动事件 INTERACTION_CREATE](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/interaction_create.html)）
- **只认「点按钮的那个人」**：`INTERACTION_CREATE` 事件带的是点击者自己的 openid（群聊里是 `group_member_openid`，
  适配器写进 `session.userId`，插件还会兜底读 `event.button.user_id`），插件拿这个 id 去比对当前验证会话：
  - 对上了（本人点的）→ 当作一次作答；
  - 对不上（路人、已经通过、已经超时）→ 静默忽略，**一个字都不回**；
  - 完全认不出是谁点的 → 也直接忽略。
  别人点按钮既不会替他作答，也不会让真正的验证对象通过。
- 答题结束时插件会**撤回题目消息**；答错但还有机会时**不撤回**（图还在，可以接着看）。
- 具体实现：消息里追加 `button` 元素 → 适配器编进 `keyboard` 随 markdown 下发 → 用户点击 →
  平台推 `INTERACTION_CREATE` → 适配器转成 `interaction/button` 会话 →
  `session.event.button.data` 里是 `ccv:a:B2` 这类字符串（`ccv:` 前缀用来区分别的插件的按钮）。
- 按钮代号就是 `buttonRegions` 配置（默认 **A1–E3 共 15 个**，题目图最大就到 E3），不用自己算；
  点多出来的区域算答错，漏配的格子只能手打。
- ⚠️ 需要支持 `INTERACTION_CREATE` 的适配器（`koishi-plugin-adapter-qq-crack` 这类）并在开放平台开通按钮交互权限；
  OneBot / NapCat / Satori / QQ 频道不支持这个元素，这些平台不带按钮（打字作答照常）。

## 📈 禁言时长翻倍

`failAction = ban` 时，同一个成员的禁言时长会**逐轮翻倍**：

```
第 1 次失败 → 10 分钟   (banDuration)
第 2 次失败 → 20 分钟
第 3 次失败 → 40 分钟
第 4 次失败 → 60 分钟   (到 banDurationMax 封顶)
第 5 次及以后 → 60 分钟
```

- 轮数记在数据库 `chiral_verify_records.failRounds` 里，**重启不清零**；
- 「禁言 → 自动重发题目 → 又答错」算同一波拉锯，会继续翻倍；
- 验证**通过**之后计数归零，下次（比如很久以后重新入群）又从基础时长开始；
- 关掉 `banDurationDoubling` 就是每轮固定 `banDuration` 分钟；
- 禁言时长永远不会超过 `banDurationMax`。

## 💾 状态持久化 / 重启恢复

验证状态写在数据库 `chiral_verify_records` 表里（`status = pending` + `notBefore` 等待期），
所以 **禁言等待中重启 koishi，也不会出现「这个人不用验证了」的情况**：

- 启动时（`ready` 事件）会扫描所有 `pending` 记录：
  - 还在等待期（禁言没结束）→ 恢复定时器，到点自动重发题目；
  - 已经过了等待期 → 立刻重新发题目并重新计时；
- 同一个用户只保留**一条** pending 记录（禁言 → 重发题目是原地重置，不会越攒越多）；
- 太老的记录（停机很久 / 人早走了，超过 `banDuration + verifyTimeout + 10 分钟`）直接标记 `expired`，
  **不恢复也不处罚**，避免重启后误踢老群友；
- 用户退群会立刻把 pending 记录结掉，重启时不会被重新捞出来。

> 从旧版本升级时 `chiral_verify_records` 会新增 `expiresAt` / `notBefore` 两列（sqlite 会自动补列）；
> 如果数据库驱动没自动迁移，删掉 `data/koishi.db` 重建即可（历史统计会一起清空）。

## 🧪 手性碳是什么？

**手性碳**（Chiral Carbon）是有机化学中的概念，指连接四个不同基团的碳原子。这种碳原子具有"手性"，即镜像不能重合，就像左手和右手一样。

本插件利用这一化学知识点作为入群验证，既有趣又能筛选出具有一定化学基础的成员~

## ⚠️ 注意事项

- 需要 bot 具有群管理员权限才能踢人或禁言
- QQ 平台用 markdown 发图需要 **assets 服务**（`koishi-plugin-assets-local` 等），且 `baseUrl` 必须是 QQ 能访问到的公网地址
- QQ 题目按钮需要 `qq-crack` 这类支持 `INTERACTION_CREATE` 的适配器，并在开放平台开通按钮交互权限
- 手性碳 API 默认使用 `https://carbon.crystelf.top`，可在配置中修改
- 主人账号会自动绕过验证
- 建议将 `verifyTimeout` 设置为 120 秒以上，给新成员足够的答题时间
- ⚠️ **我只测试了 [Napcat](https://napneko.github.io/)，不知道其他的 OneBot 协议端 or 其他平台能不能用（**

## 📸 效果展示

### QQ 群内使用效果
![QQ群内使用效果](doc/qq群内使用效果图捏.png)

### 开发环境信息
> 开发 & 测试时使用的 Napcat 版本等信息，供参考：

![开发环境信息](doc/开发环境使用的napcat版本等信息捏.png)

## 📜 致谢

本插件参考 [crystelf-plugin](github.com/Jerryplusy/crystelf-plugin) 的业务逻辑实现，感谢原作者的创意！

## 📄 许可证

MIT License
