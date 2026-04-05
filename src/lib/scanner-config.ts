// Scanner configuration — extracted from resend0331.py
// Pure data/config file. No logic.

export interface SchoolInfo {
  name: string;
  tier: number;
  count: number;
}

// ============ arXiv categories ============
export const CATEGORIES: string[] = [
  "cs.LG",
  "cs.AI",
  "cs.CV",
  "cs.CL",
  "cs.RO",
  "stat.ML",
];

// ============ 150 common Chinese surnames (pinyin) ============
export const CHINESE_SURNAMES: Set<string> = new Set([
  "wang", "li", "zhang", "liu", "chen", "yang", "huang", "zhao", "wu", "zhou",
  "xu", "sun", "ma", "zhu", "hu", "guo", "he", "lin", "luo", "zheng",
  "liang", "xie", "tang", "wei", "feng", "deng", "cao", "peng", "zeng", "xiao",
  "tian", "dong", "pan", "yuan", "cai", "jiang", "yu", "du", "ye", "cheng",
  "su", "lu", "ding", "gao", "shen", "ren", "pei", "han", "song", "qian",
  "fan", "shi", "wan", "wen", "fang", "yao", "tan", "liao", "zou", "xiong",
  "jin", "kong", "bai", "cui", "kang", "mao", "qiu", "gu", "hou", "shao",
  "meng", "long", "duan", "lei", "qin", "yi", "chang", "xue", "yan",
  "dai", "fu", "niu", "jia", "yin", "tao", "hao", "lv", "ai",
  "lian", "min", "kou", "ning", "ji", "bi", "qi", "mu", "lang", "bao",
  "shan", "jiao", "geng", "xiang", "zuo", "chai", "rao", "hong", "you",
  "zhan", "ke", "ruan", "weng", "chi", "gan", "rong", "zhuang", "ping", "hua",
  "sheng", "hang", "nong", "yue", "le", "chong", "zhai", "nan", "gong",
  "tu", "ling", "shu", "yun", "la", "sa", "bo", "che", "jing",
  "leng", "sang", "tong", "ba", "nie", "lou", "xing",
]);

// ============ School data ============
export const SCHOOL_DATA: Record<string, SchoolInfo> = {
  "mit.edu": { name: "MIT", tier: 1, count: 6 },
  "stanford.edu": { name: "Stanford", tier: 1, count: 6 },
  "berkeley.edu": { name: "UC Berkeley", tier: 1, count: 3 },
  "cmu.edu": { name: "CMU", tier: 1, count: 1 },
  "harvard.edu": { name: "Harvard", tier: 1, count: 2 },
  "princeton.edu": { name: "Princeton", tier: 1, count: 1 },
  "caltech.edu": { name: "Caltech", tier: 1, count: 1 },
  "cam.ac.uk": { name: "Cambridge", tier: 1, count: 1 },
  "ox.ac.uk": { name: "Oxford", tier: 1, count: 2 },
  "ethz.ch": { name: "ETH Zurich", tier: 1, count: 1 },
  "tsinghua.edu.cn": { name: "清华", tier: 1, count: 24 },
  "pku.edu.cn": { name: "北大", tier: 1, count: 22 },
  "gatech.edu": { name: "Georgia Tech", tier: 2, count: 11 },
  "cornell.edu": { name: "Cornell", tier: 2, count: 1 },
  "yale.edu": { name: "Yale", tier: 2, count: 1 },
  "upenn.edu": { name: "UPenn", tier: 2, count: 1 },
  "uchicago.edu": { name: "UChicago", tier: 2, count: 6 },
  "ucla.edu": { name: "UCLA", tier: 2, count: 2 },
  "ucsd.edu": { name: "UCSD", tier: 2, count: 2 },
  "illinois.edu": { name: "UIUC", tier: 2, count: 2 },
  "umich.edu": { name: "UMich", tier: 2, count: 2 },
  "nyu.edu": { name: "NYU", tier: 2, count: 1 },
  "jhu.edu": { name: "JHU", tier: 2, count: 1 },
  "duke.edu": { name: "Duke", tier: 2, count: 2 },
  "usc.edu": { name: "USC", tier: 2, count: 2 },
  "wisc.edu": { name: "UW-Madison", tier: 2, count: 1 },
  "ucl.ac.uk": { name: "UCL", tier: 2, count: 1 },
  "u-tokyo.ac.jp": { name: "东京大学", tier: 2, count: 1 },
  "nus.edu.sg": { name: "NUS", tier: 2, count: 3 },
  "ntu.edu.sg": { name: "NTU", tier: 2, count: 2 },
  "hku.hk": { name: "港大", tier: 2, count: 7 },
  "ust.hk": { name: "港科大", tier: 2, count: 6 },
  "hkust-gz.edu.cn": { name: "港科大(广州)", tier: 2, count: 6 },
  "cuhk.edu.hk": { name: "港中文", tier: 2, count: 2 },
  "cuhk.edu.cn": { name: "港中文(深圳)", tier: 2, count: 2 },
  "zju.edu.cn": { name: "浙大", tier: 2, count: 12 },
  "fudan.edu.cn": { name: "复旦", tier: 2, count: 1 },
  "sjtu.edu.cn": { name: "上交", tier: 2, count: 9 },
  "ustc.edu.cn": { name: "中科大", tier: 2, count: 7 },
  "nju.edu.cn": { name: "南大", tier: 2, count: 1 },
  "cas.cn": { name: "中科院", tier: 3, count: 8 },
  "ict.ac.cn": { name: "中科院", tier: 3, count: 8 },
  "buaa.edu.cn": { name: "北航", tier: 3, count: 6 },
  "bit.edu.cn": { name: "北理工", tier: 3, count: 3 },
  "bupt.edu.cn": { name: "北邮", tier: 3, count: 2 },
  "xjtu.edu.cn": { name: "西交", tier: 3, count: 1 },
  "hust.edu.cn": { name: "华科", tier: 3, count: 1 },
  "whu.edu.cn": { name: "武大", tier: 3, count: 3 },
  "seu.edu.cn": { name: "东南", tier: 3, count: 1 },
  "sdu.edu.cn": { name: "山大", tier: 3, count: 1 },
  "uestc.edu.cn": { name: "电子科大", tier: 3, count: 1 },
  "tongji.edu.cn": { name: "同济", tier: 3, count: 3 },
  "shanghaitech.edu.cn": { name: "上科大", tier: 3, count: 3 },
  "cityu.edu.hk": { name: "港城大", tier: 3, count: 3 },
  "adelaide.edu.au": { name: "Adelaide", tier: 3, count: 4 },
  "ualberta.ca": { name: "Alberta", tier: 3, count: 2 },
};

// ============ Supported directions ============
export const SUPPORTED_DIRECTIONS: Record<string, string[]> = {
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

// Flattened list of all directions
export const ALL_DIRECTIONS: string[] = Object.values(SUPPORTED_DIRECTIONS).flat();

// ============ URL constants ============
export const APPLY_URL_CTA =
  "https://apply.miracleplus.com/?p=gpu&c=ib&r=4Xq0R&utm_source=em";
export const WECHAT_ARTICLE_URL =
  "https://mp.weixin.qq.com/s/Ad7rKWbEc87Tq92DTfcI-g";
