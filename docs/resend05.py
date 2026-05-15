import arxiv
import requests
import re
import fitz
from llm_client import chat as llm_chat, LLMError
from pathlib import Path
import json
import imaplib
import time
import html as html_lib
import threading
from queue import Queue, Empty
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed

import os

# ============ CONFIG ============
# All LLM traffic goes through the MiraclePlus proxy (see llm_client.py).
# The old direct-Google key has been removed — proxy routes Gemini, OpenAI,
# Anthropic, etc. via one OpenAI-compatible endpoint.
RESEND_API_KEY = "re_BDAhnsct_HGFVYVjeVYSi9ZCi1BwbpDhA"
SENDER_EMAIL = "leo@compute.miracleplus.com"
SENDER_NAME = "Leo"
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "https://qiji-pipeline.vercel.app")

# Set this in env if Vercel Deployment Protection is enabled on the project:
# Vercel → Settings → Deployment Protection → "Protection Bypass for Automation"
VERCEL_BYPASS_SECRET = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET", "")

# Supabase direct-read, used to reconcile email_history.json on startup
# AND to refresh contact dedup before each Gemini call. Hardcoded fallback
# so the script works without shell env exports — the project key is the
# anon-grade service role for this single-purpose dashboard.
SUPABASE_URL = (
    os.environ.get("SUPABASE_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or "https://erguqrisqtugfysofwdd.supabase.co"
)
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVy"
    "Z3VxcmlzcXR1Z2Z5c29md2RkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2OTQx"
    "NzY1MywiZXhwIjoyMDg0OTkzNjUzfQ.du-2N1m5W9jKsFVQpmNfMVnKpqTk3Vxmi96JBxMccEM"
)

CATEGORIES = ["cs.LG", "cs.AI", "cs.CV", "cs.CL", "cs.RO", "stat.ML"]
MAX_PAPERS = 12000
PDF_BATCH_SIZE = 5
PDF_WORKERS = 3
MIN_AGE_DAYS_QUEUE = 0  # Queue mode: web enforces 7-day gate at send time
MIN_AGE_DAYS_SEND = 7   # Send mode: Python sends direct, must enforce the 7-day gate itself
MIN_AGE_DAYS = MIN_AGE_DAYS_QUEUE  # resolved at runtime in main() based on queue_only

SCRIPT_DIR = Path(__file__).parent
HISTORY_FILE = SCRIPT_DIR / "email_history.json"
CHECKPOINT_FILE = SCRIPT_DIR / "checkpoint.json"
PROCESSED_FILE = SCRIPT_DIR / "processed_papers.json"
TRAINING_FILE = SCRIPT_DIR / "training_data.jsonl"
# Leads whose POST to /api/pipeline/import failed (after exhausting in-process
# retries — e.g. Vercel edge 403s during a bursty run). Drained at startup so
# a real lead never gets silently dropped just because the edge was flaky.
IMPORT_RETRY_QUEUE = SCRIPT_DIR / "import_retry_queue.jsonl"

# ============ 150 常见中国姓氏（拼音） ============
CHINESE_SURNAMES = {
    'wang', 'li', 'zhang', 'liu', 'chen', 'yang', 'huang', 'zhao', 'wu', 'zhou',
    'xu', 'sun', 'ma', 'zhu', 'hu', 'guo', 'he', 'lin', 'luo', 'zheng',
    'liang', 'xie', 'tang', 'wei', 'feng', 'deng', 'cao', 'peng', 'zeng', 'xiao',
    'tian', 'dong', 'pan', 'yuan', 'cai', 'jiang', 'yu', 'du', 'ye', 'cheng',
    'su', 'lu', 'ding', 'gao', 'shen', 'ren', 'pei', 'han', 'song', 'qian',
    'fan', 'shi', 'wan', 'wen', 'fang', 'yao', 'tan', 'liao', 'zou', 'xiong',
    'jin', 'kong', 'bai', 'cui', 'kang', 'mao', 'qiu', 'gu', 'hou', 'shao',
    'meng', 'long', 'wan', 'duan', 'lei', 'qin', 'yi', 'chang', 'xue', 'yan',
    'dai', 'fu', 'niu', 'jia', 'yin', 'tao', 'hao', 'lv', 'he', 'ai',
    'lian', 'min', 'kou', 'ning', 'ji', 'bi', 'qi', 'mu', 'lang', 'bao',
    'shan', 'jiao', 'geng', 'xiang', 'zou', 'zuo', 'chai', 'rao', 'hong', 'you',
    'zhan', 'ke', 'ruan', 'weng', 'chi', 'gan', 'rong', 'zhuang', 'ping', 'hua',
    'sheng', 'hang', 'nong', 'wen', 'yue', 'le', 'chong', 'zhai', 'nan', 'gong',
    'tu', 'ling', 'shu', 'yun', 'la', 'sa', 'bo', 'che', 'jing', 'cao',
    'leng', 'sang', 'tong', 'ba', 'ji', 'nie', 'su', 'zuo', 'lou', 'xing',
}

