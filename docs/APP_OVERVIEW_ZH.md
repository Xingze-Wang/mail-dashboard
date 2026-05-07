# Qiji Pipeline（奇绩算力）— 应用全景

## 1. 产品定位

**Qiji Pipeline** 是奇绩创坛内部为 **AI 研究者提供免费 GPU 算力资助** 的自动化外联系统，部署在 `qiji-pipeline.vercel.app`。

### 目标用户与工作流
- **目标用户**：从 arXiv、GitHub、HuggingFace 等渠道发现的 AI 研究者（国内外学生、博士后、青年教授）
- **销售团队**：3 名 sales reps（Leo、Yujie、Ethan）通过该平台管理 lead 和外联过程
- **日常工作流**：
  1. **发现** — 每个工作日自动从 arXiv 扫描新论文、识别作者
  2. **富化** — 从 Semantic Scholar 抓取 h-index、引用数、验证学校 tier
  3. **分类 → 分配** — 根据论文方向、学校 tier、引用数将 lead 分配给对应 rep
  4. **生成草稿** — LLM 根据研究背景生成个性化邮件草稿
  5. **发送** — Sales rep 审查、编辑草稿后通过 Resend 批量发送
  6. **追踪** — Webhook 实时监控邮件送达、打开、点击；微信转化在 brief_lookups 表归因

---

## 2. Lead 发现→外联管道

### 2.1 Lead 来源

**主入口：arXiv 自动化扫描**
- **路由**：`POST /api/pipeline/scan` （由 cron job 每天触发）
- **实现**：`/src/lib/scanner.ts` 
- 扫描 arXiv 最近 1-2 天的论文，筛选关键词（LLM、生成、具身智能等），提取作者邮箱
- 输出：`ScannedLead` 对象数组（作者名、邮箱、论文 ID、计算力标签）

**可选入口：手动导入 / 其他源**
- `POST /api/pipeline/import` — 支持 CSV/JSON 批量导入（需 PIPELINE_IMPORT_KEY 鉴权）
- HuggingFace、Product Hunt、GitHub profiles 等可通过后续扩展接入

### 2.2 Lead 富化

扫描完成后的 enrichment 步骤（`/src/app/api/cron/route.ts` 第 60-71 行）：

| 字段 | 来源 | 目的 |
|------|------|------|
| `h_index`, `citation_count`, `paper_count` | Semantic Scholar API 查询 | 学术影响力评分 |
| `school_name`, `school_tier` | 邮箱域名反查 + 预置学校 tier 表 | 顶级大学识别 |
| `compute_level`, `compute_reason` | LLM 分析摘要 | 研究是否需要大算力 |
| `matched_directions` | 关键词匹配 + 分类 | 对标奇绩支持的技术方向（LLM 微调、具身智能、4D 重建等） |

**表结构**：`pipeline_leads` 
- 核心字段：`author_email`, `author_name`, `first_name`, `school_tier`, `h_index`, `citation_count`
- 状态字段：`status` (new → ready → sent → replied / wechat_added)
- 富化字段：`compute_level`, `compute_confidence`, `matched_directions`

### 2.3 Lead 分类

**分类逻辑**（`/src/lib/assignment.ts`，绑定业务规则）

Lead 分为 **Strong** 和 **Normal** 两个 tier：

```
Strong 条件（满足其一即可）:
  - schoolTier ∈ [1, max_school_tier]（顶级大学）
  - citationCount > min_citation && schoolTier verified（高影响力 + 名校）
  - citationCount > min_citation_unverified（特别高影响力）

Normal: 其他所有情况
```

**默认配置**（`/src/lib/assignment.ts` line 89-103）：
- min_citation = 5000
- min_citation_unverified = 5000
- max_school_tier = 2（Tier 1-2 学校）
- min_local_score = 0.85（转化模型评分阈值）

### 2.4 Lead 路由（分配给 Rep）

**分配规则**（优先级顺序，先匹配的生效）：

1. **Strong** → Leo（ID=1）
2. **Normal** + 论文方向有配置 → 对应方向 rep（如 4D 重建、具身智能等方向都指向 Leo）
3. **Normal** + 海外（邮箱非 .cn）→ Ethan（ID=3）
4. **Normal** + 国内（邮箱 .cn）→ Yujie（ID=2）

