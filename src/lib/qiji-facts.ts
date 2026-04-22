// Static knowledge base about 奇绩算力计划 — used by /api/brief/ask to ground
// the LLM's answers. Update this file when program terms change; no DB needed.
//
// Pattern is inline-RAG: we always ship the WHOLE corpus to the model (it's
// short, and a vector DB is overkill at this size). When the corpus grows
// past ~3-5 KB, switch to per-section retrieval.

export const QIJI_PROGRAM_FACTS = `# 奇绩算力计划 (Qiji Compute Program) — 销售须知

## 核心数字
- **单项目最高额度**: 100 万元等值算力（约 8 卡 H100 连续跑 15 个月）
- **通过率**: 约 1.5%（审核严格）
- **费用**: 完全免费
- **不占股**: 不要求股权
- **不要求署名**: 不要求 paper 致谢

## 申请流程
- 在线申请表（链接在邮件里，also https://compute.miracleplus.com/apply）
- 通常 2 周内出结果
- 通过后由对应行业方向的 mentor 跟进
- 每月可以 review 用量、申请扩容

## 我们支持过的方向（70+ 项目）
- 多模态/视觉生成: 4D 重建生成、3D 资产/视频生成、多模态世界模型、低显存实时 3D 重建
- 具身智能/机器人: 具身导航感知、多模态具身大模型、模块化力控、场景孪生仿真、世界模型+VLA、长程灵巧操作、具身 3D 空间理解
- LLM/Agent: Agentic RL、Web Agent、长上下文推理、稀疏 MoE、记忆驱动 Agent
- AI4S: 蛋白质设计、材料发现、贝叶斯主动学习
- 持续学习、可解释性、Offline RL

## 来自的学校（部分）
MIT、Stanford、CMU、Berkeley、Princeton、Caltech、UW、UMich、Columbia、UChicago、Cambridge、Oxford、ETH、EPFL、HKU、HKUST、NUS、NTU、清华、北大、复旦、上交、浙大、南大、中科大、中科院、HIT、BIT、BJU、Fudan、Tsinghua-Berkeley、SUSTech 等

## 常见问题及标准答复
Q: 你们和云厂商代金券有什么不同？
A: 我们更针对 frontier 研究场景，包括对 8x H100 这种紧缺机型的承诺、长时间连续运行的能力、专门的 mentor 跟进。云代金券通常 quota 限制更严，且不针对前沿方法做适配。

Q: 我可以拿这笔算力做哪些限制？
A: 不限制具体研究方向，只要符合「前沿、有创新性」。不能用于挖矿/纯商业产品训练。

Q: 论文必须发在哪些会议吗？
A: 不要求。我们看研究本身的创新性，不限定会议。

Q: 这个算力可以共享给我组里的学弟学妹吗？
A: 一般不行 — 申请是 per-PI / per-project 维度的。可以让学弟学妹另外申请。

Q: 拿这个会不会影响我现有的 funding（NSF、industry grant 等）？
A: 不会。我们是纯算力赞助，不替代任何 funding，也不做 IP claim。

Q: 我现在还没发表过 paper，可以申请吗？
A: 可以。我们看 idea 和 progress，不只看已发表 paper。如果有 preprint / Github 项目就更好。

## 销售应对原则
1. 永远先认真听对方说研究/瓶颈/想法。不要一上来就推销算力。
2. 提到我们时用「奇绩」或「Miracle Plus」，不要说「我们公司」。
3. 不要承诺超出上面写明的内容（例如不要说「100 万一定批」）。
4. 如果对方问的问题超出你能力范围，明确说「这个我帮你转给我们的 mentor team 详细回答」，不要瞎编。
5. 对资深 PI：用 ethos（背书+portfolio）。
   对年轻 PhD：用 pathos（认可工作 + enable 你做更大的事）。
   对 industry researcher：用 logos（具体数字 + ROI）。
`;
