// Mirror of BENCH_SAMPLES in src/lib/bench.ts — the client needs the paper
// titles + abstracts to render the left pane. Keep in sync when the server
// sample list changes.

export const SAMPLES = [
  {
    title: "4D Gaussian Splatting for Dynamic Scene Reconstruction",
    abstract:
      "We present 4D Gaussian Splatting (4DGS) that extends 3D Gaussians to the temporal dimension, enabling photorealistic novel-view synthesis of dynamic scenes from sparse monocular video. Our approach decomposes time into a temporal radiance field driven by anisotropic Gaussians; training takes 4 hours on 8 A100 GPUs.",
    authors: ["Xiang Li", "Yifan Wang", "Jianbo Jiao", "Andrew Markham"],
    emails: ["xli2024@cs.tsinghua.edu.cn", "y.wang@cs.tsinghua.edu.cn"],
    truth: {
      compute: "heavy (8× A100 × 4h)",
      direction: "3D Vision & Reconstruction",
      chinese: true,
    },
  },
  {
    title: "FastInfer: A Distributed Inference Engine for 100B+ MoE Models",
    abstract:
      "FastInfer reduces MoE inference latency by co-locating experts and tokens via learned routing. Deployed on 256 H100s, 3.2× throughput vs vLLM on DeepSeek-V3.",
    authors: ["Zhihao Chen", "Mingyu Liu"],
    emails: ["chen.zhihao@stu.pku.edu.cn"],
    truth: {
      compute: "heavy (256 H100s)",
      direction: "LLM Architecture & Efficiency",
      chinese: true,
    },
  },
  {
    title: "A Survey of Tokenization Strategies for Multilingual NLP",
    abstract:
      "This survey reviews 60 tokenization methods for multilingual NLP, comparing BPE, SentencePiece, and character-level approaches across 30 languages. We propose a taxonomy and identify open research directions. No new models are trained; analysis uses published benchmark numbers.",
    authors: ["Maria Garcia", "John Smith"],
    emails: ["maria.garcia@stanford.edu"],
    truth: {
      compute: "none (survey, no training)",
      direction: "NLP & Text Processing",
      chinese: false,
    },
  },
];
