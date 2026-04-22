# Qiji Pipeline 销售上手手册

> 给 Leo / Chenyu / Ethan 以及未来新人。读完 15 分钟，就能发出今天第一批邮件。
> 网址：<https://qiji-pipeline.vercel.app>

---

## 5 秒概念

这是一个帮你把 arXiv 论文作者变成奇绩潜在合作者的工具。系统每天自动扫论文 → 找作者邮箱 → 起草个性化邮件 (drafted email) → 你来 review、修改、发送。你的核心动作是 **过 leads + 点 Send**，不是从零写邮件。

---

## 第一次登录

- 打开 <https://qiji-pipeline.vercel.app/login>
- 用奇绩邮箱 (email) 和你拿到的 password 登入
- 登入后默认进 **Overview** 页（左上角能看到 "Miracle Mail" logo）
- 如果你同时帮其他 rep 看 pipeline（比如帮 Leo 处理）：
  - 左下角点你的头像 (avatar)
  - 弹出 dropdown → 选 **Add another account** 把第二个号叠加进来
  - 之后在同一个 dropdown 里点名字一键切换

🟢 建议把 Vercel 网址 pin 在浏览器 tab 上。

---

## 每天怎么用（核心 workflow）

1. 看 sidebar 里 **Pipeline** 旁边的红色数字 → 这是今天等你处理的 leads 数。0 就是今天没活了。
2. 点 **Pipeline** 进去。
3. 顶部有三个 mode 切换：**Browse** / **Review** / **Bulk** → 选 **Review**（不是 Browse！Browse 只是浏览）。
4. 进 Review 你会看到分屏：
   - **左边** = paper 信息（标题 / 摘要 / 作者 / 链接）
   - **右边** = 系统起草好的邮件 (draft email)
5. 操作：
   - 按 **J** 下一条，**K** 上一条
   - 直接 **Cmd + Enter** = 发送当前这条
   - 不想发就按 Skip / **S**
6. 如果你改过草稿再发，会弹一个 **"Why did you edit?"** 小窗 — 选个原因（比如 "tone too formal" / "wrong angle"）就行。这个数据用来训练系统下次写得更好，**不要跳过**。

🔴 不要把 Review 当成"全发"的按钮 — 一定要看一眼内容。

---

## Lead 上的每个动作

在 Review mode 里，每条 lead 你能做：

- **Send** — 直接发出去（或 Cmd+Enter）
- **Skip** — 跳过这条，不影响其他
- **Switch to first author?** — 如果当前收件人不是该联系的人（比如该找一作而不是通讯作者），点这个换人
- **🚩 Flag** — 标记这条 lead 有问题，下拉里选原因：
  - "Email 写得不好" → 反馈给 email-quality scorer
  - "作者搞错了" → 修正 author 标注
  - "不该需要算力（直觉）" → 你的判断会被记录，但不直接喂训练
  - **🚫 Don't send to this person**（仅 senior / admin 可见）→ 把这个邮箱永久加进 blocklist
- **Override 7d gate** — 论文 < 7 天的默认锁住不让发；admin / senior 才能 override。普通 sales 看到锁就是该等。

---

## Brief 页面（你的"开口神器"）

对方在微信回复了，或者你想主动加人聊，就用 **Brief**：

- sidebar 点 **Brief**
- 搜作者名 / 邮箱 / paper 标题
- 出来的 **Sales Brief** 包括：
  - paper 简介
  - 主要想法 / 核心创新
  - 你可以聊的技术问题（开口话题）
  - 怎么切入（建议开场）
- 顶部有 **persuasion angle** 提示（**ethos** / **logos** / **pathos**）→ 告诉你这人吃哪一套：
  - ethos = 强调奇绩 credentials
  - logos = 摆数据 / 资源
  - pathos = 共情他们的研究愿景
- 加完微信后 → 点右上角 **Mark: Added on WeChat** 按钮（这一条很重要，进 conversion tracking）
- 右下角浮动的 ✨ 按钮 = **Sales Copilot** — 临场不知道怎么回，问它就行

---

## 键盘快捷键

| 按键 | 动作 |
|---|---|
| **J** | 下一条 lead |
| **K** | 上一条 lead |
| **Cmd + Enter** | 发送当前 draft |
| **S** | Skip 当前 lead |
| **F** | 打开 Flag 菜单 |
| **Esc** | 关闭弹窗 / 取消 |
| **/** | 聚焦搜索框（Brief 页） |

🟢 把 J / K / Cmd+Enter 三个练熟，速度直接翻倍。

---

## 常见问答

- **看不到任何 leads？**
  - 看 sidebar 顶部 **Pipeline** 旁边的数字。是 0 就真的没活。
  - 检查你在 **Review** mode 而不是 Browse；Browse 默认只看 arXiv 子集。
  - 检查页面顶部的 rep 筛选 pill — 别只看了别人的 leads。
- **发送失败提示 "blocked"？**
  - 这个收件人在 blocklist。普通 sales 解不了，找 admin (Xingze)。
- **"Ready to send 0 / 200" 是什么意思？**
  - 200 条总量，0 条能发 — 大部分卡在 7 天 cooldown。要么等，要么找 senior override。
- **怎么换账号？**
  - 左下角头像 → dropdown → 点目标账号 / Add another account。
- **我标错了（误 Flag、误 Block）？**
  - 找 admin (Xingze)，他能撤回。不要重复 Flag 想"覆盖"。
- **我看到 Settings / Scorer / Drift / Logs？**
  - 那是 admin 视图。普通 sales 不用管，看到也不影响。

---

## 沟通公约

- **永远不要 over-promise** — 只承诺奇绩 program 真的能给的东西（资源 / 算力 / mentor / 资金 ranges）。不确定就说"我回去确认"。
- 对方明确说不感兴趣 / 反感 → 立刻 **🚩 Flag → Don't send**（或找 senior 帮加 block），别再发第二封。
- **重大事件**（投诉、法律风险措辞、误发给 portfolio 公司、media 关注）→ 第一时间微信找 Xingze，不要自己处理。
- 微信加上后务必点 **Mark: Added on WeChat** — 没 mark 等于这一单"消失"，影响你的 conversion 数据。

---

有任何 UI 看不懂的，截图扔群里 @Xingze。Happy sending. 🚀