# ============ 学校数据 ============
SCHOOL_DATA = {
    "mit.edu": {"name": "MIT", "tier": 1, "count": 6},
    "stanford.edu": {"name": "Stanford", "tier": 1, "count": 6},
    "berkeley.edu": {"name": "UC Berkeley", "tier": 1, "count": 3},
    "cmu.edu": {"name": "CMU", "tier": 1, "count": 1},
    "harvard.edu": {"name": "Harvard", "tier": 1, "count": 2},
    "princeton.edu": {"name": "Princeton", "tier": 1, "count": 1},
    "caltech.edu": {"name": "Caltech", "tier": 1, "count": 1},
    "cam.ac.uk": {"name": "Cambridge", "tier": 1, "count": 1},
    "ox.ac.uk": {"name": "Oxford", "tier": 1, "count": 2},
    "ethz.ch": {"name": "ETH Zurich", "tier": 1, "count": 1},
    "tsinghua.edu.cn": {"name": "清华", "tier": 1, "count": 24},
    "pku.edu.cn": {"name": "北大", "tier": 1, "count": 22},
    "gatech.edu": {"name": "Georgia Tech", "tier": 2, "count": 11},
    "cornell.edu": {"name": "Cornell", "tier": 2, "count": 1},
    "yale.edu": {"name": "Yale", "tier": 2, "count": 1},
    "upenn.edu": {"name": "UPenn", "tier": 2, "count": 1},
    "uchicago.edu": {"name": "UChicago", "tier": 2, "count": 6},
    "ucla.edu": {"name": "UCLA", "tier": 2, "count": 2},
    "ucsd.edu": {"name": "UCSD", "tier": 2, "count": 2},
    "illinois.edu": {"name": "UIUC", "tier": 2, "count": 2},
    "umich.edu": {"name": "UMich", "tier": 2, "count": 2},
    "nyu.edu": {"name": "NYU", "tier": 2, "count": 1},
    "jhu.edu": {"name": "JHU", "tier": 2, "count": 1},
    "duke.edu": {"name": "Duke", "tier": 2, "count": 2},
    "usc.edu": {"name": "USC", "tier": 2, "count": 2},
    "wisc.edu": {"name": "UW-Madison", "tier": 2, "count": 1},
    "ucl.ac.uk": {"name": "UCL", "tier": 2, "count": 1},
    "u-tokyo.ac.jp": {"name": "东京大学", "tier": 2, "count": 1},
    "nus.edu.sg": {"name": "NUS", "tier": 2, "count": 3},
    "ntu.edu.sg": {"name": "NTU", "tier": 2, "count": 2},
    "hku.hk": {"name": "港大", "tier": 2, "count": 7},
    "ust.hk": {"name": "港科大", "tier": 2, "count": 6},
    "hkust-gz.edu.cn": {"name": "港科大(广州)", "tier": 2, "count": 6},
    "cuhk.edu.hk": {"name": "港中文", "tier": 2, "count": 2},
    "cuhk.edu.cn": {"name": "港中文(深圳)", "tier": 2, "count": 2},
    "zju.edu.cn": {"name": "浙大", "tier": 2, "count": 12},
    "fudan.edu.cn": {"name": "复旦", "tier": 2, "count": 1},
    "sjtu.edu.cn": {"name": "上交", "tier": 2, "count": 9},
    "ustc.edu.cn": {"name": "中科大", "tier": 2, "count": 7},
    "nju.edu.cn": {"name": "南大", "tier": 2, "count": 1},
    "cas.cn": {"name": "中科院", "tier": 3, "count": 8},
    "ict.ac.cn": {"name": "中科院", "tier": 3, "count": 8},
    "buaa.edu.cn": {"name": "北航", "tier": 3, "count": 6},
    "bit.edu.cn": {"name": "北理工", "tier": 3, "count": 3},
    "bupt.edu.cn": {"name": "北邮", "tier": 3, "count": 2},
    "xjtu.edu.cn": {"name": "西交", "tier": 3, "count": 1},
    "hust.edu.cn": {"name": "华科", "tier": 3, "count": 1},
    "whu.edu.cn": {"name": "武大", "tier": 3, "count": 3},
    "seu.edu.cn": {"name": "东南", "tier": 3, "count": 1},
    "sdu.edu.cn": {"name": "山大", "tier": 3, "count": 1},
    "uestc.edu.cn": {"name": "电子科大", "tier": 3, "count": 1},
    "tongji.edu.cn": {"name": "同济", "tier": 3, "count": 3},
    "shanghaitech.edu.cn": {"name": "上科大", "tier": 3, "count": 3},
    "cityu.edu.hk": {"name": "港城大", "tier": 3, "count": 3},
    "adelaide.edu.au": {"name": "Adelaide", "tier": 3, "count": 4},
    "ualberta.ca": {"name": "Alberta", "tier": 3, "count": 2},

    # --- Added to close gaps surfaced by smoke runs (rzhu48@ucsc.edu landed
    # with school_name=None because UCSC was missing). Tiers follow the same
    # rough heuristic as existing entries: T1 = top-10 globally for AI, T2 =
    # strong AI program / R1, T3 = solid research university.

    # UC system (rest of the campuses — berkeley/ucla/ucsd already above)
    "ucsc.edu":      {"name": "UCSC",       "tier": 2, "count": 1},
    "uci.edu":       {"name": "UC Irvine",  "tier": 2, "count": 1},
    "ucdavis.edu":   {"name": "UC Davis",   "tier": 2, "count": 1},
    "ucsb.edu":      {"name": "UCSB",       "tier": 2, "count": 1},
    "ucr.edu":       {"name": "UC Riverside","tier": 3, "count": 1},

    # US — additional R1 / strong AI programs
    "utexas.edu":    {"name": "UT Austin",      "tier": 1, "count": 1},
    "umd.edu":       {"name": "UMD",            "tier": 2, "count": 1},
    "unc.edu":       {"name": "UNC",            "tier": 2, "count": 1},
    "northwestern.edu": {"name": "Northwestern","tier": 2, "count": 1},
    "brown.edu":     {"name": "Brown",          "tier": 2, "count": 1},
    "rice.edu":      {"name": "Rice",           "tier": 2, "count": 1},
    "uw.edu":        {"name": "UW Seattle",     "tier": 1, "count": 1},
    "washington.edu":{"name": "UW Seattle",     "tier": 1, "count": 1},
    "purdue.edu":    {"name": "Purdue",         "tier": 2, "count": 1},
    "psu.edu":       {"name": "Penn State",     "tier": 3, "count": 1},
    "osu.edu":       {"name": "Ohio State",     "tier": 3, "count": 1},
    "umass.edu":     {"name": "UMass",          "tier": 3, "count": 1},
    "vt.edu":        {"name": "Virginia Tech",  "tier": 3, "count": 1},
    "colorado.edu":  {"name": "CU Boulder",     "tier": 3, "count": 1},
    "bu.edu":        {"name": "Boston U",       "tier": 3, "count": 1},
    "tufts.edu":     {"name": "Tufts",          "tier": 3, "count": 1},
    "rutgers.edu":   {"name": "Rutgers",        "tier": 3, "count": 1},
    "nd.edu":        {"name": "Notre Dame",     "tier": 3, "count": 1},

    # Canada
    "toronto.edu":   {"name": "Toronto",        "tier": 1, "count": 1},
    "utoronto.ca":   {"name": "Toronto",        "tier": 1, "count": 1},
    "mcgill.ca":     {"name": "McGill",         "tier": 2, "count": 1},
    "ubc.ca":        {"name": "UBC",            "tier": 2, "count": 1},
    "uwaterloo.ca":  {"name": "Waterloo",       "tier": 2, "count": 1},
    "mila.quebec":   {"name": "Mila",           "tier": 1, "count": 1},

    # Europe
    "epfl.ch":       {"name": "EPFL",           "tier": 1, "count": 1},
    "tum.de":        {"name": "TU Munich",      "tier": 2, "count": 1},
    "imperial.ac.uk":{"name": "Imperial",       "tier": 1, "count": 1},
    "ed.ac.uk":      {"name": "Edinburgh",      "tier": 2, "count": 1},
    "manchester.ac.uk": {"name": "Manchester",  "tier": 3, "count": 1},
    "kit.edu":       {"name": "KIT",            "tier": 3, "count": 1},
    "mpg.de":        {"name": "MPI",            "tier": 1, "count": 1},
    "inria.fr":      {"name": "Inria",          "tier": 2, "count": 1},

    # Asia — Korea / Japan
    "kaist.ac.kr":   {"name": "KAIST",          "tier": 1, "count": 1},
    "snu.ac.kr":     {"name": "SNU",            "tier": 1, "count": 1},
    "postech.ac.kr": {"name": "POSTECH",        "tier": 2, "count": 1},
    "kyoto-u.ac.jp": {"name": "京都大学",        "tier": 2, "count": 1},
    "titech.ac.jp":  {"name": "东工大",          "tier": 2, "count": 1},
    "osaka-u.ac.jp": {"name": "大阪大学",        "tier": 3, "count": 1},
    "tohoku.ac.jp":  {"name": "东北大学(JP)",    "tier": 3, "count": 1},

    # China — additional 985/211 + research institutes that show up in arXiv
    "ruc.edu.cn":    {"name": "人大",            "tier": 2, "count": 1},
    "nankai.edu.cn": {"name": "南开",            "tier": 3, "count": 1},
    "tju.edu.cn":    {"name": "天大",            "tier": 3, "count": 1},
    "sysu.edu.cn":   {"name": "中山大学",        "tier": 2, "count": 1},
    "xmu.edu.cn":    {"name": "厦大",            "tier": 3, "count": 1},
    "hit.edu.cn":    {"name": "哈工大",          "tier": 2, "count": 1},
    "dlut.edu.cn":   {"name": "大工",            "tier": 3, "count": 1},
    "scut.edu.cn":   {"name": "华工",            "tier": 3, "count": 1},
    "csu.edu.cn":    {"name": "中南",            "tier": 3, "count": 1},
    "westlake.edu.cn":{"name": "西湖大学",       "tier": 2, "count": 1},
    "xidian.edu.cn": {"name": "西电",            "tier": 3, "count": 1},
    "polyu.edu.hk":  {"name": "港理工",          "tier": 3, "count": 1},

    # Singapore / Australia (NUS/NTU already above)
    "smu.edu.sg":    {"name": "SMU",            "tier": 3, "count": 1},
    "anu.edu.au":    {"name": "ANU",            "tier": 2, "count": 1},
    "unsw.edu.au":   {"name": "UNSW",           "tier": 2, "count": 1},
    "sydney.edu.au": {"name": "Sydney",         "tier": 2, "count": 1},
    "unimelb.edu.au":{"name": "Melbourne",      "tier": 2, "count": 1},
    "monash.edu":    {"name": "Monash",         "tier": 3, "count": 1},

    # Israel
    "tau.ac.il":     {"name": "Tel Aviv",       "tier": 2, "count": 1},
    "huji.ac.il":    {"name": "Hebrew U",       "tier": 2, "count": 1},
    "technion.ac.il":{"name": "Technion",       "tier": 2, "count": 1},
    "weizmann.ac.il":{"name": "Weizmann",       "tier": 2, "count": 1},
}

# ============ 方向转化率权重 (基于 Q1 漏斗分析) ============
# CVR = email-sourced applications / emails sent per direction
# Used to adjust confidence threshold: high-CVR directions get a boost,
# zero-CVR directions get a penalty
DIRECTION_CVR_WEIGHTS = {
    # Tier 1: High CVR (>=2.5%) → boost +0.15
    "Embodied AI & World Models":        0.15,   # CVR 6.8%
    "LLM Architecture & Efficiency":     0.15,   # CVR 3.8%
    "NLP & Text Processing":             0.15,   # CVR 3.8%
    "Diffusion & Image/Video Generation":0.15,   # CVR 3.4%
    "LLM Safety & Alignment":            0.15,   # CVR 2.6%

    # Tier 2: Medium CVR (1.5-2.5%) → boost +0.08
    "Medical & Life Science AI":         0.08,   # CVR 2.2%
    "LLM Agents & Multi-Agent":          0.08,   # CVR 1.9%
    "LLM Training & Post-training":      0.08,   # CVR 1.9%
    "RAG & Information Retrieval":        0.08,   # CVR 1.7%
    "Code & Software Engineering":        0.08,   # CVR 1.5%
    "Autonomous Driving":                 0.08,   # CVR 1.5%

    # Tier 3: Low CVR (0.5-1.5%) → no adjustment
    "Audio, Speech & Music":              0.0,
    "VLM & Multimodal Understanding":     0.0,
    "Time Series & Spatio-temporal":      0.0,
    "Science & Engineering AI":           0.0,
    "Representation & Transfer Learning": 0.0,
    "3D Vision & Reconstruction":         0.0,
    "Privacy, Security & Federated":      0.0,
    "Detection, Segmentation & Tracking": 0.0,
    "Benchmarks & Evaluation":            0.0,
    "VLA & Robot Learning":               0.0,

    # Tier 4: Zero CVR → penalty -0.15
    "Reinforcement Learning":            -0.15,
    "LLM Reasoning & Planning":          -0.15,
    "Graph & Network Learning":          -0.15,
    "Recommendation & Ranking":          -0.10,
    "Remote Sensing & Geospatial":       -0.10,

    # Default / Other
    "Other":                              0.0,
}


def get_direction_weight(research_direction):
    """Return confidence adjustment based on direction's historical CVR."""
    if not research_direction:
        return 0.0
    return DIRECTION_CVR_WEIGHTS.get(research_direction, 0.0)