**实现**：
- 配置存储在 `system_config` 表，key = "lead_assignment"
- `POST /api/config/assignment` — Admin 可修改规则
- `GET /api/config/assignment` — 查看当前活跃配置

### 2.5 草稿生成 & 发送

**草稿生成**（`/src/lib/email-generator.ts`）
- LLM（Claude Opus 或 Gemini）根据论文摘要、作者背景生成个性化邮件
- 包含 rep 身份信息（sender_name, wechat_id）
- 输出：`draft_subject`, `draft_html` → 存储到 `pipeline_leads.draft_*`

**发送流程**：
- `POST /api/pipeline/send` — Rep 点击"发送"按钮
- 调用 Resend 邮件服务 → 得到 `resend_id`
- 状态变更：ready → sent，记录 `sent_at` 时间戳
- **重要**：如果邮件被编辑过，会额外记录 `draft_original_html`（AI 版本）和 `draft_edit_distance`（编辑程度）

### 2.6 Webhook & 追踪

**Resend 集成**（`/src/lib/resend.ts`、`/src/app/api/webhook/route.ts`）
- Resend 在邮件送达、打开、点击时发送 webhook 事件
- 事件规范化存储到 `webhook_events` 表（保留完整历史）
- `emails` 表的 `status` 字段记录"最新事件"（sent → delivered → clicked 等）
- 区别：`webhook_events` 是规范化历史 vs `emails.status` 是最新事件覆盖语义

---

## 3. 微信转化闭环 & 归因模型

### 3.1 Brief Panel（/emails 页面）

`/src/app/emails/page.tsx` 展示每封邮件的详情面板，包含：
- 论文基本信息（标题、作者、摘要、PDF 链接）
- 计算力评估（需要多少 GPU、理由）
- 外联状态（邮件状态、发送时间）
- **微信转化操作**：点击"Added on WeChat"按钮

### 3.2 brief_lookups 表 & 转化事件

**表结构**（`/src/app/api/setup/route.ts` line 129-141）：

```sql
brief_lookups:
  id (PK)
  query (text) — 查询词（研究者名字）
  arxiv_id (text) — 可选，关联论文
  lead_id (text) — 可选，关联 pipeline_leads 中的 lead
  added_wechat (boolean) — 是否标记为微信转化
  wechat_at (timestamptz) — 转化时间
  notes (text) — 备注
  marked_by_rep_id (int) — **关键：标记这个转化的 rep ID**（不是 lead 的所有者）
  marked_by_email (text) — 标记人的邮箱
  created_at (timestamptz)
```

### 3.3 **关键：Attribution 模型（按点击人计数）**

**重要原则**：微信转化统计按 **标记者（clicked rep）** 计数，而非 lead 的所有者。

**例子**：
- Lead A 分配给 Leo（assigned_rep_id=1）
- Yujie 在 /emails 页面看到这条邮件、发现对方已加微信、点击"Added on WeChat"
- 统计：Yujie 获得 1 个 WeChat 转化（不是 Leo）

**实现**（`/src/app/api/metrics/me/route.ts`）：
```typescript
// 按 marked_by_rep_id 分组，而非 assigned_rep_id
const { data: convRows } = await supabase
  .from("brief_lookups")
  .select("lead_id")
  .eq("added_wechat", true)
  .eq("marked_by_rep_id", repId)  // 关键：按标记人计数
```

**迁移历史**：
- 旧模型：按 lead 的 assigned_rep_id 计数（bug：Leo 因为拥有很多历史 lead，看起来有很多微信转化）
- 新模型（migration 012+）：按 `marked_by_rep_id` 计数
- 预迁移数据（marked_by_rep_id=null）：不计入任何 rep 的统计

---

## 4. Helper Bot（销售 AI 助手）

### 4.1 功能定位

`/src/app/api/help/ask` — 面向 sales reps 的聊天机器人，充当"同事"而非客服。

**设计哲学**："先给数据再说结论" — 所有数字声明都需要证据块支撑

### 4.2 能力

