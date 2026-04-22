// Inlined sales guide so the help-bot endpoint never reads the filesystem.
// Keep in sync with /docs/sales-guide.md when that doc changes.

export const SALES_GUIDE = `# Qiji Pipeline 销售上手手册

## 5 秒概念
帮你把 arXiv 论文作者变成奇绩潜在合作者的工具。系统每天自动扫论文 → 找作者邮箱 → 起草个性化邮件 → 你 review、修改、发送。核心动作 = 过 leads + 点 Send，不是从零写邮件。

## 第一次登录
- URL: https://qiji-pipeline.vercel.app/login
- 用奇绩邮箱 + 拿到的 password
- 默认进 Overview 页
- 多账号: 左下角头像 dropdown → Add another account, 切换在同一个 dropdown

## 每天 workflow
1. sidebar 里 Pipeline 旁的红色数字 = 等你处理的 leads
2. 点 Pipeline 进去
3. 顶部三个 mode: Browse / Review / Bulk → 选 Review
4. 分屏: 左 paper 信息, 右 邮件 draft
5. 操作: J 下一条 / K 上一条 / Cmd+Enter 发送 / S 跳过
6. 改过 draft 再发 → 弹"Why did you edit?" — 选原因别跳过

## Lead 上每个动作
- Send: 直接发
- Skip: 跳过
- Switch to first author?: 换收件人（不该联系当前这位时）
- 🚩 Flag: 标记问题
  * "Email 写得不好" → email-quality scorer
  * "作者搞错了" → 修 author 标
  * "不该需要算力（直觉）" → 记录但不直接喂训练
  * 🚫 "Don't send to this person" (仅 senior/admin) → 永久 blocklist
- Override 7d gate: 论文 < 7 天默认锁住; senior/admin 才能 override

## Brief 页面
- sidebar → Brief → 搜作者名/邮箱/标题
- Sales Brief 包含: paper / 主要想法 / 核心创新 / 可以聊的技术问题 / 怎么切入
- 顶部有 persuasion angle (ethos/logos/pathos) 提示
- 加完微信 → 点 Mark: Added on WeChat (不点等于这单消失)
- 右下浮动 ✨ = Sales Copilot 临场答疑

## 键盘快捷键
J=下一条, K=上一条, Cmd+Enter=发送, S=Skip, F=Flag, Esc=关闭, /=聚焦搜索

## 常见 UI 问题
- 看不到 leads → 检查 sidebar Pipeline 数字; 检查在 Review mode; 检查顶部 rep filter
- "blocked" 错误 → 收件人在 blocklist, 找 admin
- "Ready 0/200" → 200 总量, 0 能发, 大部分卡 7d cooldown
- 换账号 → 左下头像 dropdown
- 标错了 → 找 admin 撤回, 不要重复 Flag
- Settings/Scorer/Drift/Logs → admin 视图, 普通 sales 不用管

## 沟通公约
- 永远不 over-promise — 只承诺 program facts
- 对方明确说不感兴趣 → 立刻 Flag → Don't send
- 重大事件（投诉/法律风险/portfolio 误发）→ 第一时间找 Xingze
- 微信加上后必须点 Mark: Added on WeChat（影响你的 conversion 数据）
`;