# ============ 支持方向 ============
SUPPORTED_DIRECTIONS = {
    "具身智能/机器人": [
        "具身导航感知", "多模态具身大模型", "模块化力控关节",
        "场景孪生仿真", "工业具身模仿学习", "自动驾驶",
        "世界模型+VLA", "连续体机械臂", "端侧机器人推理",
        "视频策略表征", "1 bit 量化VLA模型",
        "长程灵巧操作", "具身3D空间理解",
        "化工精密操作机器人",
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
    "推理/符号": ["神经符号大模型", "数学推理模型", "金融大模型", "非欧空间表征模型",
                "表格结构化基础模型"],
    "其他": ["工业设计Agent", "段级强化学习", "RL动态重排序"]
}

ALL_DIRECTIONS = []
for directions in SUPPORTED_DIRECTIONS.values():
    ALL_DIRECTIONS.extend(directions)


# ============ CHINESE SURNAME PRE-FILTER ============
def likely_has_chinese_author(authors):
    for name in authors:
        parts = name.strip().split()
        if len(parts) < 2:
            continue
        last = parts[-1].lower()
        if last in CHINESE_SURNAMES:
            return True
        first = parts[0].lower()
        if first in CHINESE_SURNAMES:
            return True
    return False


# ============ TITLE VALIDATION ============
SUPERSCRIPTS = str.maketrans('0123456789+-=()nixy', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱˣʸ')
SUBSCRIPTS = str.maketrans('0123456789+-=()aeiourkvxn', '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑᵢₒᵤᵣₖᵥₓₙ')


def clean_math_in_title(title):
    title = re.sub(r'\$([^$]+)\$', r'\1', title)
    title = re.sub(r'\\(?:text|mathrm|mathit|textit|textbf)\{([^}]+)\}', r'\1', title)
    title = re.sub(r'\\(?:mathcal|mathbb|boldsymbol|bm)\{([^}]+)\}', r'\1', title)
    def _sup(m):
        c = m.group(1) or m.group(2)
        return c.translate(SUPERSCRIPTS) if len(c) <= 4 else f'^{c}'
    title = re.sub(r'\^{([^}]+)}|\^(\w)', _sup, title)
    def _sub(m):
        c = m.group(1) or m.group(2)
        t = c.translate(SUBSCRIPTS)
        return t if t != c else f'_{c}'
    title = re.sub(r'_{([^}]+)}|_(\w)', _sub, title)
    replacements = {
        r'\log': 'log', r'\exp': 'exp', r'\max': 'max', r'\min': 'min',
        r'\sum': 'Σ', r'\prod': 'Π', r'\infty': '∞', r'\alpha': 'α',
        r'\beta': 'β', r'\gamma': 'γ', r'\delta': 'δ', r'\epsilon': 'ε',
        r'\lambda': 'λ', r'\theta': 'θ', r'\pi': 'π', r'\sigma': 'σ',
        r'\mu': 'μ', r'\omega': 'ω', r'\phi': 'φ', r'\psi': 'ψ',
        r'\tau': 'τ', r'\rho': 'ρ', r'\eta': 'η', r'\nu': 'ν',
        r'\times': '×', r'\cdot': '·', r'\leq': '≤', r'\geq': '≥',
        r'\neq': '≠', r'\approx': '≈', r'\rightarrow': '→', r'\leftarrow': '←',
        r'\sim': '~', r'\propto': '∝', r'\in': '∈', r'\subset': '⊂',
    }
    for latex, uni in replacements.items():
        title = title.replace(latex, uni)
    title = re.sub(r'\\(\w+)', r'\1', title)
    title = re.sub(r'\{([^}]*)\}', r'\1', title)
    return title.strip()


def clean_title(title):
    title = clean_math_in_title(title)
    return title.replace('?', '').strip()


def has_invalid_characters(title):
    invalid_chars = ['%', '*', '#', '@', '&', '=', '+', '/', '\\', '"', "'", '<', '>', '|', '~', '`']
    for char in invalid_chars:
        if char in title:
            return True, char
    return False, None


# ============ PAPER AGE FILTER (FIXED) ============
def _arxiv_id_to_datetime(arxiv_id: str) -> datetime | None:
    """
    Parse the submission month from an arxiv ID as a conservative lower-bound date.
    New format: '2501.00001'  → Jan 2025, day 1 00:00 UTC
    Old format:  'hep-th/9901001' → not matched, returns None.
    We use the 1st of the month so we never under-estimate paper age.
    """
    m = re.match(r'^(\d{2})(\d{2})\.\d+', arxiv_id)
    if not m:
        return None
    year = 2000 + int(m.group(1))
    month = int(m.group(2))
    if not (1 <= month <= 12):
        return None
    try:
        return datetime(year, month, 1, tzinfo=timezone.utc)
    except ValueError:
        return None


def is_paper_old_enough(published_dt, arxiv_id=None, min_age_days=None):
    # Resolve at call time so runtime mode switching (Q→0, S→7) actually
    # takes effect. A mutable module-level default captured at def time
    # would freeze the gate to whatever MIN_AGE_DAYS was at import.
    if min_age_days is None:
        min_age_days = MIN_AGE_DAYS
    """
    Return True only when we can CONFIRM the paper is old enough.

    Fix vs. original:
    - 'return True' when date is None was a bug: unknown-date papers bypassed
      the filter entirely. We now try an arxiv-ID fallback first, and only
      skip (return False) if we genuinely cannot determine the age at all.
    - Both published_dt and the ID-derived date are made timezone-aware before
      comparison, guarding against naive-datetime subtraction errors.
    """
    now = datetime.now(timezone.utc)

    if published_dt is not None:
        if published_dt.tzinfo is None:
            published_dt = published_dt.replace(tzinfo=timezone.utc)
        return (now - published_dt) >= timedelta(days=min_age_days)

    # published_dt is None — try to infer from arxiv ID
    if arxiv_id:
        fallback_dt = _arxiv_id_to_datetime(arxiv_id)
        if fallback_dt is not None:
            # Use start-of-month as a conservative estimate:
            # if even the first day of that month is old enough, the paper is safe.
            age_is_ok = (now - fallback_dt) >= timedelta(days=min_age_days)
            if age_is_ok:
                print(f"  ⚠️ published=None, 用arxiv_id推断日期 ({fallback_dt.date()}) → 允许")
            else:
                print(f"  ⚠️ published=None, 用arxiv_id推断日期 ({fallback_dt.date()}) → 过滤")
            return age_is_ok

    # Cannot determine age at all → err on the side of caution and skip
    print(f"  ⚠️ 无法确定论文日期，跳过 (arxiv_id={arxiv_id})")
    return False


# ============ JSON PARSING ============
def parse_llm_json(text, default, *, _ctx=None):
    """Parse JSON from LLM output, tolerating ```fences and surrounding chatter.

    On failure, returns `default` and (if _ctx is given) logs a one-line
    sample of the offending raw text so the caller can attribute "AI分析失败"
    to a parser miss rather than a network/HTTP error.
    """
    raw = text
    text = re.sub(r'^```\w*\n?|```$', '', text.strip()).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'[\[{].*[\]}]', text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group())
            except json.JSONDecodeError:
                pass
        if _ctx:
            sample = (raw or '').replace('\n', ' ')[:200]
            print(f"  ⚠️ parse_llm_json failed [{_ctx}]: {sample!r}")
        return default


# ============ EMAIL HISTORY ============
def load_email_history():
    if HISTORY_FILE.exists():
        with open(HISTORY_FILE, 'r') as f:
            return json.load(f)
    return {}


def save_email_history(history):
    with open(HISTORY_FILE, 'w') as f:
        json.dump(history, f, indent=2, ensure_ascii=False)


def reconcile_history_from_supabase(history):
    """Pull every recipient's most-recent send from Supabase and merge into
    email_history.json. Ensures that anything sent by the web UI (which
    doesn't touch the JSON) still counts against the 365-day dedup guard
    on the next Python run.

    Keyed by lowercased recipient. Supabase wins on conflicts — if the DB
    says we contacted someone more recently than the JSON does, we trust
    the DB. The reverse (JSON more recent than DB) should never happen
    in practice because Python already writes to the JSON on send/queue.
    """
    if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
        print("  ⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY not set — skipping reconcile")
        return history

    # PostgREST: select recipient + sent_at. Paginate if needed.
    url = f"{SUPABASE_URL.rstrip('/')}/rest/v1/emails"
    headers = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Range-Unit": "items",
    }
    rows = []
    page_size = 1000
    offset = 0
    while True:
        # The emails table has created_at (insertion time) but no sent_at.
        # For dedup-by-year purposes, created_at is the right timestamp:
        # it's when the send was recorded.
        params = {
            "select": "to,subject,created_at",
            "order": "created_at.desc",
            "limit": page_size,
            "offset": offset,
        }
        # Retry per-page with exponential backoff. Offset pages hit a slow
        # server-side sort and occasionally exceed the connect timeout on
        # flaky networks — one timeout shouldn't discard pages already fetched.
        page = None
        last_err = None
        for attempt in range(4):
            try:
                resp = requests.get(url, headers=headers, params=params, timeout=30)
                resp.raise_for_status()
                page = resp.json() or []
                break
            except Exception as e:
                last_err = e
                if attempt < 3:
                    wait = 2 ** attempt  # 1, 2, 4
                    print(f"  🔁 Reconcile page offset={offset} failed ({type(e).__name__}); retry {attempt+1}/3 in {wait}s")
                    time.sleep(wait)
        if page is None:
            # Persistent failure — keep rows already fetched and merge what we have.
            # Loud warning when offset==0 since that means reconcile was a full no-op
            # and we're running entirely on local JSON (web-UI sends won't be deduped).
            if offset == 0:
                print(f"  ❌ Reconcile could not fetch ANY pages after 4 tries ({last_err}); running with local JSON only — web-UI sends will NOT be deduped this run")
            else:
                print(f"  ⚠️ Reconcile gave up at offset={offset} after 4 tries ({last_err}); merging {len(rows)} rows fetched so far")
            break
        rows.extend(page)
        if len(page) < page_size:
            break
        offset += page_size

    # Collapse to one entry per recipient, keeping the most recent timestamp.
    # Postgres already ordered by sent_at desc, but we defend against nulls
    # and row-ordering surprises by comparing explicitly.
    merged = 0
    added = 0
    for row in rows:
        to = (row.get("to") or "").strip().lower()
        if not to:
            continue
        ts = row.get("created_at")
        if not ts:
            continue
        existing = history.get(to)
        existing_ts = existing.get("date") if existing else None
        # Only overwrite if DB timestamp is newer (or no existing entry)
        if existing_ts and existing_ts >= ts:
            continue
        history[to] = {
            "date": ts,
            "paper": (existing or {}).get("paper", "(from supabase)"),
            "subject": row.get("subject") or (existing or {}).get("subject"),
            "body_html": (existing or {}).get("body_html"),
        }
        if existing:
            merged += 1
        else:
            added += 1
    save_email_history(history)
    print(f"  🔄 Reconciled from Supabase: +{added} new, ~{merged} updated, {len(history)} total")
    return history


def was_contacted_this_year(email, history):
    email = email.lower()
    if email not in history:
        return False
    # `date` may be naive (written by record_email below) or aware (written
    # by the Supabase reconcile, which carries Postgres' +00:00). Normalize
    # both sides to aware UTC so we don't crash on "can't compare
    # offset-naive and offset-aware datetimes".
    last_contact = datetime.fromisoformat(history[email]['date'])
    if last_contact.tzinfo is None:
        last_contact = last_contact.replace(tzinfo=timezone.utc)
    return last_contact > datetime.now(timezone.utc) - timedelta(days=365)


def record_email(email, paper_title, history, subject=None, body_html=None):
    email = email.lower()
    entry = {"date": datetime.now().isoformat(), "paper": paper_title}
    if subject:
        entry["subject"] = subject
    if body_html:
        entry["body_html"] = body_html
    history[email] = entry
    save_email_history(history)