**Read-Only 工具**（自动执行，无需确认）：
- `get_my_stats` — 查询 rep 自己的 pipeline 统计（assigned、ready、sent、wechat）
- Lead 查询 — 按 id / email / 关键词查询
- 模式查询 — 查看从 drift mining 提取的最新说话模式

**Action 工具**（需用户确认）：
- `redraft_lead` — 重新生成某个 lead 的邮件草稿
- `skip_lead` — 标记 lead 为 skipped
- `reassign_lead` — 手动改变 lead 的所有者

### 4.3 Context 感知

Bot 自动根据场景判断走哪条路线，无需用户多说：
- 如果在 Review 模式 + 问题关于当前 paper → 解释论文本身
- 问题是操作指令（"发这个"、"skip 这条"）→ 先查询确定 lead，再执行
- 问题是数字（"还能发几个"）→ 必须先 lookup 获取实时数据
- 问题模糊 → 用一句反问，不要猜测

### 4.4 实现

- **系统提示**：`SYSTEM_BASE` 定义语气规则（中文为主、数据第一、不用 emoji）
- **供应侧**：QIJI_PROGRAM_FACTS、SALES_GUIDE 预置知识库
- **Agent 循环**：最多 3 轮 LLM 往返，每轮可自动执行 lookup 工具

---

## 5. Drift Mining & Prompt Pattern 提取

### 5.1 概念

**Drift** = Sales rep 对 AI 生成的邮件草稿的编辑。通过分析这些编辑，我们可以提取 rep 的写邮件"风格"，用来改进 LLM 生成。

### 5.2 Drift Mining 流程

**入口**：`/src/app/api/drift/mine/route.ts`

1. **抓取**：查询最近 N 天（默认 30 天）status='sent' 且 `draft_original_html` 非空的 lead
   - 仅包含被编辑过的邮件（`draft_edit_distance > 0`）
   - 上限 120 条（可配），以保证 cron 时间预算

2. **对比**：
   - 原版（AI）：`draft_original_html`（Gemini/Claude 生成）
   - 修订版（Sales）：`draft_html`（rep 编辑后的版本）
   - 原因字段：`edit_reasons`（rep 选择的编辑理由标签）

3. **LLM 提取**：
   - 系统提示 MINER_SYSTEM 指导 Claude/Gemini 识别模式
   - 输入：JSON 数组，每个元素包含 id、ai 版本、sales 版本、选中的理由
   - 输出：JSON 格式的 pattern 列表

4. **存储**：
   - `prompt_drift_patterns` 表（admin 审核 & 手工验证）
   - `POST /api/drift/patterns/[id]/` — Admin 可接受/拒绝单个 pattern

### 5.3 日常运行

- **Cron 触发**：每个工作日，`GET /api/cron` step 3 调用 `runDriftMine(60, 30)`
- **手动审核**：`/drift` 页面展示最新 patterns，admin 人工确认优质 pattern
- **反馈闭环**：确认的 pattern 更新 `prompt_drift_patterns` 状态为 "approved"

---

## 6. Scorer / 转化模型

### 6.1 local_score 字段

`pipeline_leads.local_score`（0-1 范围）= LLM 对每个 lead 的初步评分。

**计算方式**：
- 实现：`/src/lib/gemini-scorer.ts`
- 输入：论文摘要、方向、作者背景
- 输出：0-1 之间的连续评分（是否值得外联）

### 6.2 转化预测模型（Logistic Regression）

**目标**：根据 lead 特征预测是否会转化（点击 OR 微信添加）

**特征向量**（10 维）：

```
[0] local_score — AI 初步评分（null → 0.5）
[1] log1p(citation_count) / 10 — 归一化的引用数（null → 0）
[2-4] school_tier_1, school_tier_2, school_tier_3 — One-hot 学校层级
[5] is_overseas — 1 if email not .cn, else 0
[6] is_strong_tier — 1 if lead_tier='strong', else 0
[7-9] rep_leo, rep_yujie (历史名 rep_chenyu, scorer 特征键未变), rep_ethan — One-hot rep 分配
```

**训练数据**（双目标，样本加权）：
- 正样本（y=1）：
  - 微信添加（marked_by_rep_id 非空 + added_wechat=true）→ **权重 4.0**
  - 邮件点击 → **权重 1.0**
- 负样本（y=0）：已发送但无反应 → **权重 1.0**

