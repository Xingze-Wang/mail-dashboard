export const RESEARCH_CATEGORIES = [
  "具身智能/机器人",
  "多模态/视觉生成",
  "Agent/自动化",
  "推理/架构优化",
  "AI安全",
  "语音/音频",
  "科学计算/生物",
  "推理/符号",
  "其他",
] as const;

export type ResearchCategory = (typeof RESEARCH_CATEGORIES)[number];

export const SUPPORTED_DIRECTIONS_MAP: Record<ResearchCategory, string[]> = {
  "具身智能/机器人": [
    "具身导航感知", "多模态具身大模型", "模块化力控关节",
    "场景孪生仿真", "工业具身模仿学习", "自动驾驶",
    "世界模型+VLA", "连续体机械臂", "端侧机器人推理",
    "视频策略表征", "1 bit 量化VLA模型",
    "长程灵巧操作", "具身3D空间理解",
    "化工精密操作机器人", "实验室语音交互机器人",
    "多模态无人机交互", "农业场景具身模型",
  ],
  "多模态/视觉生成": [
    "笔触引导生成", "动漫视频生成", "4D重建生成", "3D资产生成",
    "3D视频生成", "视觉自回归模型", "端到端像素生成", "多阶段视频生成",
    "多模态世界模型", "长上下文多模态模型", "能量模型图像生成", "低显存实时3D重建",
    "通用世界模拟模型", "沉浸式场景生成模型", "潜空间图像编码",
  ],
  "Agent/自动化": [
    "长程推理引擎", "Agent操作系统", "Agentic Browser",
    "Coding Agent", "端云协同Agent", "GUI Agent RL",
    "AI4S Agent", "AI原生操作系统", "AI SaaS全栈开发",
    "多模态情绪模型",
  ],
  "推理/架构优化": [
    "分布式推理架构", "稀疏注意力", "推理框架（MoonCake等）", "跨模态推理架构",
    "隐空间推理", "推理加速框架", "硬件感知优化", "量子启发压缩",
    "增强模型泛化能力的SFT相关研究", "语言模型", "高效训练推理框架（Mooncake等）",
    "LLM生成-评测对齐", "类脑AI端侧处理",
  ],
  "AI安全": ["多模态内容解析", "AI Hacker"],
  "语音/音频": ["实时AI变声", "AI Native视频压缩算法"],
  "科学计算/生物": [
    "细胞分析算法", "蛋白功能大模型", "原子级材料模型", "物理偏置分子建模",
    "高频波函数求解", "基于机器学习的物理仿真", "化学材料大模型",
    "电镜数据分析模型", "多肽药物发现", "几何深度学习",
    "RNA药物智能设计", "AI免疫编程", "量子纠错混合训练",
    "量子硬件神经网络纠错",
  ],
  "推理/符号": [
    "神经符号大模型", "数学推理模型", "金融大模型", "非欧空间表征模型",
    "表格结构化基础模型",
  ],
  "其他": ["工业设计Agent", "段级强化学习", "RL动态重排序"],
};

const SUB_TO_CATEGORY: Record<string, ResearchCategory> = (() => {
  const map: Record<string, ResearchCategory> = {};
  for (const [category, subs] of Object.entries(SUPPORTED_DIRECTIONS_MAP) as [ResearchCategory, string[]][]) {
    for (const sub of subs) map[sub] = category;
  }
  return map;
})();

export function getLeadCategories(matchedDirections: string | null): ResearchCategory[] {
  if (!matchedDirections) return [];
  const categories = new Set<ResearchCategory>();
  for (const sub of matchedDirections.split(",")) {
    const cat = SUB_TO_CATEGORY[sub.trim()];
    if (cat) categories.add(cat);
  }
  return [...categories];
}