# ============ QUEUE TO MAIL SYSTEM ============
def queue_to_mail_system(lead, to_email, author_analysis, subject, body_html):
    """Push lead + draft to Mail system as 'ready' (not sent yet).
    Mail system handles age gating and send scheduling."""
    school_info = get_school_info(to_email)
    payload = {
        "leads": [{
            "arxivId": lead.get("arxiv_id"),
            "title": lead.get("title"),
            "abstract": lead.get("abstract", "")[:2000],
            "authorEmail": to_email,
            "authorName": author_analysis.get("author"),
            # Full author list from arxiv (joined string). The dashboard's
            # `authors` column has historically been single-name because we
            # only sent `authorName`. Pass the full list separately so the
            # API can store it. authorName stays = matched recipient.
            "authors": ", ".join(lead.get("authors", []) or []),
            "firstName": author_analysis.get("first_name"),
            "source": "python_scanner",
            "draftSubject": subject,
            "draftHtml": body_html,
            "pdfUrl": lead.get("pdf_url"),
            "publishedAt": lead.get("published", "").isoformat() if hasattr(lead.get("published", ""), "isoformat") else str(lead.get("published", "")),
            "computeLevel": lead.get("compute_level", "none"),
            "computeConfidence": lead.get("adjusted_confidence", lead.get("compute_confidence", 0)),
            "computeReason": lead.get("compute_reason", ""),
            "matchedDirections": json.dumps(lead.get("matched_directions", [])),
            "schoolName": school_info.get("name") if school_info else None,
            "schoolTier": school_info.get("tier") if school_info else None,
        }]
    }
    # Add research direction if available
    if lead.get("research_direction"):
        payload["leads"][0]["researchDirection"] = lead["research_direction"]

    # Pass everything Python already enriched so the server doesn't re-query
    # S2/Tavily/Gemini. Each "if" guards against null so we don't write 0 or "" by mistake.
    if lead.get("local_score") is not None:
        payload["leads"][0]["localScore"] = float(lead["local_score"])
    s2 = lead.get("s2_info") or {}
    if s2.get("citationCount") is not None:
        payload["leads"][0]["citationCount"] = int(s2["citationCount"])
    if s2.get("hIndex") is not None:
        payload["leads"][0]["hIndex"] = int(s2["hIndex"])
    if s2.get("paperCount") is not None:
        payload["leads"][0]["paperCount"] = int(s2["paperCount"])
    if s2.get("authorId"):
        payload["leads"][0]["s2AuthorId"] = str(s2["authorId"])

    ok = post_payload_with_retry(payload, label=f"lead {to_email}")
    if not ok:
        # Don't lose the lead — append to a local retry queue. Next run
        # (or `python3 resend0412.py --drain-retry`) will replay it.
        persist_failed_import(payload, reason="exhausted retries")
        print(f"    💾 Saved to {IMPORT_RETRY_QUEUE.name} for retry on next run")
    return ok


# Status codes that indicate a transient server condition. 403 is NOT here
# anymore — when Vercel's edge security challenges us it returns 403 with
# an HTML body, and retrying in 2-3s just keeps the IP flagged. We detect
# that case explicitly below and back off much harder (or stop).
_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def _looks_like_vercel_challenge(resp):
    """A Vercel edge challenge / auth page is HTML (not JSON) and usually
    carries the Astro scoped-css marker or a Vercel cookie. If we see this,
    no amount of fast retrying will help — only backoff + UA + bypass do."""
    ctype = (resp.headers.get("content-type") or "").lower()
    body_head = (resp.text or "")[:400].lower()
    if "application/json" in ctype:
        return False
    set_cookie = (resp.headers.get("set-cookie") or "").lower()
    if "<html" in body_head and (
        "data-astro-cid" in body_head
        or "vercel" in body_head
        or "_vercel" in set_cookie
    ):
        return True
    return False


def post_payload_with_retry(payload, label="lead", max_attempts=5):
    """POST a single import payload with exponential backoff.

    Retries on network errors AND retryable HTTP statuses (429, 5xx).
    403 is handled specially: if the body looks like a Vercel edge
    challenge page (HTML, not JSON), back off MUCH harder (60s) and only
    try once more — fast retries just keep the IP flagged.

    Returns True on 2xx, False otherwise. Distinct from the inline retry
    that used to live in queue_to_mail_system — extracted so the startup
    drain (drain_import_retry_queue) can reuse it.
    """
    import_key = os.environ.get(
        "PIPELINE_IMPORT_KEY",
        "RggTCX1Yywo47hW8dUMA_jc0h-WoKEMY6oNkMiBPNZk",
    )
    headers = {
        # A real-looking UA stops Vercel's bot filter from auto-flagging us.
        "User-Agent": "qiji-pipeline-scanner/1.0 (+https://qiji-pipeline.vercel.app)",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if import_key:
        headers["Authorization"] = f"Bearer {import_key}"
    if VERCEL_BYPASS_SECRET:
        # Bypasses Vercel Deployment Protection for automation.
        headers["x-vercel-protection-bypass"] = VERCEL_BYPASS_SECRET
        headers["x-vercel-set-bypass-cookie"] = "true"

    url = f"{DASHBOARD_URL}/api/pipeline/import"
    last_err = None
    challenge_strikes = 0

    for attempt in range(max_attempts):
        try:
            resp = requests.post(url, json=payload, headers=headers, timeout=60)
            if resp.status_code in (200, 201):
                result = resp.json()
                print(f"    📬 Queued to Mail system (imported={result.get('imported', 0)})")
                return True

            # --- Vercel edge security challenge ---
            if resp.status_code in (401, 403) and _looks_like_vercel_challenge(resp):
                challenge_strikes += 1
                # Two strikes max — more just digs the hole deeper.
                if challenge_strikes >= 2:
                    print(
                        f"    ⛔ {label}: Vercel edge challenge persisted "
                        f"(HTTP {resp.status_code}). Likely Deployment "
                        f"Protection or Attack Challenge Mode. Set "
                        f"VERCEL_AUTOMATION_BYPASS_SECRET or whitelist this "
                        f"IP. Skipping."
                    )
                    return False
                wait = 60 * challenge_strikes  # 60s, then give up
                print(
                    f"    🛡️  {label}: Vercel challenge page (HTTP "
                    f"{resp.status_code}); cooling off {wait}s before one "
                    f"more try"
                )
                time.sleep(wait)
                continue

            # --- Real transient (429 / 5xx) ---
            if resp.status_code in _RETRYABLE_STATUS and attempt + 1 < max_attempts:
                wait = min(60, (2 ** attempt) + 1)  # 2, 3, 5, 9, 17 (capped at 60)
                snippet = (resp.text or "")[:80].replace("\n", " ")
                print(
                    f"    🔁 {label}: HTTP {resp.status_code} (transient); "
                    f"retry {attempt+1}/{max_attempts} in {wait}s — {snippet}"
                )
                time.sleep(wait)
                continue

            # Non-retryable (4xx that isn't 403-challenge / 408 / 425 / 429) — fail fast.
            print(f"    ⚠️ {label}: queue failed {resp.status_code}: {(resp.text or '')[:200]}")
            return False
        except requests.exceptions.RequestException as e:
            last_err = e
            if attempt + 1 < max_attempts:
                wait = min(60, (2 ** attempt) + 1)
                print(f"    🔁 {label}: network error ({type(e).__name__}); retry {attempt+1}/{max_attempts} in {wait}s")
                time.sleep(wait)
    print(f"    ❌ {label}: gave up after {max_attempts} attempts ({last_err})")
    return False


def persist_failed_import(payload, reason=""):
    """Append a failed import payload to the local retry queue (JSONL, one
    payload per line). Idempotent — duplicates get filtered at drain time."""
    try:
        with open(IMPORT_RETRY_QUEUE, "a") as f:
            f.write(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "reason": reason,
                "payload": payload,
            }) + "\n")
    except Exception as e:
        # Last-resort: log but don't crash the run. The lead is still lost in
        # this case but it's no worse than before this commit.
        print(f"    ⚠️ Failed to persist retry payload: {e}")


def drain_import_retry_queue():
    """Replay any leads from previous runs whose import POST failed.
    Called from main() at startup, before the scanner kicks off so the
    queue is empty and any new failures during this run only contain
    leads from THIS run.

    Paced: 1.5s between posts to stay under Vercel's per-IP rate-limit
    window. If we hit 3 consecutive edge-challenge failures, bail out and
    keep the remainder in the queue for the next run — the IP fingerprint
    will have cooled by then.
    """
    if not IMPORT_RETRY_QUEUE.exists():
        return
    try:
        with open(IMPORT_RETRY_QUEUE) as f:
            entries = [json.loads(line) for line in f if line.strip()]
    except Exception as e:
        print(f"  ⚠️ Could not read {IMPORT_RETRY_QUEUE.name}: {e} — leaving for manual recovery")
        return
    if not entries:
        IMPORT_RETRY_QUEUE.unlink(missing_ok=True)
        return
    print(f"  🔁 Draining {len(entries)} pending lead(s) from {IMPORT_RETRY_QUEUE.name}")

    still_failed = []
    consecutive_challenges = 0
    for idx, entry in enumerate(entries):
        payload = entry.get("payload")
        if not payload or not payload.get("leads"):
            continue
        # Identify the lead in the log so we can see which one is being retried
        lead0 = payload["leads"][0]
        label = f"retry {lead0.get('authorEmail', '?')} / {lead0.get('arxivId', '?')}"

        # Pace the drain. 1.5s between posts is enough to stay under Vercel's
        # default rate-limit window for the same IP, and tiny compared to
        # the rest of the pipeline. Skip the sleep for the very first one.
        if idx > 0:
            time.sleep(1.5)

        ok = post_payload_with_retry(payload, label=label, max_attempts=3)
        if ok:
            consecutive_challenges = 0
        else:
            still_failed.append(entry)
            consecutive_challenges += 1
            # If we hit 3 in a row, the edge has definitely flagged us.
            # Bail out, keep the rest in the queue, and try again next run
            # (when the IP fingerprint has cooled).
            if consecutive_challenges >= 3:
                remaining = entries[idx + 1:]
                still_failed.extend(remaining)
                print(
                    f"  🛑 Stopping drain — {consecutive_challenges} failures "
                    f"in a row look like edge rate-limit. {len(remaining)} "
                    f"lead(s) deferred to next run."
                )
                break

    # Rewrite the queue with only the leads that STILL failed. Successful
    # ones are dropped; persistent failures stay until the next run.
    if still_failed:
        with open(IMPORT_RETRY_QUEUE, "w") as f:
            for entry in still_failed:
                f.write(json.dumps(entry) + "\n")
        print(f"  ⚠️ {len(still_failed)} lead(s) still failed after drain — kept in queue for next run")
    else:
        IMPORT_RETRY_QUEUE.unlink(missing_ok=True)
        print(f"  ✅ All pending leads drained successfully")