**权重原理**：微信 ~6 个，点击 ~30 个 → 权重 4:1 以平衡高价值信号

**实现**：
- `POST /api/scorer/conversion-model` — 重新训练
- `GET /api/scorer/conversion-model` — 查看当前活跃模型 + 拟合统计（F1、AUC）
- `GET /api/scorer/live` — 实时对单个 lead 评分

**Dashboard**：
- `/scorer` 页面 — 可视化训练历史、特征重要性、混淆矩阵
- `/analysis` 页面 — 按 tier / rep / direction 分层的转化率分析

---

## 7. 认证模型 & 会话管理

### 7.1 Session 设计

**JWT Cookie** （30 天有效期）：
- `AUTH_COOKIE` = 密钥 JWT，包含 `repId`, `repName`, `email`, `role`
- 签名算法：HMAC-SHA256（`jose` 库）

**Pool Cookie 支持**：
- 允许一个用户同时登入多个 rep 账号
- `POST /api/auth/switch` — 在已登录的多个账号间切换
- `GET /api/auth/accounts` — 列出当前登录的所有账号

### 7.2 **关键：Role 动态读取**

**原则**：JWT 中的 role 字段 **永远不信任**，每次请求都从 DB 重读。

**理由**：
- 如果 rep 被降级（admin → sales），JWT 可能还是 30 天前的 admin token
- 信任 JWT 会导致被降级的 rep 仍能访问所有 lead 数据（安全漏洞）

**实现**（`/src/lib/auth-helpers.ts`）：
```typescript
export async function requireSession(req: NextRequest): Promise<SessionPayload | null> {
  const jwt = await verifySession(req.cookies.get(AUTH_COOKIE)?.value);
  
  // 重读 DB 中的当前 role + active 状态
  const { data: rep } = await supabase
    .from("sales_reps")
    .select("role, active")
    .eq("id", jwt.repId)
    .maybeSingle();
  
  // role 失败 = 降级立即生效
  return { ...jwt, role: rep.role };
}
```

### 7.3 sales_reps 表

```sql
sales_reps:
  id (serial PK)
  name (text) — rep 显示名
  sender_email (text) — 邮箱账号（用于 Resend 发送 from）
  sender_name (text) — 邮件签名名（如"Leo from Qiji"）
  wechat_id (text) — 微信 ID
  active (boolean) — 是否还在团队中
  created_at
```

**注意**：有 `name` 和 `sender_name` 两个不同字段
- `name` — 系统内名字（用于日志、分配规则）
- `sender_name` — 邮件签名名（对外呈现）

---

## 8. Cron 定时任务

**触发**：每个工作日上午 6 点 UTC，由 Vercel Cron 或外部调度器触发

**入口**：`GET /api/cron` （需 CRON_SECRET Bearer 令牌鉴权）

**步骤流程**（串行）：

### Step 1: Resend 同步
```
syncFromResend(10_000 ms)
  ↓
读取 Resend API 中所有邮件事件，更新 webhook_events + emails.status
结果：sent → delivered → clicked 等事件同步到本地
```

### Step 2: arXiv 扫描 & 全流程处理
```
scanArxiv({ maxPapers: 300, timeBudgetMs: 40_000 })
  ↓
For each lead:
  1. Semantic Scholar enrichment （best-effort，失败非阻断）
  2. Classify tier（strong/normal）
  3. Assign rep
  4. Generate draft
  5. Insert into pipeline_leads
结果：leadsCreated 数量
```

### Step 3: Drift Mining
```
runDriftMine(60, 30)
  ↓
提取最近 30 天内最多 60 条已编辑的邮件，识别模式
结果：pattern 列表待 admin 审核
```

### Step 4: Retrain 信号
```
emitRetrainSignals() + buildProposal()
  ↓
检查是否积累了足够的新转化信号（点击、微信）
如果满足阈值，生成重训练提案供 admin 审核
```

**时间预算**：总计 < 300s（Vercel Pro 限制）

---

## 9. 数据模型核心要点

### 9.1 主要表

| 表名 | 用途 | 关键字段 |
|------|------|---------|
| `pipeline_leads` | Lead 数据中心 | id, arxiv_id, author_email, status, assigned_rep_id, local_score, lead_tier |
| `emails` | 发出的邮件 | id, from, to, subject, status, resend_id, thread_id |
| `brief_lookups` | 微信转化事件 | id, query, lead_id, added_wechat, marked_by_rep_id |
| `webhook_events` | 规范化事件历史 | id, email_id, type (email.sent/delivered/clicked/etc), payload, created_at |
| `sales_reps` | 销售团队 | id, name, sender_email, sender_name, wechat_id, active |
| `system_config` | 配置存储 | key, value (JSON) |
| `scorer_runs` | 模型训练记录 | id, n_samples, cv_f1, cv_auc, trained_at |
| `prompt_drift_patterns` | 提取的编辑模式 | id, pattern_text, status (pending/approved) |

### 9.2 Status 字段语义

**pipeline_leads.status**：
- `new` — 刚导入，未生成草稿
- `ready` — 草稿已生成，等待发送
- `sent` — 已发送
- `replied` — 收到回复邮件
- `wechat_added` — 微信已添加（legacy 字段，新模式用 brief_lookups）
- `skipped` — 人工跳过

**emails.status**：
- `queued` — 待 Resend 发送
- `sent` — Resend 确认已发出
- `delivered` — 邮件已到达
- `opened` — 收件人打开
- `clicked` — 收件人点击链接
- `bounced` — 弹回
- `complained` — 标记为垃圾邮件

### 9.3 **关键区别：webhook_events vs emails.status**

- **webhook_events**：规范化的事件流，每个事件一行，完整历史 + 完整 payload
- **emails.status**：最新事件的"覆盖"语义
  - 如果收到 clicked 事件，status 从 delivered 变为 clicked
  - 历史上经历过的状态（sent → delivered）不再可见

**应用场景**：
- 需要完整事件链（"邮件何时打开"）→ 查 webhook_events
- 需要当前最新状态（"这个人有反应吗"）→ 查 emails.status

---

## 10. 文件架构速览

### API 路由
```
/src/app/api/
  ├─ auth/              — 认证 & 会话
  ├─ pipeline/          — Lead 管理中心
  │  ├─ route.ts        — 列表、筛选、分页
  │  ├─ send/route.ts   — 批量发送
  │  ├─ scan/route.ts   — arXiv 扫描触发
  │  ├─ import/route.ts — 批量导入
  │  └─ draft-queue/    — 待发邮件队列
  ├─ emails/            — 邮件管理（Resend 集成）
  ├─ brief/             — 微信转化 & 邮件详情
  │  ├─ ask/route.ts    — Brief 的 AI 总结
  │  ├─ wechat/route.ts — 标记微信添加
  │  └─ summary/        — 论文摘要生成
  ├─ drift/             — 模式挖掘
  │  └─ mine/route.ts   — 运行 drift miner
  ├─ scorer/            — 转化模型
  │  ├─ conversion-model/ — LR 训练 & 推理
  │  └─ live/           — 实时评分 API
  ├─ help/              — Helper bot
  │  └─ ask/route.ts    — Agent 循环
  ├─ metrics/           — 统计仪表板
  ├─ cron/route.ts      — 日常定时任务
  └─ webhook/           — Resend webhook 收收器
    └─ [provider]/      — 邮件事件处理

/src/lib/
  ├─ scanner.ts         — arXiv 扫描 + Gemini 分类
  ├─ assignment.ts      — Lead 分类 & 路由逻辑
  ├─ email-generator.ts — LLM 草稿生成
  ├─ semantic-scholar.ts — 学者数据富化
  ├─ resend.ts          — Resend 集成
  ├─ logistic.ts        — LR 模型训练
  ├─ patterns.ts        — Drift pattern 管理
  ├─ helper-*.ts        — Bot 工具 & 只读操作
  ├─ auth-helpers.ts    — Session & 权限检查
  └─ db.ts              — Supabase 初始化

/src/app/
  ├─ (auth)/login       — 登录页
  ├─ page.tsx           — 仪表板首页
  ├─ pipeline/page.tsx  — Lead 列表 + Review
  ├─ emails/page.tsx    — 邮件 + Brief 面板
  ├─ drift/page.tsx     — Pattern 审核
  ├─ scorer/page.tsx    — 模型 & 转化可视化
  ├─ analysis/page.tsx  — 分层转化率分析
  └─ inbox/page.tsx     — 入站邮件
```