# ============ DASHBOARD SYNC ============
def sync_to_dashboard(lead, to_email, author_analysis, subject, body_html=None):
    """Post full paper + author context to the Mail dashboard after sending."""
    school_info = get_school_info(to_email)
    payload = {
        "paper": {
            "arxiv_id": lead.get("arxiv_id"),
            "title": lead.get("title"),
            "abstract": lead.get("abstract", "")[:2000],
            "authors": lead.get("authors", []),
            "pdf_url": lead.get("pdf_url"),
            "published": lead.get("published", "").isoformat() if hasattr(lead.get("published", ""), "isoformat") else str(lead.get("published", "")),
        },
        "emailed": {
            "email": to_email,
            "author_name": author_analysis.get("author"),
            "first_name": author_analysis.get("first_name"),
        },
        "all_authors": lead.get("all_email_matches", []),
        "compute": {
            "level": lead.get("compute_level", "none"),
            "confidence": lead.get("compute_confidence", 0),
            "reason": lead.get("compute_reason", ""),
        },
        "matched_directions": lead.get("matched_directions", []),
        "subject": subject,
    }
    if school_info:
        payload["school"] = {
            "name": school_info.get("name", ""),
            "tier": school_info.get("tier"),
        }
    if body_html:
        payload["body_html"] = body_html
    # /api/pipeline/record requires bearer auth. Use PIPELINE_IMPORT_KEY for
    # symmetry with /api/pipeline/import — the middleware allowlists this
    # token for both routes, and the route accepts it (or CRON_SECRET).
    _record_key = os.environ.get(
        "PIPELINE_IMPORT_KEY",
        "RggTCX1Yywo47hW8dUMA_jc0h-WoKEMY6oNkMiBPNZk",
    )
    _record_headers = {
        "User-Agent": "qiji-pipeline-scanner/1.0 (+https://qiji-pipeline.vercel.app)",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if _record_key:
        _record_headers["Authorization"] = f"Bearer {_record_key}"
    if VERCEL_BYPASS_SECRET:
        _record_headers["x-vercel-protection-bypass"] = VERCEL_BYPASS_SECRET
        _record_headers["x-vercel-set-bypass-cookie"] = "true"
    resp = requests.post(
        f"{DASHBOARD_URL}/api/pipeline/record",
        json=payload,
        headers=_record_headers,
        timeout=10,
    )
    if resp.status_code in (200, 201):
        print(f"    📊 Dashboard synced")
    else:
        print(f"    ⚠️ Dashboard sync {resp.status_code}: {resp.text[:200]}")


# ============ CHECKPOINT ============
def load_checkpoint():
    if CHECKPOINT_FILE.exists():
        with open(CHECKPOINT_FILE, 'r') as f:
            return json.load(f)
    return {"last_arxiv_id": None, "last_run": None}


def save_checkpoint(arxiv_id):
    with open(CHECKPOINT_FILE, 'w') as f:
        json.dump({"last_arxiv_id": arxiv_id, "last_run": datetime.now().isoformat()}, f, indent=2)


# ============ PROCESSED PAPERS ============
def load_processed():
    if PROCESSED_FILE.exists():
        with open(PROCESSED_FILE, 'r') as f:
            return set(json.load(f))
    return set()


def save_processed(processed):
    with open(PROCESSED_FILE, 'w') as f:
        json.dump(list(processed), f)


# ============ FETCH PAPERS ============
# Arxiv enforces ~3 req/sec sustained; for large scans we need generous delays.
ARXIV_PAGE_SIZE   = 100   # results per HTTP request (arxiv max)
ARXIV_DELAY_SEC   = 5.0   # seconds between pages  (be polite)
ARXIV_NUM_RETRIES = 10    # retries per page before giving up
ARXIV_429_BACKOFF = 60    # extra seconds to wait on a 429 before retrying

def fetch_papers(categories, max_results=2000):
    """
    Yields paper dicts from arxiv, handling HTTP 429 rate-limit responses
    with exponential back-off so the scanner thread never crashes.
    """
    query = " OR ".join([f"cat:{cat}" for cat in categories])

    # Configure the client to be polite: wait between pages, retry on transient errors.
    client = arxiv.Client(
        page_size=ARXIV_PAGE_SIZE,
        delay_seconds=ARXIV_DELAY_SEC,
        num_retries=ARXIV_NUM_RETRIES,
    )
    search = arxiv.Search(
        query=query,
        max_results=max_results,
        sort_by=arxiv.SortCriterion.SubmittedDate,
    )

    attempt = 0
    results_iter = client.results(search)

    while True:
        try:
            result = next(results_iter)
            attempt = 0  # reset back-off counter on success
            yield {
                "title": result.title,
                "abstract": result.summary,
                "authors": [a.name for a in result.authors],
                "pdf_url": result.pdf_url,
                "arxiv_id": result.entry_id.split("/")[-1],
                "published": result.published,
            }

        except StopIteration:
            # Exhausted all results — normal exit
            break

        except Exception as e:
            err_str = str(e)
            is_429 = "429" in err_str or "Too Many Requests" in err_str.lower()

            if is_429:
                # Exponential back-off: 60s, 120s, 240s …
                wait = ARXIV_429_BACKOFF * (2 ** attempt)
                attempt += 1
                print(f"\n  ⚠️  arxiv 429 — waiting {wait}s before retry "
                      f"(attempt {attempt}) ...")
                time.sleep(wait)
                # Re-create the iterator from scratch; the client will resume
                # from the next page thanks to its internal offset tracking.
                results_iter = client.results(search)
            else:
                # Non-429 error — log and stop rather than loop forever
                print(f"\n  ❌ arxiv fetch error: {e}")
                break


# ============ EXTRACT EMAILS FROM PDF ============
def extract_emails_from_pdf(pdf_url, max_retries=3):
    headers = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'}
    for attempt in range(max_retries):
        try:
            response = requests.get(pdf_url, timeout=60, headers=headers)
            doc = fitz.open(stream=response.content, filetype="pdf")
            first_page = doc[0].get_text()
            doc.close()
            cleaned = first_page.replace('-\n', '').replace('\n', ' ')
            cleaned = re.sub(r'\s+', ' ', cleaned)
            email_pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
            emails = list(set(re.findall(email_pattern, cleaned)))
            emails = [e for e in emails if len(e.split('@')[1].split('.')) >= 2]
            return emails
        except Exception as e:
            backoff = 5 * (2 ** attempt)
            if attempt < max_retries - 1:
                print(f"  ⚠️ 重试 ({attempt + 1}/{max_retries})，等待{backoff}秒...")
                time.sleep(backoff)
            else:
                print(f"  Error: {e}")
                return []
    return []


def download_pdfs_parallel(papers):
    results = {}
    with ThreadPoolExecutor(max_workers=PDF_WORKERS) as pool:
        futures = {pool.submit(extract_emails_from_pdf, p['pdf_url']): p['arxiv_id'] for p in papers}
        for future in as_completed(futures):
            aid = futures[future]
            try:
                results[aid] = future.result()
            except Exception:
                results[aid] = []
    time.sleep(3)
    return results


# ============ AI FUNCTIONS ============
def analyze_paper_full(paper, emails, client):
    directions_str = ", ".join(ALL_DIRECTIONS)
    prompt = f"""分析这篇论文，返回一个JSON对象。

标题: {paper['title']}
摘要: {paper['abstract'][:800]}
作者: {", ".join(paper['authors'])}
邮箱: {", ".join(emails)}

请完成以下三个任务：

---

## 任务一：邮箱-作者匹配
根据邮箱前缀匹配作者（wzhang→Wei Zhang, zhangwei→Zhang Wei等）。
判断是否中国人：纯拼音名=中国人（Xinhao Wang），混合名=非中国人（David Chen）。
first_name是中文名的拼音（如Xinhao），用于邮件称呼。

---

## 任务二：算力需求判断
从以下六个维度综合分析，判断作者是否需要非平凡的算力支持（即普通笔记本无法完成）。

**方法论信号（强信号）**
- 训练/微调深度学习模型（training、fine-tuning、pre-training）
- 强化学习（RL、RLHF、PPO等）
- 神经架构搜索、超参数大规模搜索
- 蒙特卡洛/分子动力学/有限元/CFD等数值模拟

**模型规模信号（强信号）**
- 提及参数量级（billions、millions of parameters）
- LLM、foundation model、large-scale model
- 多模态、多任务联合训练
- scaling law、scaling up

**数据规模信号（中信号）**
- large-scale dataset、web-scale、internet-scale
- 大量图像/视频/基因组数据处理

**基础设施信号（强信号）**
- GPU、TPU、A100、H100、distributed training、HPC

**实验规模信号（中信号）**
- 大量ablation study、多数据集全面评估

**领域信号（弱信号）**
- 气候/天体模拟、蛋白质折叠、药物发现、自动驾驶感知

**负向信号（降低判断）**
- "training-free"、"without training"、"lightweight"、"efficient"（指资源高效）
- 纯理论推导、综述论文、无实验的框架提案
- 仅"使用"现有模型做推理，不涉及训练
- 小规模定性研究、数学证明类工作
- 体育预测、简单分类任务、小数据集实验

**判断原则：**
1. 关注动词：train/fine-tune/simulate/optimize=强信号；analyze/survey/propose（无实验）=弱信号
2. 区分"提出"和"使用"：仅调用GPT-4 API做实验 ≠ 需要算力
3. compute_level含义：
   - heavy：多卡GPU/HPC集群（大模型预训练、大规模仿真）→ confidence 0.85-1.0
   - moderate：单卡或少量GPU（中等模型微调、中规模实验）→ confidence 0.65-0.85
   - light：普通服务器可满足（小模型训练、小规模模拟）→ confidence 0.5-0.65
   - none：理论/综述/纯数学/小规模定性研究 → needs_compute=false, confidence 0.0-0.4

---

## 任务三：研究方向分类
将论文归入以下27个研究方向之一（选最匹配的1个）：
1.LLM Agents & Multi-Agent  2.LLM Reasoning & Planning  3.LLM Training & Post-training
4.LLM Architecture & Efficiency  5.LLM Safety & Alignment  6.VLM & Multimodal Understanding
7.Diffusion & Image/Video Generation  8.3D Vision & Reconstruction  9.Detection, Segmentation & Tracking
10.VLA & Robot Learning  11.Embodied AI & World Models  12.Autonomous Driving
13.Medical & Life Science AI  14.Science & Engineering AI  15.Remote Sensing & Geospatial
16.Audio, Speech & Music  17.NLP & Text Processing  18.RAG & Information Retrieval
19.Recommendation & Ranking  20.Code & Software Engineering  21.Reinforcement Learning
22.Time Series & Spatio-temporal  23.Graph & Network Learning  24.Privacy, Security & Federated
25.Representation & Transfer Learning  26.Benchmarks & Evaluation  27.Other
注意："safety"指训练稳定性=3不是5；RLHF/DPO训练LLM=3不是21；LLM持续学习=3不是25

## 任务四：Portfolio方向匹配
从列表中找出最相关的2-3个方向（必须完全匹配列表名称，无匹配则返回空列表）。
方向列表：{directions_str}

---

只返回JSON，不要其他文字：
{{
  "email_matches": [
    {{"email": "xx@xx.edu", "author": "全名或null", "is_chinese": true/false, "first_name": "名或null"}}
  ],
  "needs_compute": true/false,
  "compute_confidence": 0.0-1.0,
  "compute_level": "heavy/moderate/light/none",
  "compute_reason": "一句话原因，需引用摘要中的具体证据",
  "research_direction": "方向名称（从27个中选1个）",
  "matched_directions": ["方向1", "方向2"]
}}"""

    # Gemini via MiraclePlus proxy.
    # Flash is primary (3s vs 30s latency, quality on par with Pro for this
    # prompt per /bench). gemini-2.5-pro is the fallback — gemini-3-pro-preview
    # was retired by the proxy and now returns deprecation strings as 200 OK.
    raw = None
    meta = None
    used_model = "gemini-3-flash"
    try:
        raw, meta = llm_chat(
            "gemini-3-flash", prompt,
            system="你是一个AI论文分析专家，只返回 JSON 对象。",
            temperature=0.1, max_tokens=2500, response_format_json=True,
            timeout=60,
        )
    except LLMError as e:
        print(f"  ℹ️  gemini-3-flash unavailable ({e}), falling back to gemini-2.5-pro")
        used_model = "gemini-2.5-pro"
        try:
            raw, meta = llm_chat(
                "gemini-2.5-pro", prompt,
                system="你是一个AI论文分析专家，只返回 JSON 对象。",
                temperature=0.1, max_tokens=2500, response_format_json=True,
                timeout=60,
            )
        except LLMError as e2:
            print(f"  ⚠️ Gemini fallback also failed: {e2} [reason=both_models_down]")
            return None
    if meta and meta.get("finish_reason") == "length":
        print(f"  ⚠️ {used_model} hit max_tokens — JSON likely truncated [reason=length_truncation]")

    try:
        result = parse_llm_json(raw, None, _ctx=used_model)
        if result is None:
            print(f"  ⚠️ analyze_paper_full: JSON parse returned None [reason=parse_failed model={used_model}]")
            return None
        if 'matched_directions' in result:
            result['matched_directions'] = [d for d in result['matched_directions'] if d in ALL_DIRECTIONS][:3]
        else:
            result['matched_directions'] = []
        # Validate research_direction
        valid_dirs = set(DIRECTION_CVR_WEIGHTS.keys())
        if result.get('research_direction') not in valid_dirs:
            result['research_direction'] = 'Other'
        return result
    except Exception as e:
        print(f"  ⚠️ analyze_paper_full error [reason=postprocess_exception model={used_model}]: {type(e).__name__}: {e}")
        return None


# ============ SCHOOL INFO ============
def get_school_info(email):
    domain = email.split('@')[-1].lower()
    if domain in SCHOOL_DATA:
        return SCHOOL_DATA[domain]
    parts = domain.split('.')
    for i in range(len(parts)):
        partial = '.'.join(parts[i:])
        if partial in SCHOOL_DATA:
            return SCHOOL_DATA[partial]
    return None


# ============ TRAINING DATA COLLECTION ============
def get_best_institution_tier(emails):
    best = 3
    for email in emails:
        info = get_school_info(email)
        if info:
            best = min(best, info.get('tier', 3))
    return best


def log_training_example(paper, emails, analysis):
    compute_level = analysis.get('compute_level', 'none')
    example = {
        "arxiv_id": paper['arxiv_id'],
        "title": paper['title'],
        "abstract": paper['abstract'][:800],
        "categories": paper.get('categories', []),
        "author_count": len(paper['authors']),
        "label": 1 if (analysis.get('needs_compute') and
                       analysis.get('compute_confidence', 0) > 0.6 and
                       compute_level in ('heavy', 'moderate')) else 0,
        "gemini_confidence": analysis.get('compute_confidence', 0),
        "compute_level": compute_level,
        "gemini_reason": analysis.get('compute_reason', ''),
        "has_limitation_language": any(w in paper['abstract'].lower() for w in [
            'limited compute', 'resource constraint', 'single gpu',
            'limited resources', 'future work', 'larger scale'
        ]),
        "institution_tier": get_best_institution_tier(emails),
        "timestamp": datetime.now().isoformat(),
    }
    with open(TRAINING_FILE, 'a') as f:
        f.write(json.dumps(example, ensure_ascii=False) + "\n")


# ============ EMAIL SANITIZATION HELPERS ============
def sanitize_gemini_output(text):
    text = text.strip().strip('"').strip('\u201c').strip('\u201d')
    text = re.sub(r'\*{1,3}(.+?)\*{1,3}', r'\1', text)
    text = text.replace('`', '')
    text = re.sub(r'^[-•]\s*', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def sanitize_personalized_intro(text):
    text = sanitize_gemini_output(text)
    text = re.sub(r'[（(][^）)]*(?:个字|字以内|以内|注意|格式|例子|option|段论)[^）)]*[）)]', '', text)
    text = re.sub(r'[（(]\d+个?字[）)]', '', text)
    text = re.sub(r'，\s*，', '，', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def safe_html(text):
    return html_lib.escape(str(text), quote=True)


def truncate_subject(subject, max_len=200):
    if len(subject) <= max_len:
        return subject
    return subject[:max_len - 3].rsplit(' ', 1)[0] + "..."


# ============ GENERATE EMAIL ============
APPLY_URL_CTA = "https://apply.miracleplus.com/?p=gpu&c=ib&r=4Xq0R&utm_source=em"
WECHAT_ARTICLE_URL = "https://mp.weixin.qq.com/s/Ad7rKWbEc87Tq92DTfcI-g"


def generate_third_paragraph(school_info, matched_directions):
    base_info = "单项目最高支持100万等值算力，相当于8卡H100连续跑15个月"
    if school_info:
        count, name, tier = school_info['count'], school_info['name'], school_info.get('tier', 3)
        if count >= 20:
            school_text = f"过去一年中，我们支持了超过20位来自{name}的researcher"
        elif count >= 15:
            school_text = f"过去一年中，我们支持了接近20位来自{name}的researcher"
        elif count >= 5:
            school_text = f"过去一年中，我们支持了{count}位来自{name}的researcher"
        else:
            if tier == 1:
                school_text = f"过去一年中，我们支持了70+来自{name}、MIT、清华、北大等高校的项目"
            else:
                school_text = f"过去一年中，我们支持了70+来自MIT、清华、{name}等高校的项目"
    else:
        school_text = "过去一年中，我们支持了70+前沿项目"
    if len(matched_directions) >= 2:
        directions_text = f"，已经支持的研究方向包括{'、'.join(matched_directions)}等"
    else:
        directions_text = ""
    return (
        f"{safe_html(school_text)}（{safe_html(base_info)}）{safe_html(directions_text)}。"
        f"奇绩算力的特点是审核严格（通过率约1.5%），但额度较多，且完全免费"
        f"（不占股，不要求署名，详见 {WECHAT_ARTICLE_URL} ）。"
    )


def generate_email(paper, client, to_email, author_analysis, matched_directions):
    first_name = author_analysis.get('first_name')
    greeting = f"{safe_html(first_name)}你好，" if first_name else "你好，"

    school_info = get_school_info(to_email)
    if school_info:
        print(f"    🏫 学校: {school_info['name']} ({school_info['count']}人)")
    if matched_directions:
        print(f"    🔬 方向: {', '.join(matched_directions)}")

    prompt = f"""根据论文写一句个性化开头（1句话）。

标题: {paper['title']}
摘要: {paper['abstract'][:1000]}

格式：最近在跟踪A方向的研究时，读到你的X paper，其中用Y方法（不要超过8个字）解决Z问题（9个字以内）的方案很有启发。如果能有更多算力支持，相信可以（提供更多insights，更大程度上验证方法的普适性等，这里可以看一下作者可能希望做到的事情，写一下如果有更多算力做到什么）。

**任何情况下，严禁出现""，*，//，%，$等任何符号**

注意：
1. A方向
- 这里需要找一个相对大一些的领域（e.g. Dyna网状Web agent架构 -> Web Agent方向研究）
- 第二个例子：Principle-Evolvable Scientific Discovery via Uncertainty Minimization -> AI4S相关
- 此外，要学会使用更加常用的表达（e.g. Offline Reinforcement Learning就说Offline RL，不要说离线强化学习）

错误例子：
- 最近在跟踪RAG查询优化研究 - 不像人话
- 推荐系统解释性 - 应该是推荐系统可解释性，人类不会说"解释性"这种词，而是"可解释性"

正确例子：
- 最近在整理可解释性领域的最新进展
- 最近在跟踪Agentic RL相关的研究
- 最近在跟踪持续学习方向的工作

2. X paper
- 如果论文标题是 xx: xxxx，那么用：前面的部分即可 （e.g. RobustExplain: Evaluating Robustness of LLM-Based Explanation Agents for Recommendation -> RobustExplain paper)
- 如果论文标题没有冒号，直接用《完整标题》，e.g. 读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用...
- 如果论文标题过长（超过10个英文单词），可以简化为"你的关于YYY的论文"，YYY是论文的核心内容，不直接用标题。

3. Y方法解决Z问题 - 不要超过12个字
- option a: 基于Y方法，解决Z问题
- option b: 解释了xx现象 / 深入分析了xx问题 / 揭示了xx机制

**注意：一定是三段论，每一个部分中间有逗号（最近在...，读到了...，其中）**

正确例子：
- 最近在跟踪持续学习方向的工作，读到了你的关于平衡模型稳定性和可塑性的论文，揭示了经验回放(ER)在不同任务上的二元性，很有启发。文中指出了经验回放会导致代码生成等结构化任务的负迁移，如果能在更大规模的模型上验证，相信能提供更多关于持续学习的 insights。
- 最近在跟踪可解释性相关研究时，读到你的《Interpreting Emergent Extreme Events in Multi-Agent Systems》，其中用基于Shapley值进行多维度归因的方法解决解释multi-agent system涌现极端事件的方案很有启发。
- 最近在跟踪Web Agent相关研究时，读到你的DynaWeb paper，其中通过学习一个网络世界模型作为合成环境的方案很有启发。

只返回这一句话。"""

    # Gemini via MiraclePlus proxy. Flash primary, gemini-2.5-pro fallback
    # (gemini-3-pro-preview was retired — see analyze_paper_full).
    try:
        raw_text, _meta = llm_chat(
            "gemini-3-flash", prompt,
            system="你是一名销售，针对 AI 论文作者写一句中文个性化开场白。",
            temperature=0.7, max_tokens=800, timeout=45,
        )
    except LLMError as e:
        print(f"    ℹ️  gemini-3-flash unavailable ({e}), falling back to gemini-2.5-pro")
        try:
            raw_text, _meta = llm_chat(
                "gemini-2.5-pro", prompt,
                system="你是一名销售，针对 AI 论文作者写一句中文个性化开场白。",
                temperature=0.7, max_tokens=800, timeout=45,
            )
        except LLMError as e2:
            print(f"    ⚠️ Gemini fallback also failed ({e2}), 用 fallback intro")
            raw_text = f"最近在跟踪 AI 算力相关的研究方向时，读到了您团队的工作，其中的方法很有启发。"
    personalized_intro = sanitize_personalized_intro(raw_text)
    personalized_intro_html = safe_html(personalized_intro)

    third_paragraph = generate_third_paragraph(school_info, matched_directions)
    full_title = paper['title'].replace('\n', ' ').strip()
    closing_name = safe_html(first_name) if first_name else "你"
    subject = truncate_subject(f"Invitation to Apply - {full_title}的潜在算力支持机会")

    # Rep identity is filled server-side by /api/pipeline/import from the
    # assigned_rep row — {{REP_NAME}} and {{REP_WECHAT}} are literal
    # placeholders, not Python f-string interpolations.
    body_html = f"""<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; font-size: 14px; line-height: 1.8; color: #333;">
{greeting}<br><br>
{personalized_intro_html}<br><br>
我是奇绩创坛的{{{{REP_NAME}}}}。针对具备高潜力的前沿科研项目，奇绩算力计划目前正开放新一轮的申请，希望能通过免费算力，将科研的固定成本转变为边际成本，助力前沿想法的快速验证。<br><br>
{third_paragraph}<br><br>
如果{closing_name}对算力支持感兴趣，欢迎<a href="{APPLY_URL_CTA}">申请</a>或加我微信交流（{{{{REP_WECHAT}}}}）。<br><br>
<span style="font-size: 14px; color: #333; line-height: 1.6;">{{{{REP_NAME}}}}<br>奇绩创坛</span>
</body></html>"""

    return {"subject": subject, "body_html": body_html}


# ============ RESEND EMAIL SENDER ============
def send_email_resend(to_email, subject, body_html):
    payload = {
        "from": f"{SENDER_NAME} <{SENDER_EMAIL}>",
        "to": [to_email],
        "bcc": ["williamxwang03@gmail.com"],
        "subject": subject,
        "html": body_html,
    }
    try:
        resp = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=15,
        )
        if resp.status_code in (200, 201):
            return True
        else:
            print(f"  ❌ Resend error {resp.status_code}: {resp.text}")
            return False
    except Exception as e:
        print(f"  ❌ Resend request failed: {e}")
        return False


# ============ USER OPTIONS ============
def get_user_options():
    print("=" * 50)
    print("⚙️  配置选项")
    print("=" * 50)

    # Non-interactive overrides for automated runs.
    # EMAIL_LIMIT=<int>, MODE=Q|S, SKIP_CONFIRM=1
    env_limit = os.environ.get("EMAIL_LIMIT")
    env_mode = os.environ.get("MODE", "").strip().upper()
    if env_limit is not None and env_mode:
        try:
            email_limit = int(env_limit)
        except ValueError:
            email_limit = None
        queue_only = env_mode == "Q"
        print(f"   → (env) limit={email_limit}, mode={'Q' if queue_only else 'S'}")
        print("=" * 50 + "\n")
        return email_limit, queue_only

    count_input = input("📧 生成多少封邮件？(直接回车=所有新论文): ").strip()
    if count_input == "":
        email_limit = None
        print("   → 将处理到上次checkpoint为止的所有新论文")
    else:
        try:
            email_limit = int(count_input)
            print(f"   → 最多生成 {email_limit} 封邮件")
        except:
            email_limit = None
            print("   → 输入无效，将处理所有新论文")

    mode_input = input("\n📬 模式选择: [S]end直接发送 / [Q]ueue推送到Mail系统 (S/Q): ").strip().upper()
    queue_only = mode_input == 'Q'

    if queue_only:
        print("   → Queue模式：生成draft后推送到Mail系统，不直接发送")
        print(f"     Mail系统将根据paper发布时间自动调度发送")
    else:
        confirm = input("\n⚠️  确认直接发送所有邮件？(y/N): ").strip().lower()
        if confirm != 'y':
            print("   → 已取消，退出")
            exit(0)

    print("=" * 50 + "\n")
    return email_limit, queue_only


# ============ LOCAL SCORER ============
def load_local_scorer():
    """Load the trained scorer bundle. Returns (scorer, None) for backward
    compat with the old (embedder, clf) return shape; v2 bundles both."""
    model_dir = SCRIPT_DIR / "scorer_model"
    if not (model_dir / "classifier.pkl").exists():
        print("  No local scorer found, using Gemini only")
        return None, None
    try:
        import pickle as pkl  # local model serialization
        with open(model_dir / "classifier.pkl", "rb") as f:
            scorer = pkl.load(f)
        meta_path = model_dir / "metadata.json"
        if meta_path.exists():
            meta = json.load(open(meta_path))
            print(
                f"  Local scorer loaded "
                f"(F1={meta.get('cv_f1_mean', 0):.3f}, "
                f"n={meta.get('n_samples', '?')}, "
                f"{meta.get('classifier', 'logreg')})"
            )
        else:
            print("  Local scorer loaded")
        return scorer, None
    except ModuleNotFoundError as e:
        print(f"  Scorer load failed: missing dependency '{e.name}'. "
              f"Run: python3 -m pip install {e.name}")
        return None, None
    except Exception as e:
        print(f"  Scorer load failed: {type(e).__name__}: {e}")
        return None, None


def score_paper(scorer, _legacy_clf, title, abstract):
    """Score a paper. Returns score 0-1 or None.

    Two-arg signature kept for backward compat with v1 (embedder, clf) call
    sites. v2 ScorerV2 bundles both; the second arg is ignored unless the
    loaded object is a legacy sklearn classifier.
    """
    if scorer is None:
        return None
    if hasattr(scorer, "score"):
        return scorer.score(title, abstract)["binary_prob"]
    # v1 fallback: bare sklearn classifier with separate embedder.
    text = f"{title} [SEP] {abstract}"
    emb = _legacy_clf.encode([text])
    prob = scorer.predict_proba(emb)[0]
    return float(prob[1])


# ============ MAIN ============
def main():
    email_limit, queue_only = get_user_options()

    # Pick age gate based on mode. Send mode hits Resend directly, so Python
    # must enforce the 7-day gate here. Queue mode defers it to the web API,
    # which applies the 7-day gate at click-Send time.
    global MIN_AGE_DAYS
    MIN_AGE_DAYS = MIN_AGE_DAYS_QUEUE if queue_only else MIN_AGE_DAYS_SEND

    # LLM clients are no longer instantiated here — analyze_paper_full() and
    # generate_email() use llm_chat() (MiraclePlus proxy) directly. The
    # `client` arg is kept for backward-compat in their signatures but unused.
    gemini_scanner = None
    gemini_emailer = None

    # Load local scorer (optional — enhances Gemini's judgment)
    scorer_embedder, scorer_clf = load_local_scorer()

    email_history = load_email_history()
    email_history = reconcile_history_from_supabase(email_history)
    # Replay any leads from previous runs whose import POST failed (e.g.
    # Vercel edge 403s). Done before scanning so we don't mix old failures
    # with new ones in the queue file.
    drain_import_retry_queue()
    checkpoint = load_checkpoint()
    processed = load_processed()
    last_checkpoint_id = checkpoint.get('last_arxiv_id')

    lead_queue = Queue()
    stop_event = threading.Event()
    scanner_done = threading.Event()

    stats = {
        'newest_id': None,
        'papers_checked': 0,
        'papers_skipped': 0,
        'papers_no_chinese': 0,
        'papers_too_new': 0,
        'leads_found': 0,
        'emails_done': 0,
        'training_logged': 0,
    }

    print(f"📁 历史记录: {HISTORY_FILE}")
    print(f"📍 Checkpoint: {last_checkpoint_id or '无（首次运行）'}")
    print(f"📋 已处理: {len(processed)} 篇论文")
    print(f"🔬 类别: {', '.join(CATEGORIES)}")
    print(f"🧠 训练数据: {TRAINING_FILE}")
    print(f"⏳ 最低论文年龄: {MIN_AGE_DAYS} 天")
    if VERCEL_BYPASS_SECRET:
        print(f"🛡️  Vercel bypass secret: SET (length={len(VERCEL_BYPASS_SECRET)})")
    else:
        print(f"🛡️  Vercel bypass secret: NOT SET (export VERCEL_AUTOMATION_BYPASS_SECRET if 403s persist)")
    if email_limit is None:
        if last_checkpoint_id:
            print(f"📊 模式: 处理所有新论文（到checkpoint为止）")
        else:
            print(f"📊 模式: 首次运行，最多扫描 {MAX_PAPERS} 篇")
    else:
        print(f"📊 模式: 最多生成 {email_limit} 封邮件")
    print(f"🧵 并行: Scanner + Emailer 双线程, PDF下载 {PDF_WORKERS} 并发")
    print(f"📤 发送方式: Resend API ({SENDER_EMAIL})")
    print(f"📄 开始扫描...\n")

    # ==========================================
    # SCANNER THREAD
    # ==========================================
    def scanner():
        try:
            batch = []

            for paper in fetch_papers(CATEGORIES, MAX_PAPERS):
                if stop_event.is_set():
                    print(f"\n   🛑 邮件上限已达，停止扫描")
                    break

                arxiv_id = paper['arxiv_id']

                if stats['newest_id'] is None:
                    stats['newest_id'] = arxiv_id

                if last_checkpoint_id and arxiv_id == last_checkpoint_id:
                    print(f"\n   📍 到达checkpoint（跳过 {stats['papers_skipped']} 篇已处理）")
                    if email_limit is None:
                        print(f"   📊 所有新论文已扫描")
                        break
                    else:
                        print(f"   📊 N模式: 继续扫描旧论文凑够 {email_limit} 封...")

                if arxiv_id in processed:
                    stats['papers_skipped'] += 1
                    continue

                # ---- AGE FILTER ----
                # Pass arxiv_id as fallback in case result.published is None
                if not is_paper_old_enough(paper.get('published'), arxiv_id=arxiv_id):
                    stats['papers_too_new'] += 1
                    continue

                stats['papers_checked'] += 1
                n = stats['papers_checked']

                paper['title'] = clean_title(paper['title'])
                has_invalid, invalid_char = has_invalid_characters(paper['title'])
                if has_invalid:
                    print(f"[{n}] {paper['title'][:55]}...")
                    print(f"  ⏭️ 跳过（标题含非法字符: '{invalid_char}'）\n")
                    processed.add(arxiv_id)
                    continue

                processed.add(arxiv_id)

                if not likely_has_chinese_author(paper['authors']):
                    stats['papers_no_chinese'] += 1
                    continue

                print(f"[{n}] {paper['title'][:55]}...")
                batch.append(paper)

                if len(batch) >= PDF_BATCH_SIZE:
                    process_batch(batch, gemini_scanner, email_history, lead_queue, stats, stop_event)
                    batch = []

                if stats['papers_checked'] % 20 == 0:
                    save_processed(processed)

            if batch and not stop_event.is_set():
                process_batch(batch, gemini_scanner, email_history, lead_queue, stats, stop_event)

        except Exception as e:
            print(f"\n   ❌ Scanner异常: {e}")
        finally:
            scanner_done.set()
            lead_queue.put(None)

    def process_batch(batch, gemini_client, email_history, lead_queue, stats, stop_event):
        pdf_results = download_pdfs_parallel(batch)
        save_processed(processed)
        if stats['newest_id']:
            save_checkpoint(stats['newest_id'])

        for paper in batch:
            if stop_event.is_set():
                break

            emails = pdf_results.get(paper['arxiv_id'], [])
            if not emails:
                print(f"  ⏭️ {paper['title'][:40]}... 无邮箱\n")
                continue

            new_emails = [e for e in emails if not was_contacted_this_year(e, email_history)]
            skipped_count = len(emails) - len(new_emails)

            if not new_emails:
                print(f"  📧 {paper['title'][:40]}... 跳过{skipped_count}个已联系\n")
                continue

            analysis = analyze_paper_full(paper, new_emails, gemini_client)
            if analysis is None:
                # One retry — most "AI分析失败" cases are transient (proxy
                # connect-timeout, single bad JSON gen). llm_client already
                # retries network/5xx internally; this catches the residual
                # "model returned malformed JSON" case.
                print(f"  🔁 AI分析返回 None, 重试一次 (arxiv_id={paper.get('arxiv_id')})")
                analysis = analyze_paper_full(paper, new_emails, gemini_client)
            if analysis is None:
                print(f"  ⚠️ AI分析失败，跳过 (arxiv_id={paper.get('arxiv_id')})\n")
                continue

            log_training_example(paper, new_emails, analysis)
            stats['training_logged'] += 1

            valid_email = None
            valid_match = None
            for match in analysis.get('email_matches', []):
                if match.get('author') and match.get('is_chinese'):
                    valid_email = match['email']
                    valid_match = match
                    print(f"  🇨🇳 中国作者: {match['author']} <{match['email']}>")
                    break
                elif match.get('author') and not match.get('is_chinese'):
                    print(f"  ⏭️ {match['email']} → {match['author']}（非中国人）")

            if not valid_email:
                print(f"  ⏭️ 跳过（无中国作者邮箱）\n")
                continue

            conf = float(analysis.get('compute_confidence', 0))
            needs = analysis.get('needs_compute', False)
            compute_level = analysis.get('compute_level', 'none')
            research_direction = analysis.get('research_direction', 'Other')

            # Direction-based confidence adjustment (from Q1 funnel analysis)
            dir_weight = get_direction_weight(research_direction)
            adjusted_conf = min(1.0, max(0.0, conf + dir_weight))

            # Local scorer (if available)
            local_score = score_paper(scorer_embedder, scorer_clf, paper['title'], paper['abstract'][:800])
            if local_score is not None:
                print(f"  🤖 Gemini: {needs} | {compute_level} | {conf:.0%}  |  Scorer: {local_score:.0%}")
            else:
                print(f"  🤖 需要算力: {needs} | level={compute_level} | conf={conf:.0%}")
            if dir_weight != 0:
                print(f"  📊 方向: {research_direction} (weight {dir_weight:+.2f} → adj conf {adjusted_conf:.0%})")

            if not (needs and adjusted_conf > 0.6 and compute_level in ('heavy', 'moderate')):
                print(f"  ⏭️ 跳过（level={compute_level}, conf={conf:.0%}, adj={adjusted_conf:.0%}）\n")
                continue

            stats['leads_found'] += 1
            print(f"  ✅ LEAD #{stats['leads_found']} → 排队生成邮件\n")

            lead_queue.put({
                **paper,
                "validated_email": valid_email,
                "author_analysis": valid_match,
                "all_email_matches": analysis.get('email_matches', []),
                "compute_level": analysis.get('compute_level', 'none'),
                "compute_confidence": analysis.get('compute_confidence', 0),
                "adjusted_confidence": adjusted_conf,
                "compute_reason": analysis.get('compute_reason', ''),
                "local_score": local_score,
                "research_direction": research_direction,
                "direction_weight": dir_weight,
                "matched_directions": analysis.get('matched_directions', []),
            })

            if email_limit and stats['leads_found'] >= email_limit:
                stop_event.set()
                break

    # ==========================================
    # EMAILER THREAD
    # ==========================================
    emailed_papers = set()

    def emailer():
        while True:
            try:
                lead = lead_queue.get(timeout=10)
            except Empty:
                if scanner_done.is_set():
                    break
                continue

            if lead is None:
                break

            # Outer try: ANY unhandled exception in this iteration is logged
            # and the loop continues. Without this a single bad lead kills
            # the whole emailer thread (silently — scanner keeps queuing
            # leads, none get processed).
            try:
                paper_id = lead.get('arxiv_id')
                if paper_id in emailed_papers:
                    print(f"  ⏭️ 跳过（已为该论文联系过作者）: {lead['title'][:40]}...\n")
                    continue
                emailed_papers.add(paper_id)

                to_email = lead['validated_email']
                author_analysis = lead['author_analysis']
                author_name = author_analysis.get('author', '?')
                matched_directions = lead.get('matched_directions', [])

                print(f"  📝 生成邮件: {lead['title'][:45]}...")
                print(f"    👤 作者: {author_name} <{to_email}>")

                try:
                    email_content = generate_email(lead, gemini_emailer, to_email, author_analysis, matched_directions)
                except Exception as e:
                    print(f"    ❌ 邮件生成失败: {e}\n")
                    continue

                print(f"    📨 Subject: {email_content['subject'][:50]}...")

                if queue_only:
                    # Queue mode: push to Mail system, don't send directly.
                    try:
                        success = queue_to_mail_system(
                            lead, to_email, author_analysis,
                            email_content['subject'], email_content['body_html']
                        )
                    except Exception as _e:
                        print(f"    ❌ Queue threw: {type(_e).__name__}: {_e}")
                        success = False

                    if success:
                        stats['emails_done'] += 1
                        record_email(to_email, lead['title'], email_history,
                                    subject=email_content['subject'],
                                    body_html=email_content['body_html'])
                        print(f"    ✅ Queued (#{stats['emails_done']})\n")
                    else:
                        print(f"    ⏳ Queue failed; sleep 5s and continue with next lead...")
                        time.sleep(5)
                else:
                    # Send mode: send directly via Resend
                    success = send_email_resend(to_email, email_content['subject'], email_content['body_html'])

                    if success:
                        stats['emails_done'] += 1
                        record_email(to_email, lead['title'], email_history,
                                    subject=email_content['subject'],
                                    body_html=email_content['body_html'])
                        try:
                            sync_to_dashboard(lead, to_email, author_analysis, email_content['subject'], body_html=email_content['body_html'])
                        except Exception as e:
                            print(f"    ⚠️ Dashboard sync failed (non-blocking): {e}")
                        print(f"    ✅ 发送完成 (#{stats['emails_done']})\n")
                        time.sleep(2)
                    else:
                        print(f"    ⏳ 发送失败，等待30秒后继续...")
                        time.sleep(30)

                if email_limit and stats['emails_done'] >= email_limit:
                    print(f"\n   📊 已达到 {email_limit} 封上限")
                    stop_event.set()
                    break
            except Exception as _outer:
                import traceback as _tb
                print(f"    ❌ Emailer iteration error: {type(_outer).__name__}: {_outer}")
                _tb.print_exc()

    # ==========================================
    # START THREADS
    # ==========================================
    scanner_thread = threading.Thread(target=scanner, name="Scanner", daemon=True)
    emailer_thread = threading.Thread(target=emailer, name="Emailer", daemon=True)

    scanner_thread.start()
    emailer_thread.start()

    scanner_thread.join()
    emailer_thread.join()

    # ==========================================
    # SAVE STATE
    # ==========================================
    if stats['newest_id']:
        save_checkpoint(stats['newest_id'])
    save_processed(processed)

    print()
    print("=" * 50)
    print(f"📍 更新checkpoint: {stats['newest_id']}")
    print(f"💾 已处理论文: {len(processed)} 篇")
    print(f"🔍 本次扫描: {stats['papers_checked']} 篇")
    print(f"⏳ 跳过（发布<{MIN_AGE_DAYS}天）: {stats['papers_too_new']} 篇")
    print(f"🚫 姓氏预筛跳过: {stats['papers_no_chinese']} 篇")
    print(f"🎯 找到leads: {stats['leads_found']} 个")
    print(f"✨ 发送: {stats['emails_done']} 封邮件")
    print(f"🧠 训练样本记录: {stats['training_logged']} 条")
    print(f"📊 历史联系: {len(email_history)} 人")
    print("=" * 50)


if __name__ == "__main__":
    main()
    