---

## 11. 快速查询表

| 功能 | API 路由 | 表名 | 数据模型 |
|------|---------|------|---------|
| Lead 列表 & 筛选 | `GET /api/pipeline` | pipeline_leads | PipelineLeadDTO |
| 发送邮件 | `POST /api/pipeline/send` | emails, pipeline_leads | — |
| 微信转化 | `POST /api/brief/wechat` | brief_lookups | — |
| Webhook 事件 | `POST /api/inbound` | webhook_events | — |
| 转化模型 | `GET /api/scorer/conversion-model` | scorer_runs | LRModel |
| Drift 挖掘 | `GET /api/drift/mine` (admin) | prompt_drift_patterns | Pattern[] |
| 分配规则 | `GET /api/config/assignment` | system_config | AssignmentConfig |
| 统计数据 | `GET /api/metrics` (global) / `GET /api/metrics/me` (per-rep) | pipeline_leads, brief_lookups, emails | — |
| Helper bot | `POST /api/help/ask` | — | — |

---

## 12. 常见操作场景

### Rep 在 /pipeline 页面 Review lead
```
GET /api/pipeline?page=1&limit=50&status=ready&rep_id=2
  → 返回 Yujie 待发的 lead 列表
  → Rep 选择一条，UI 加载 /emails/[id] 展示详情
```

### Rep 编辑并发送邮件
```
PUT /api/pipeline/[lead_id] — 更新 draft_html
POST /api/pipeline/send — 批量发送（状态变为 sent）
  → Resend 返回 resend_id
  → 邮件事件异步到达 /api/webhook/resend → 更新 webhook_events
```

### Rep 在 /emails 页面发现已加微信，点击按钮转化
```
POST /api/brief/wechat { query, lead_id, notes? }
  → inserted: brief_lookups { marked_by_rep_id: session.repId, ... }
  → 点击人（rep）的 WeChat 计数 +1
```

### Admin 查看每日 cron 结果
```
GET /api/cron （CRON_SECRET bearer token）
  → 返回 { sync, pipeline, drift, retrain } 各步骤的结果
```

### Admin 审核 drift pattern
```
GET /api/drift/patterns
  → 列出待审批的 pattern
POST /api/drift/patterns/[id] { status: "approved" }
  → 确认为优质模式，下次 retraining 可用
```

---

## 13. 部署 & 环境变量

**部署地址**：https://qiji-pipeline.vercel.app

**关键环境变量**：
- `SUPABASE_URL` / `SUPABASE_KEY` — 数据库连接
- `RESEND_API_KEY` — 邮件服务
- `CRON_SECRET` — Cron 任务鉴权
- `PIPELINE_IMPORT_KEY` — 批量导入 API 密钥
- `AUTH_SECRET` — JWT 签名密钥
- LLM API 密钥（Gemini、Claude、Anthropic）

**数据库**：PostgreSQL（Supabase）

---

## 14. 设计亮点

1. **数据驱动归因** — 微信转化按操作人（marked_by_rep_id）而非 lead 所有者，精确衡量个人贡献
2. **动态权限检查** — 每次请求都从 DB 读 role，被降级立即生效，安全且实时
3. **样本加权训练** — 微信（稀有、高价值）与点击（高频、弱信号）混合训练，平衡数据不均
4. **事件流 vs 状态** — webhook_events 保留完整历史，emails.status 提供快速查询，满足两类需求
5. **Drift mining + pattern** — 从真实销售编辑中提取写邮件的套路，直接用于 LLM 微调
6. **Helper bot 反驳机制** — Bot 基于数据敢于反驳 rep 说法，增强 trust & learning

---

## 15. 后续扩展

- [ ] GitHub 初创公司 finder（扫描 GitHub trending / 创业公司职招页）
- [ ] Jike 创始人/投资人扫描
- [ ] 多语言邮件生成（目前仅中英）
- [ ] 更多 discovery 源整合（LinkedIn、Twitter 等）
- [ ] Lead 反馈闭环（"这条 lead 质量差"）用于模型改进

