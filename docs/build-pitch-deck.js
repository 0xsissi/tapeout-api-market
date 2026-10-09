// TAM Pitch Deck Generator
// Target audience: Chinese Web3 VCs
// Style: Dark background, modern tech aesthetic

const pptxgen = require("pptxgenjs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.3" × 7.5"
pres.author = "Tapeout API Market (TAM)";
pres.title = "Tapeout API Market (TAM) - Seed Round Pitch Deck";

// ===== Color Palette =====
const C = {
  bg: "0A0A0A",          // near-black background
  bgAlt: "141414",       // secondary dark
  card: "1C1C1C",        // card bg
  cardAlt: "222222",     // hover card
  border: "2A2A2A",      // subtle divider
  text: "FFFFFF",        // primary text
  textMuted: "B0B0B0",   // secondary text
  textDim: "707070",     // tertiary text
  accent: "FF6B35",      // orange accent
  accentSoft: "FF8A5C",  // lighter orange
  good: "00C896",        // success green
  warn: "FFB800",        // warning yellow
};

// ===== Font Faces =====
const F = {
  hanHeader: "PingFang SC",  // Chinese header
  hanBody: "PingFang SC",    // Chinese body
  mono: "SF Mono",           // code / numbers
  engHeader: "Helvetica",    // English header
};

// ===== Helper functions =====
function addFooter(slide, pageNum, totalPages) {
  slide.addText("TAM · Confidential · 2026", {
    x: 0.5, y: 7.1, w: 8, h: 0.3,
    fontSize: 9, color: C.textDim, fontFace: F.hanBody, margin: 0,
  });
  slide.addText(`${pageNum} / ${totalPages}`, {
    x: 12.0, y: 7.1, w: 0.8, h: 0.3,
    fontSize: 9, color: C.textDim, fontFace: F.mono, align: "right", margin: 0,
  });
}

function addAccentDot(slide, x, y) {
  slide.addShape(pres.shapes.OVAL, {
    x, y, w: 0.18, h: 0.18,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
}

const TOTAL = 17;

// ================================================================
// SLIDE 1: Cover
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Accent stripe on left
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.15, h: 7.5,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });

  // Brand name
  s.addText("TAM", {
    x: 1.0, y: 2.3, w: 11, h: 1.2,
    fontSize: 72, bold: true, color: C.text, fontFace: F.engHeader,
    margin: 0, charSpacing: -2,
  });

  // English tagline
  s.addText("The Market Protocol for AI Agents", {
    x: 1.0, y: 3.5, w: 11, h: 0.6,
    fontSize: 24, color: C.accent, fontFace: F.engHeader, margin: 0,
  });

  // Chinese subtitle
  s.addText("AI 世界的开放交易协议", {
    x: 1.0, y: 4.1, w: 11, h: 0.5,
    fontSize: 18, color: C.textMuted, fontFace: F.hanHeader, margin: 0,
  });

  // Round label (bottom-left)
  s.addText("Seed Round · 2026", {
    x: 1.0, y: 6.7, w: 4, h: 0.4,
    fontSize: 12, color: C.textDim, fontFace: F.engHeader, margin: 0,
  });

  // Confidential label (bottom-right)
  s.addText("Strictly Confidential", {
    x: 9.0, y: 6.7, w: 3.5, h: 0.4,
    fontSize: 12, color: C.textDim, fontFace: F.engHeader, align: "right", margin: 0,
  });
}

// ================================================================
// SLIDE 2: The 2030 Question
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Small eyebrow
  s.addText("一个无法忽视的判断", {
    x: 0.8, y: 0.6, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  // Title
  s.addText("2030 年，AI 服务的最大买家不是人。", {
    x: 0.8, y: 1.2, w: 12, h: 1.0,
    fontSize: 36, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Main statement area
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 2.6, w: 11.7, h: 3.3,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });

  s.addText("每天将有千万级 AI Agent", {
    x: 1.2, y: 2.9, w: 11, h: 0.7,
    fontSize: 28, color: C.textMuted, fontFace: F.hanHeader, margin: 0,
  });

  s.addText("自主调用 AI 服务", {
    x: 1.2, y: 3.6, w: 11, h: 0.7,
    fontSize: 28, color: C.textMuted, fontFace: F.hanHeader, margin: 0,
  });

  s.addText("它们不能 KYC。没有信用卡。不会处理纠纷。", {
    x: 1.2, y: 4.5, w: 11, h: 0.5,
    fontSize: 18, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });

  s.addText("谁来做这个市场的基础设施？", {
    x: 1.2, y: 5.2, w: 11, h: 0.6,
    fontSize: 26, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  s.addText("这不是 10 年后的问题。是未来 2-3 年的必然。", {
    x: 0.8, y: 6.3, w: 12, h: 0.4,
    fontSize: 13, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });

  addFooter(s, 2, TOTAL);
}

// ================================================================
// SLIDE 3: One-Line
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("我们在做什么", {
    x: 0.8, y: 0.6, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("TAM · 一句话", {
    x: 0.8, y: 1.1, w: 12, h: 0.7,
    fontSize: 32, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Big statement
  s.addText([
    { text: "一个让任何 AI 供给方和任何买家（包括 AI Agent）", options: { breakLine: true, color: C.text } },
    { text: "可以直接交易、链上结算、无需许可", options: { breakLine: true, color: C.accent, bold: true } },
    { text: "的开放市场协议", options: { color: C.text } },
  ], {
    x: 0.8, y: 2.2, w: 11.7, h: 2.0,
    fontSize: 28, fontFace: F.hanHeader, margin: 0, paraSpaceAfter: 4,
  });

  // Three-column architecture diagram
  const colY = 4.6;
  const colH = 2.0;
  const colW = 3.5;

  // Supply column
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: colY, w: colW, h: colH,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("供给方", {
    x: 0.8, y: colY + 0.15, w: colW, h: 0.4,
    fontSize: 16, bold: true, color: C.accent, fontFace: F.hanHeader, align: "center", margin: 0,
  });
  s.addText([
    { text: "官方 API 账号", options: { breakLine: true } },
    { text: "闲置订阅额度", options: { breakLine: true } },
    { text: "自托管开源模型", options: { breakLine: true } },
    { text: "私有 GPU 节点", options: {} },
  ], {
    x: 1.0, y: colY + 0.6, w: colW - 0.4, h: colH - 0.7,
    fontSize: 13, color: C.textMuted, fontFace: F.hanBody, align: "center", paraSpaceAfter: 6, margin: 0,
  });

  // Protocol column (middle, highlighted)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 4.9, y: colY, w: colW, h: colH,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
  s.addText("TAM 协议", {
    x: 4.9, y: colY + 0.15, w: colW, h: 0.4,
    fontSize: 16, bold: true, color: C.text, fontFace: F.hanHeader, align: "center", margin: 0,
  });
  s.addText([
    { text: "发现 · 路由", options: { breakLine: true } },
    { text: "链上结算", options: { breakLine: true } },
    { text: "信誉系统", options: { breakLine: true } },
    { text: "（规则上链，无运营方）", options: { italic: true } },
  ], {
    x: 5.1, y: colY + 0.6, w: colW - 0.4, h: colH - 0.7,
    fontSize: 13, color: C.text, fontFace: F.hanBody, align: "center", paraSpaceAfter: 6, margin: 0,
  });

  // Demand column
  s.addShape(pres.shapes.RECTANGLE, {
    x: 9.0, y: colY, w: colW, h: colH,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("买家", {
    x: 9.0, y: colY + 0.15, w: colW, h: 0.4,
    fontSize: 16, bold: true, color: C.accent, fontFace: F.hanHeader, align: "center", margin: 0,
  });
  s.addText([
    { text: "全球开发者", options: { breakLine: true } },
    { text: "企业应用", options: { breakLine: true } },
    { text: "AI Agent（机器客户）", options: { breakLine: true } },
    { text: "受限地区用户", options: {} },
  ], {
    x: 9.2, y: colY + 0.6, w: colW - 0.4, h: colH - 0.7,
    fontSize: 13, color: C.textMuted, fontFace: F.hanBody, align: "center", paraSpaceAfter: 6, margin: 0,
  });

  addFooter(s, 3, TOTAL);
}

// ================================================================
// SLIDE 4: Three Excluded Groups
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("市场空白", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("三类被当前市场拒之门外的参与者", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Three columns
  const columns = [
    {
      title: "被拒绝的供给方",
      stat: "$7 亿",
      statLabel: "年化潜在闲置变现市场",
      points: [
        "~200 万 ChatGPT Team 座席\n月均闲置 $30",
        "私人自托管 Llama / Qwen\n进不了中心化聚合器",
        "供给侧合规门槛过高",
      ],
    },
    {
      title: "被拒绝的买家",
      stat: "$10 亿+",
      statLabel: "仅中国开发者年 API 支出",
      points: [
        "14 亿成年人无银行账户",
        "20 亿人口受支付渠道限制",
        "不是没钱，是支付通道被切断",
      ],
    },
    {
      title: "全新的参与者",
      stat: "1 亿+",
      statLabel: "2027 年 AI Agent 日活预测",
      points: [
        "Agent 无法 KYC、无信用卡",
        "中心化平台天然排除",
        "小额、高频、无人值守",
      ],
    },
  ];

  columns.forEach((col, i) => {
    const x = 0.8 + i * 4.15;
    const w = 3.9;
    const y = 2.0;
    const h = 4.5;

    // Card background
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Top accent line
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h: 0.08,
      fill: { color: C.accent }, line: { color: C.accent, width: 0 },
    });

    // Title
    s.addText(col.title, {
      x: x + 0.25, y: y + 0.3, w: w - 0.5, h: 0.4,
      fontSize: 16, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });

    // Big stat
    s.addText(col.stat, {
      x: x + 0.25, y: y + 0.85, w: w - 0.5, h: 0.9,
      fontSize: 44, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0,
    });

    // Stat label
    s.addText(col.statLabel, {
      x: x + 0.25, y: y + 1.8, w: w - 0.5, h: 0.4,
      fontSize: 11, color: C.textDim, fontFace: F.hanBody, margin: 0,
    });

    // Divider
    s.addShape(pres.shapes.LINE, {
      x: x + 0.25, y: y + 2.3, w: w - 0.5, h: 0,
      line: { color: C.border, width: 1 },
    });

    // Points
    col.points.forEach((pt, j) => {
      const pty = y + 2.45 + j * 0.65;
      // Orange dot
      s.addShape(pres.shapes.OVAL, {
        x: x + 0.3, y: pty + 0.1, w: 0.1, h: 0.1,
        fill: { color: C.accent }, line: { color: C.accent, width: 0 },
      });
      s.addText(pt, {
        x: x + 0.5, y: pty, w: w - 0.75, h: 0.6,
        fontSize: 12, color: C.textMuted, fontFace: F.hanBody, margin: 0,
      });
    });
  });

  // Bottom conclusion bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 6.7, w: 11.7, h: 0.5,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
  s.addText("三类合计年化需求 > 100 亿美元 · 中心化玩家在合规上永远无法服务", {
    x: 0.8, y: 6.7, w: 11.7, h: 0.5,
    fontSize: 14, bold: true, color: C.text, fontFace: F.hanHeader, align: "center", valign: "middle", margin: 0,
  });
}

// ================================================================
// SLIDE 5: Market Size
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("市场规模", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("大、快、还在加速的市场", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Three giant stats
  const stats = [
    { num: "$65B", label: "2024 年全球 LLM API 市场" },
    { num: "10x", label: "LLM API 市场年增速" },
    { num: "$360B", label: "2027 年全球 LLM API 市场预测" },
  ];

  stats.forEach((stat, i) => {
    const x = 0.8 + i * 4.15;
    const w = 3.9;
    const y = 2.3;
    const h = 2.5;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    s.addText(stat.num, {
      x: x + 0.2, y: y + 0.35, w: w - 0.4, h: 1.4,
      fontSize: 84, bold: true, color: C.accent, fontFace: F.engHeader, align: "center", margin: 0, charSpacing: -2,
    });

    s.addText(stat.label, {
      x: x + 0.2, y: y + 1.85, w: w - 0.4, h: 0.5,
      fontSize: 13, color: C.textMuted, fontFace: F.hanBody, align: "center", margin: 0,
    });
  });

  // Context box
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 5.1, w: 11.7, h: 1.8,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
  });

  s.addText("TAM 的目标占比", {
    x: 1.0, y: 5.2, w: 11, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  s.addText([
    { text: "24 个月：", options: { bold: true, color: C.text } },
    { text: "抢下长尾供给 + Agent 市场的 ", options: { color: C.textMuted } },
    { text: "0.5%", options: { bold: true, color: C.accent } },
    { text: " = 月结算 ", options: { color: C.textMuted } },
    { text: "$5000 万", options: { bold: true, color: C.text } },
    { text: " = 年协议收入 ", options: { color: C.textMuted } },
    { text: "$600 万", options: { bold: true, color: C.good } },
  ], {
    x: 1.0, y: 5.65, w: 11, h: 0.5,
    fontSize: 14, fontFace: F.hanBody, margin: 0,
  });

  s.addText([
    { text: "60 个月：", options: { bold: true, color: C.text } },
    { text: "占比 ", options: { color: C.textMuted } },
    { text: "3%", options: { bold: true, color: C.accent } },
    { text: " = 月结算 ", options: { color: C.textMuted } },
    { text: "$3 亿", options: { bold: true, color: C.text } },
    { text: " = 年协议收入 ", options: { color: C.textMuted } },
    { text: "$3600 万", options: { bold: true, color: C.good } },
  ], {
    x: 1.0, y: 6.15, w: 11, h: 0.5,
    fontSize: 14, fontFace: F.hanBody, margin: 0,
  });

  s.addText("数据来源：Precedence Research · Menlo Ventures LLM Report 2024 · Gartner", {
    x: 0.8, y: 7.05, w: 12, h: 0.3,
    fontSize: 9, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });
}

// ================================================================
// SLIDE 6: Why Now
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("WHY NOW", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.engHeader, margin: 0, charSpacing: 4, bold: true,
  });

  s.addText("三个窗口在 2026 首次同时打开", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  const windows = [
    {
      num: "01",
      title: "Agent 元年到来",
      points: [
        "OpenAI Agents SDK (2025-03)",
        "Anthropic Computer Use (2024-10)",
        "Manus、Devin 爆款出圈",
        "Agent 自主交易需求从零变成刚需",
      ],
    },
    {
      num: "02",
      title: "加密基础设施成熟",
      points: [
        "Base / Arbitrum 交易费 < $0.01",
        "USDC 流通量 $400 亿",
        "Account Abstraction 规模化",
        "支付和身份层技术难题已解决",
      ],
    },
    {
      num: "03",
      title: "监管分叉加剧",
      points: [
        "欧盟 AI Act 生效 (2025)",
        "美国对华 AI 服务限制持续",
        "中心化玩家合规成本持续上升",
        "去中心化套利窗口扩大",
      ],
    },
  ];

  windows.forEach((w, i) => {
    const x = 0.8 + i * 4.15;
    const wid = 3.9;
    const y = 2.0;
    const h = 4.3;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w: wid, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Big number
    s.addText(w.num, {
      x: x + 0.3, y: y + 0.3, w: 1.5, h: 0.8,
      fontSize: 48, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0, charSpacing: -2,
    });

    // Title
    s.addText(w.title, {
      x: x + 0.3, y: y + 1.15, w: wid - 0.6, h: 0.5,
      fontSize: 18, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });

    // Divider
    s.addShape(pres.shapes.LINE, {
      x: x + 0.3, y: y + 1.7, w: wid - 0.6, h: 0,
      line: { color: C.border, width: 1 },
    });

    // Points
    w.points.forEach((pt, j) => {
      s.addText(pt, {
        x: x + 0.5, y: y + 1.85 + j * 0.55, w: wid - 0.7, h: 0.5,
        fontSize: 12, color: C.textMuted, fontFace: F.hanBody, margin: 0,
      });
    });
  });

  // Bottom emphasis
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 6.55, w: 11.7, h: 0.55,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
  s.addText("早 2 年做技术不成熟。晚 2 年做格局已定。2026 是唯一的窗口。", {
    x: 0.8, y: 6.55, w: 11.7, h: 0.55,
    fontSize: 14, bold: true, color: C.text, fontFace: F.hanHeader, align: "center", valign: "middle", margin: 0,
  });
}

// ================================================================
// SLIDE 7: Architecture
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("技术架构", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("不是 PPT 架构，是已落地的代码", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Four-layer architecture
  const layers = [
    {
      name: "Application Layer",
      cn: "应用层",
      items: "OpenAI 兼容 HTTP API  ·  CLI  ·  [SDK: Phase 1.5]",
      status: "✅ 已完成",
    },
    {
      name: "Market Layer",
      cn: "市场层",
      items: "调度器（硬过滤 + 软排序 + 会话粘性）· 信誉系统 · 40 项单测通过",
      status: "✅ 已完成",
    },
    {
      name: "Transport Layer",
      cn: "传输层",
      items: "libp2p DHT 发现  ·  E2EE 推理流（Noise Protocol）",
      status: "✅ 已完成",
    },
    {
      name: "Settlement Layer",
      cn: "结算层",
      items: "EscrowPool · EIP-712 Authorization · Claim Batching (gas $0.001/req)",
      status: "✅ Base Sepolia 已部署",
    },
  ];

  const layerY = 2.0;
  const layerH = 0.95;
  const layerGap = 0.15;
  const leftW = 9.5;
  const rightW = 2.8;

  layers.forEach((layer, i) => {
    const y = layerY + i * (layerH + layerGap);

    // Main layer bar
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.8, y, w: leftW, h: layerH,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Left accent stripe
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.8, y, w: 0.1, h: layerH,
      fill: { color: C.accent }, line: { color: C.accent, width: 0 },
    });

    // Layer name EN
    s.addText(layer.name, {
      x: 1.1, y: y + 0.12, w: leftW - 0.4, h: 0.35,
      fontSize: 14, bold: true, color: C.text, fontFace: F.engHeader, margin: 0,
    });

    // Layer name CN
    s.addText(layer.cn, {
      x: 1.1, y: y + 0.12, w: leftW - 0.4, h: 0.35,
      fontSize: 11, color: C.accent, fontFace: F.hanHeader, align: "right", margin: 0,
    });

    // Items
    s.addText(layer.items, {
      x: 1.1, y: y + 0.5, w: leftW - 0.3, h: 0.4,
      fontSize: 12, color: C.textMuted, fontFace: F.hanBody, margin: 0,
    });

    // Status bar (right)
    s.addShape(pres.shapes.RECTANGLE, {
      x: 10.5, y, w: rightW, h: layerH,
      fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
    });
    s.addText(layer.status, {
      x: 10.5, y, w: rightW, h: layerH,
      fontSize: 12, bold: true, color: C.good, fontFace: F.hanHeader, align: "center", valign: "middle", margin: 0,
    });
  });

  // Bottom key callout
  s.addText("关键技术创新：EIP-712 Authorization + Claim Batching 让链下高频 + 链上可信结算同时成立", {
    x: 0.8, y: 6.5, w: 11.7, h: 0.5,
    fontSize: 13, italic: true, color: C.textMuted, fontFace: F.hanBody, align: "center", margin: 0,
  });

  addFooter(s, 7, TOTAL);
}

// ================================================================
// SLIDE 8: Product Demo
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("产品演示", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("Buyer 接入 · 3 行代码", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Left: code
  const codeX = 0.8, codeY = 2.0, codeW = 6.5, codeH = 4.0;
  s.addShape(pres.shapes.RECTANGLE, {
    x: codeX, y: codeY, w: codeW, h: codeH,
    fill: { color: "0F0F0F" }, line: { color: C.border, width: 1 },
  });

  // Code title bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: codeX, y: codeY, w: codeW, h: 0.35,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 0 },
  });
  s.addText("agent.ts", {
    x: codeX + 0.2, y: codeY, w: codeW - 0.4, h: 0.35,
    fontSize: 10, color: C.textDim, fontFace: F.mono, valign: "middle", margin: 0,
  });

  // Code content
  s.addText([
    { text: "import ", options: { color: "FF6B35" } },
    { text: "{ TAM } ", options: { color: "FFFFFF" } },
    { text: "from ", options: { color: "FF6B35" } },
    { text: "'@clawmarket/sdk'", options: { color: "00C896", breakLine: true } },
    { text: "", options: { breakLine: true } },
    { text: "const ", options: { color: "FF6B35" } },
    { text: "claw = ", options: { color: "FFFFFF" } },
    { text: "new ", options: { color: "FF6B35" } },
    { text: "TAM({", options: { color: "FFFFFF", breakLine: true } },
    { text: "  privateKey: process.env.AGENT_KEY,", options: { color: "B0B0B0", breakLine: true } },
    { text: "  maxSpendPerHour: ", options: { color: "B0B0B0" } },
    { text: "10", options: { color: "FFB800" } },
    { text: ",  ", options: { color: "B0B0B0" } },
    { text: "// USDC 熔断", options: { color: "707070", italic: true, breakLine: true } },
    { text: "})", options: { color: "FFFFFF", breakLine: true } },
    { text: "", options: { breakLine: true } },
    { text: "const ", options: { color: "FF6B35" } },
    { text: "response = ", options: { color: "FFFFFF" } },
    { text: "await ", options: { color: "FF6B35" } },
    { text: "claw.chat.completions.create({", options: { color: "FFFFFF", breakLine: true } },
    { text: "  model: ", options: { color: "B0B0B0" } },
    { text: "'claude-3-opus'", options: { color: "00C896", breakLine: true } },
    { text: "  messages: [{ role: ", options: { color: "B0B0B0" } },
    { text: "'user'", options: { color: "00C896" } },
    { text: ", content: ", options: { color: "B0B0B0" } },
    { text: "'Hello'", options: { color: "00C896" } },
    { text: " }]", options: { color: "B0B0B0", breakLine: true } },
    { text: "})", options: { color: "FFFFFF" } },
  ], {
    x: codeX + 0.25, y: codeY + 0.5, w: codeW - 0.5, h: codeH - 0.7,
    fontSize: 12, fontFace: F.mono, margin: 0, paraSpaceAfter: 2,
  });

  // Right: flow
  const flowX = 7.6, flowY = 2.0, flowW = 4.9, flowH = 4.0;
  s.addShape(pres.shapes.RECTANGLE, {
    x: flowX, y: flowY, w: flowW, h: flowH,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });

  s.addText("请求流程", {
    x: flowX + 0.25, y: flowY + 0.2, w: flowW - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const steps = [
    { n: "1", t: "EIP-712 签名授权", latency: "2ms" },
    { n: "2", t: "HTTPS → Hosted Gateway", latency: "30ms" },
    { n: "3", t: "路由选 best provider", latency: "5ms" },
    { n: "4", t: "推理 stream 首字节", latency: "150ms" },
    { n: "5", t: "Claim Batching 结算", latency: "异步" },
  ];

  steps.forEach((step, i) => {
    const y = flowY + 0.8 + i * 0.55;
    // number circle
    s.addShape(pres.shapes.OVAL, {
      x: flowX + 0.25, y, w: 0.35, h: 0.35,
      fill: { color: C.accent }, line: { color: C.accent, width: 0 },
    });
    s.addText(step.n, {
      x: flowX + 0.25, y, w: 0.35, h: 0.35,
      fontSize: 12, bold: true, color: C.text, fontFace: F.engHeader, align: "center", valign: "middle", margin: 0,
    });
    // step text
    s.addText(step.t, {
      x: flowX + 0.75, y: y + 0.02, w: 3.0, h: 0.35,
      fontSize: 12, color: C.text, fontFace: F.hanBody, valign: "middle", margin: 0,
    });
    // latency
    s.addText(step.latency, {
      x: flowX + 3.8, y: y + 0.02, w: 1.0, h: 0.35,
      fontSize: 11, color: C.good, fontFace: F.mono, align: "right", valign: "middle", margin: 0,
    });
  });

  // Bottom comparison
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 6.3, w: 11.7, h: 0.75,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
  });
  s.addText([
    { text: "OpenAI 直连首字节：~180ms   ·   TAM 首字节：~185ms   ·   ", options: { color: C.textMuted } },
    { text: "差异 < 5ms，体验等价", options: { bold: true, color: C.accent } },
    { text: "，但价格可低 30%+，供给选择多 10x", options: { color: C.textMuted } },
  ], {
    x: 0.8, y: 6.3, w: 11.7, h: 0.75,
    fontSize: 13, fontFace: F.hanBody, align: "center", valign: "middle", margin: 0,
  });
}

// ================================================================
// SLIDE 9: Moat
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("护城河", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("为什么这不是\"另一个 OpenRouter 的 fork\"", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  const moats = [
    {
      n: "①",
      title: "双边网络效应",
      body: "Provider 越多 → 价格越有竞争力 → Buyer 越多 → Provider 越愿加入。先达到最小可行规模的协议赢者通吃。",
    },
    {
      n: "②",
      title: "信誉数据不可 fork",
      body: "两年累积上亿条 (request, provider, quality) 数据。fork 代码容易，fork 不走实战数据。类比 Uniswap vs SushiSwap。",
    },
    {
      n: "③",
      title: "Agent 生态锁定",
      body: "一旦主流框架（LangChain、Vercel AI SDK、Anthropic MCP）默认 backend 是我们，迁移意味着整个 agent 生态要同步改。",
    },
    {
      n: "④",
      title: "合规套利窗口持续扩大",
      body: "中心化玩家越成熟合规负担越重。这不是阶段性优势，是随时间线性扩大的结构性红利。只有去中心化架构能吃到。",
    },
  ];

  moats.forEach((m, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.8 + col * 6.0;
    const y = 2.0 + row * 2.35;
    const w = 5.7;
    const h = 2.1;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Big number
    s.addText(m.n, {
      x: x + 0.25, y: y + 0.2, w: 0.8, h: 0.8,
      fontSize: 44, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0,
    });

    // Title
    s.addText(m.title, {
      x: x + 1.1, y: y + 0.3, w: w - 1.3, h: 0.5,
      fontSize: 18, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });

    // Divider
    s.addShape(pres.shapes.LINE, {
      x: x + 0.25, y: y + 1.05, w: w - 0.5, h: 0,
      line: { color: C.border, width: 1 },
    });

    // Body
    s.addText(m.body, {
      x: x + 0.25, y: y + 1.2, w: w - 0.5, h: h - 1.4,
      fontSize: 12, color: C.textMuted, fontFace: F.hanBody, margin: 0,
    });
  });

  addFooter(s, 9, TOTAL);
}

// ================================================================
// SLIDE 10: Tokenomics
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("商业模式", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("协议收入 = 代币价值", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Left: Cash flow
  const lx = 0.8, ly = 2.0, lw = 6.0, lh = 4.5;
  s.addShape(pres.shapes.RECTANGLE, {
    x: lx, y: ly, w: lw, h: lh,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("现金流路径", {
    x: lx + 0.25, y: ly + 0.2, w: lw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  // Flow
  const flows = [
    { label: "Buyer 付款", value: "1 USDC", color: C.text, indent: 0 },
    { label: "EscrowPool 合约", value: "", color: C.textMuted, indent: 0 },
    { label: "→ Provider", value: "99%", color: C.textMuted, indent: 1 },
    { label: "→ 协议费", value: "1%", color: C.accent, indent: 1, bold: true },
    { label: "CLAW Staker 分红", value: "70%", color: C.good, indent: 2 },
    { label: "Treasury (DAO)", value: "20%", color: C.good, indent: 2 },
    { label: "回购销毁", value: "10%", color: C.good, indent: 2 },
  ];

  flows.forEach((f, i) => {
    const y = ly + 0.75 + i * 0.45;
    const indentX = lx + 0.35 + f.indent * 0.4;
    s.addText(f.label, {
      x: indentX, y, w: lw - 2.5, h: 0.4,
      fontSize: f.bold ? 14 : 13, bold: f.bold, color: f.color, fontFace: F.hanBody, valign: "middle", margin: 0,
    });
    if (f.value) {
      s.addText(f.value, {
        x: lx + lw - 1.5, y, w: 1.2, h: 0.4,
        fontSize: f.bold ? 14 : 13, bold: f.bold, color: f.color, fontFace: F.mono, align: "right", valign: "middle", margin: 0,
      });
    }
  });

  // Example at bottom of left card
  s.addShape(pres.shapes.LINE, {
    x: lx + 0.25, y: ly + lh - 0.75, w: lw - 0.5, h: 0,
    line: { color: C.border, width: 1 },
  });
  s.addText("月结算 $500 万 → 协议收入 $60 万/年 → 回购 $6 万/年", {
    x: lx + 0.25, y: ly + lh - 0.65, w: lw - 0.5, h: 0.5,
    fontSize: 11, italic: true, color: C.textDim, fontFace: F.hanBody, margin: 0,
  });

  // Right: Token functions
  const rx = 7.0, ry = 2.0, rw = 5.5, rh = 4.5;
  s.addShape(pres.shapes.RECTANGLE, {
    x: rx, y: ry, w: rw, h: rh,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("CLAW 代币三功能", {
    x: rx + 0.25, y: ry + 0.2, w: rw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const funcs = [
    { num: "1", title: "Provider 质押担保", desc: "最低 100 USDC 等值 CLAW 才能挂单，作恶 slash" },
    { num: "2", title: "流动性挖矿", desc: "结算 1 USDC → mint CLAW（100→50→25→10 递减）" },
    { num: "3", title: "治理", desc: "费率、参数、仲裁规则由 CLAW 持有者投票" },
  ];

  funcs.forEach((f, i) => {
    const y = ry + 0.8 + i * 1.2;
    // Num circle
    s.addShape(pres.shapes.OVAL, {
      x: rx + 0.3, y, w: 0.45, h: 0.45,
      fill: { color: C.accent }, line: { color: C.accent, width: 0 },
    });
    s.addText(f.num, {
      x: rx + 0.3, y, w: 0.45, h: 0.45,
      fontSize: 16, bold: true, color: C.text, fontFace: F.engHeader, align: "center", valign: "middle", margin: 0,
    });
    s.addText(f.title, {
      x: rx + 0.9, y: y - 0.02, w: rw - 1.1, h: 0.4,
      fontSize: 14, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });
    s.addText(f.desc, {
      x: rx + 0.9, y: y + 0.4, w: rw - 1.1, h: 0.5,
      fontSize: 11, color: C.textMuted, fontFace: F.hanBody, margin: 0,
    });
  });

  // Bottom tagline
  s.addText("代币发行与真实经济活动严格绑定 · 不存在凭空稀释", {
    x: 0.8, y: 6.7, w: 11.7, h: 0.4,
    fontSize: 13, italic: true, color: C.accent, fontFace: F.hanBody, align: "center", margin: 0,
  });
}

// ================================================================
// SLIDE 11: Traction
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("进展", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("不是 whitepaper，是已经在跑的代码", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Left: Completed items
  const lx = 0.8, ly = 2.0, lw = 7.0, lh = 4.5;
  s.addShape(pres.shapes.RECTANGLE, {
    x: lx, y: ly, w: lw, h: lh,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("已完成（Testnet 阶段）", {
    x: lx + 0.3, y: ly + 0.2, w: lw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.good, fontFace: F.hanHeader, margin: 0,
  });

  const completed = [
    "核心合约 Base Sepolia 部署（EscrowPool · Mining · Token）",
    "EIP-712 Authorization + Claim Batching 上线",
    "libp2p 节点 + DHT 发现 + E2EE 推理流",
    "Buyer CLI + Provider Gateway",
    "调度器 40 项单测 100% 通过",
    "Hard Filter + Soft Rank + Session Sticky",
    "Mock seller 压测平台 + 5 个场景脚本",
    "客户端自动更新系统设计完成",
  ];

  completed.forEach((item, i) => {
    const y = ly + 0.75 + i * 0.43;
    // Checkmark
    s.addText("✓", {
      x: lx + 0.3, y, w: 0.3, h: 0.3,
      fontSize: 14, bold: true, color: C.good, fontFace: F.engHeader, margin: 0,
    });
    s.addText(item, {
      x: lx + 0.65, y, w: lw - 0.9, h: 0.35,
      fontSize: 12, color: C.textMuted, fontFace: F.hanBody, margin: 0,
    });
  });

  // Right: 12-month targets
  const rx = 8.0, ry = 2.0, rw = 4.5, rh = 4.5;
  s.addShape(pres.shapes.RECTANGLE, {
    x: rx, y: ry, w: rw, h: rh,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
  });
  s.addText("12 个月目标", {
    x: rx + 0.3, y: ry + 0.2, w: rw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const targets = [
    { num: "500+", label: "活跃节点" },
    { num: "50+", label: "覆盖模型" },
    { num: "数万", label: "累计交易笔数" },
    { num: "$100K", label: "月结算额" },
  ];

  targets.forEach((t, i) => {
    const y = ry + 0.85 + i * 0.85;
    s.addText(t.num, {
      x: rx + 0.3, y, w: 2.0, h: 0.7,
      fontSize: 32, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0, charSpacing: -1,
    });
    s.addText(t.label, {
      x: rx + 2.3, y: y + 0.15, w: rw - 2.5, h: 0.4,
      fontSize: 13, color: C.textMuted, fontFace: F.hanBody, margin: 0,
    });
  });

  // Bottom timeline
  s.addText("2025 Q1 启动 · 2026 Q2 公开 Testnet · 2026 Q3 Mainnet + TGE（本轮资金支持点）", {
    x: 0.8, y: 6.7, w: 11.7, h: 0.4,
    fontSize: 12, italic: true, color: C.textDim, fontFace: F.hanBody, align: "center", margin: 0,
  });
}

// ================================================================
// SLIDE 12: Competition
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("竞争格局", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("四象限定位", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // 2x2 chart area
  const chartX = 0.8, chartY = 2.0, chartW = 6.5, chartH = 4.7;

  // Background grid
  s.addShape(pres.shapes.RECTANGLE, {
    x: chartX, y: chartY, w: chartW, h: chartH,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });

  // Axes
  const midX = chartX + chartW / 2;
  const midY = chartY + chartH / 2;
  s.addShape(pres.shapes.LINE, {
    x: chartX + 0.3, y: midY, w: chartW - 0.6, h: 0,
    line: { color: C.border, width: 1 },
  });
  s.addShape(pres.shapes.LINE, {
    x: midX, y: chartY + 0.3, w: 0, h: chartH - 0.6,
    line: { color: C.border, width: 1 },
  });

  // Axis labels
  s.addText("专业 / 垂直", {
    x: midX - 1, y: chartY + 0.15, w: 2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, align: "center", italic: true, margin: 0,
  });
  s.addText("通用 / 基础", {
    x: midX - 1, y: chartY + chartH - 0.4, w: 2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, align: "center", italic: true, margin: 0,
  });
  s.addText("中心化", {
    x: chartX + 0.2, y: midY - 0.15, w: 1.2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });
  s.addText("去中心化", {
    x: chartX + chartW - 1.4, y: midY - 0.15, w: 1.2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, italic: true, align: "right", margin: 0,
  });

  // Competitors
  const quadW = chartW / 2;
  const quadH = chartH / 2;

  // OpenRouter (bottom-left: centralized + general)
  s.addShape(pres.shapes.OVAL, {
    x: chartX + quadW * 0.3, y: midY + quadH * 0.35, w: 0.25, h: 0.25,
    fill: { color: C.textDim }, line: { color: C.textDim, width: 0 },
  });
  s.addText("OpenRouter\nAI/ML API", {
    x: chartX + quadW * 0.3 + 0.35, y: midY + quadH * 0.3, w: 2, h: 0.6,
    fontSize: 12, color: C.text, fontFace: F.hanBody, bold: true, margin: 0,
  });
  s.addText("聚合商, 人类用户", {
    x: chartX + quadW * 0.3 + 0.35, y: midY + quadH * 0.55, w: 2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });

  // Bittensor (top-left: centralized + specialized)
  s.addShape(pres.shapes.OVAL, {
    x: chartX + quadW * 0.4, y: chartY + quadH * 0.5, w: 0.25, h: 0.25,
    fill: { color: C.textDim }, line: { color: C.textDim, width: 0 },
  });
  s.addText("Bittensor", {
    x: chartX + quadW * 0.4 + 0.35, y: chartY + quadH * 0.45, w: 2, h: 0.35,
    fontSize: 12, color: C.text, fontFace: F.hanBody, bold: true, margin: 0,
  });
  s.addText("训练+推理, 主观评分", {
    x: chartX + quadW * 0.4 + 0.35, y: chartY + quadH * 0.7, w: 2.2, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });

  // Akash (bottom-right: decentralized + general)
  s.addShape(pres.shapes.OVAL, {
    x: midX + quadW * 0.35, y: midY + quadH * 0.35, w: 0.25, h: 0.25,
    fill: { color: C.textDim }, line: { color: C.textDim, width: 0 },
  });
  s.addText("Akash / io.net", {
    x: midX + quadW * 0.35 + 0.35, y: midY + quadH * 0.3, w: 2.3, h: 0.35,
    fontSize: 12, color: C.text, fontFace: F.hanBody, bold: true, margin: 0,
  });
  s.addText("raw GPU, 用户自部署", {
    x: midX + quadW * 0.35 + 0.35, y: midY + quadH * 0.55, w: 2.3, h: 0.3,
    fontSize: 10, color: C.textDim, fontFace: F.hanBody, italic: true, margin: 0,
  });

  // TAM (top-right: highlighted)
  s.addShape(pres.shapes.OVAL, {
    x: midX + quadW * 0.35, y: chartY + quadH * 0.45, w: 0.4, h: 0.4,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
  s.addText("TAM", {
    x: midX + quadW * 0.35 + 0.5, y: chartY + quadH * 0.4, w: 2.3, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, bold: true, margin: 0,
  });
  s.addText("推理市场协议, 客观结算", {
    x: midX + quadW * 0.35 + 0.5, y: chartY + quadH * 0.72, w: 2.3, h: 0.3,
    fontSize: 10, color: C.text, fontFace: F.hanBody, italic: true, margin: 0,
  });

  // Right: feature comparison
  const tx = 7.7, ty = 2.0, tw = 4.8;
  s.addShape(pres.shapes.RECTANGLE, {
    x: tx, y: ty, w: tw, h: 4.7,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("TAM 的独特优势", {
    x: tx + 0.25, y: ty + 0.2, w: tw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const advantages = [
    { k: "开放供给", v: "✓ 无许可" },
    { k: "即用 API", v: "✓ OpenAI 兼容" },
    { k: "链上结算", v: "✓ 不可赖账" },
    { k: "Agent 友好", v: "✓ 机器原生" },
    { k: "客观质量", v: "✓ 数据驱动" },
    { k: "全球可达", v: "✓ 稳定币" },
    { k: "无 KYC", v: "✓ 钱包即身份" },
  ];

  advantages.forEach((a, i) => {
    const y = ty + 0.75 + i * 0.52;
    s.addText(a.k, {
      x: tx + 0.35, y, w: 2.5, h: 0.4,
      fontSize: 13, color: C.text, fontFace: F.hanBody, valign: "middle", margin: 0,
    });
    s.addText(a.v, {
      x: tx + 2.8, y, w: tw - 3.0, h: 0.4,
      fontSize: 12, color: C.good, fontFace: F.hanBody, bold: true, valign: "middle", align: "right", margin: 0,
    });
  });

  addFooter(s, 12, TOTAL);
}

// ================================================================
// SLIDE 13: Go-to-Market
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("Go-to-Market", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.engHeader, margin: 0, charSpacing: 4, bold: true,
  });

  s.addText("双边市场冷启动路径", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  const steps = [
    {
      num: "Step 1",
      period: "Q2 2026",
      title: "Seed Supply",
      body: "高 CLAW 挖矿（100x）吸引供给侧\n自持官方账号作 founding provider\n定向邀请 100 个长尾供给方",
      kpi: "月活 Provider ≥ 100\n模型覆盖 ≥ 50",
    },
    {
      num: "Step 2",
      period: "Q3 2026",
      title: "Seed Demand",
      body: "发 Agent SDK + Hosted Gateway\n向受限地区开发者社区推广\n开源 agent 框架联合宣发",
      kpi: "月活 Buyer ≥ 1000\n月结算 $100K",
    },
    {
      num: "Step 3",
      period: "Q4 2026 – Q1 2027",
      title: "生态集成",
      body: "争取 LangChain / Vercel AI SDK 官方收录\nAnthropic MCP server 做 Claude tool\n3+ VC 背书的 agent 公司默认 backend",
      kpi: "月结算 $1M",
    },
  ];

  steps.forEach((st, i) => {
    const x = 0.8 + i * 4.15;
    const w = 3.9;
    const y = 2.0;
    const h = 4.3;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Top strip
    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h: 0.08,
      fill: { color: C.accent }, line: { color: C.accent, width: 0 },
    });

    // Step num + period
    s.addText(st.num, {
      x: x + 0.3, y: y + 0.3, w: 2, h: 0.4,
      fontSize: 18, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0,
    });
    s.addText(st.period, {
      x: x + w - 2, y: y + 0.3, w: 1.7, h: 0.4,
      fontSize: 11, color: C.textDim, fontFace: F.mono, align: "right", margin: 0,
    });

    // Title
    s.addText(st.title, {
      x: x + 0.3, y: y + 0.85, w: w - 0.5, h: 0.5,
      fontSize: 20, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });

    // Divider
    s.addShape(pres.shapes.LINE, {
      x: x + 0.3, y: y + 1.45, w: w - 0.6, h: 0,
      line: { color: C.border, width: 1 },
    });

    // Body
    s.addText(st.body, {
      x: x + 0.3, y: y + 1.6, w: w - 0.5, h: 1.8,
      fontSize: 12, color: C.textMuted, fontFace: F.hanBody, paraSpaceAfter: 4, margin: 0,
    });

    // KPI box
    s.addShape(pres.shapes.RECTANGLE, {
      x: x + 0.3, y: y + h - 1.2, w: w - 0.6, h: 1.0,
      fill: { color: C.bgAlt }, line: { color: C.border, width: 0 },
    });
    s.addText("KPI", {
      x: x + 0.5, y: y + h - 1.1, w: w - 1.0, h: 0.3,
      fontSize: 10, bold: true, color: C.accent, fontFace: F.engHeader, charSpacing: 2, margin: 0,
    });
    s.addText(st.kpi, {
      x: x + 0.5, y: y + h - 0.8, w: w - 1.0, h: 0.6,
      fontSize: 11, color: C.good, fontFace: F.hanBody, bold: true, paraSpaceAfter: 2, margin: 0,
    });
  });

  // Bottom: what we don't do
  s.addText("不做补贴价格战（用 CLAW 挖矿替代现金补贴）· 不做传统广告投放 · 不做 B2B 合同销售", {
    x: 0.8, y: 6.5, w: 11.7, h: 0.4,
    fontSize: 12, italic: true, color: C.textDim, fontFace: F.hanBody, align: "center", margin: 0,
  });

  addFooter(s, 13, TOTAL);
}

// ================================================================
// SLIDE 14: Roadmap
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("路线图", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("18 个月交付计划", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
  });

  // Horizontal timeline
  const timelineY = 3.5;
  const timelineX = 1.0;
  const timelineW = 11.5;

  // Timeline line
  s.addShape(pres.shapes.LINE, {
    x: timelineX, y: timelineY, w: timelineW, h: 0,
    line: { color: C.accent, width: 3 },
  });

  const phases = [
    { q: "Q2 2026", title: "公开 Testnet", items: "100+ seller\n合约审计\n$10K/月" },
    { q: "Q3 2026", title: "Mainnet v1 + TGE", items: "Base 主网\nCLAW 上线\n$100K/月", highlight: true },
    { q: "Q4 2026", title: "Agent 接入层", items: "Hosted Gateway\nAgent SDK (TS)\nAgent 原生" },
    { q: "Q1 2027", title: "生态集成", items: "LangChain 集成\nPython SDK\n$1M/月" },
    { q: "Q2 2027+", title: "AgentPay 标准", items: "多链扩展\nA2A 结算\n$10M+/月" },
  ];

  const phaseW = timelineW / phases.length;
  phases.forEach((p, i) => {
    const cx = timelineX + phaseW * i + phaseW / 2;

    // Dot on timeline
    s.addShape(pres.shapes.OVAL, {
      x: cx - 0.15, y: timelineY - 0.15, w: 0.3, h: 0.3,
      fill: { color: p.highlight ? C.accent : C.card },
      line: { color: C.accent, width: 2 },
    });

    // Top: period label
    s.addText(p.q, {
      x: cx - 1.0, y: timelineY - 0.9, w: 2.0, h: 0.3,
      fontSize: 11, bold: true, color: C.accent, fontFace: F.mono, align: "center", margin: 0,
    });
    s.addText(p.title, {
      x: cx - 1.0, y: timelineY - 0.55, w: 2.0, h: 0.35,
      fontSize: 13, bold: true, color: C.text, fontFace: F.hanHeader, align: "center", margin: 0,
    });

    // Bottom: details
    s.addText(p.items, {
      x: cx - 1.1, y: timelineY + 0.35, w: 2.2, h: 1.8,
      fontSize: 11, color: C.textMuted, fontFace: F.hanBody, align: "center", paraSpaceAfter: 2, margin: 0,
    });
  });

  // Funding scope box
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 6.2, w: 11.7, h: 0.8,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
  });
  s.addText([
    { text: "本轮 Seed 资金覆盖 ", options: { color: C.textMuted } },
    { text: "Q2 2026 – Q1 2027", options: { bold: true, color: C.accent } },
    { text: "（公开 Testnet → Mainnet + TGE → 初步生态集成）· ", options: { color: C.textMuted } },
    { text: "Series A 基于 Mainnet traction 发起", options: { bold: true, color: C.text } },
  ], {
    x: 0.8, y: 6.2, w: 11.7, h: 0.8,
    fontSize: 13, fontFace: F.hanBody, align: "center", valign: "middle", margin: 0,
  });
}

// ================================================================
// SLIDE 15: Team
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("团队", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("Team", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.engHeader, margin: 0,
  });

  const roles = [
    { role: "CEO / 创始人", focus: "产品 · 战略 · 融资" },
    { role: "CTO / 技术合伙人", focus: "分布式系统 · 密码学 · 区块链" },
    { role: "COO / 运营合伙人", focus: "BD · 生态 · 社区" },
  ];

  roles.forEach((r, i) => {
    const x = 0.8 + i * 4.15;
    const w = 3.9;
    const y = 2.2;
    const h = 4.0;

    s.addShape(pres.shapes.RECTANGLE, {
      x, y, w, h,
      fill: { color: C.card }, line: { color: C.border, width: 1 },
    });

    // Avatar placeholder (circle)
    s.addShape(pres.shapes.OVAL, {
      x: x + w / 2 - 0.75, y: y + 0.4, w: 1.5, h: 1.5,
      fill: { color: C.bgAlt }, line: { color: C.border, width: 2 },
    });
    s.addText("[ 照片 ]", {
      x: x + w / 2 - 0.75, y: y + 0.4, w: 1.5, h: 1.5,
      fontSize: 11, color: C.textDim, fontFace: F.hanBody, align: "center", valign: "middle", italic: true, margin: 0,
    });

    // Role
    s.addText(r.role, {
      x: x + 0.2, y: y + 2.15, w: w - 0.4, h: 0.4,
      fontSize: 16, bold: true, color: C.accent, fontFace: F.hanHeader, align: "center", margin: 0,
    });

    // Name placeholder
    s.addText("[ 姓名 ]", {
      x: x + 0.2, y: y + 2.55, w: w - 0.4, h: 0.4,
      fontSize: 20, bold: true, color: C.text, fontFace: F.hanHeader, align: "center", margin: 0,
    });

    // Focus
    s.addText(r.focus, {
      x: x + 0.2, y: y + 3.0, w: w - 0.4, h: 0.3,
      fontSize: 11, color: C.textMuted, fontFace: F.hanBody, align: "center", italic: true, margin: 0,
    });

    // Bio placeholder
    s.addText("[ 履历 · 代表作品 · 过往成就 ]", {
      x: x + 0.3, y: y + 3.4, w: w - 0.6, h: 0.45,
      fontSize: 11, color: C.textDim, fontFace: F.hanBody, align: "center", italic: true, margin: 0,
    });
  });

  // Bottom advisor line
  s.addText("顾问 / Advisors：[ 待补充 ]", {
    x: 0.8, y: 6.5, w: 11.7, h: 0.4,
    fontSize: 12, color: C.textDim, fontFace: F.hanBody, align: "center", italic: true, margin: 0,
  });

  addFooter(s, 15, TOTAL);
}

// ================================================================
// SLIDE 16: The Ask
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  s.addText("融资", {
    x: 0.8, y: 0.5, w: 8, h: 0.4,
    fontSize: 14, color: C.accent, fontFace: F.hanHeader, margin: 0, charSpacing: 4,
  });

  s.addText("The Ask", {
    x: 0.8, y: 1.0, w: 12, h: 0.7,
    fontSize: 30, bold: true, color: C.text, fontFace: F.engHeader, margin: 0,
  });

  // Giant funding number
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.8, y: 1.95, w: 11.7, h: 1.5,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });

  s.addText([
    { text: "Seed Round  ·  ", options: { color: C.text, fontSize: 18, bold: false } },
    { text: "$1M", options: { color: C.text, fontSize: 48, bold: true } },
    { text: "  at  ", options: { color: C.text, fontSize: 18 } },
    { text: "$5M", options: { color: C.text, fontSize: 48, bold: true } },
    { text: "  post-money", options: { color: C.text, fontSize: 18 } },
  ], {
    x: 0.8, y: 1.95, w: 11.7, h: 1.5,
    fontFace: F.engHeader, align: "center", valign: "middle", margin: 0,
  });

  // Use of funds - left card
  const lx = 0.8, ly = 3.7, lw = 6.0, lh = 2.8;
  s.addShape(pres.shapes.RECTANGLE, {
    x: lx, y: ly, w: lw, h: lh,
    fill: { color: C.card }, line: { color: C.border, width: 1 },
  });
  s.addText("资金用途", {
    x: lx + 0.25, y: ly + 0.2, w: lw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const uses = [
    { pct: "40%", label: "工程团队扩编", detail: "Agent SDK · Hosted Gateway · 合约审计" },
    { pct: "30%", label: "生态启动", detail: "Provider 冷启动激励 · 初始流动性" },
    { pct: "20%", label: "合规与法务", detail: "法律意见 · 基金会架构 · 代币发行" },
    { pct: "10%", label: "市场 & 运营", detail: "开发者社区 · 内容 · 会议" },
  ];

  uses.forEach((u, i) => {
    const y = ly + 0.75 + i * 0.48;
    s.addText(u.pct, {
      x: lx + 0.3, y, w: 0.9, h: 0.35,
      fontSize: 16, bold: true, color: C.accent, fontFace: F.engHeader, margin: 0,
    });
    s.addText(u.label, {
      x: lx + 1.3, y, w: 2.0, h: 0.35,
      fontSize: 12, bold: true, color: C.text, fontFace: F.hanHeader, margin: 0,
    });
    s.addText(u.detail, {
      x: lx + 3.2, y, w: lw - 3.4, h: 0.35,
      fontSize: 10, color: C.textDim, fontFace: F.hanBody, margin: 0,
    });
  });

  // Milestones - right card
  const rx = 7.0, ry = 3.7, rw = 5.5, rh = 2.8;
  s.addShape(pres.shapes.RECTANGLE, {
    x: rx, y: ry, w: rw, h: rh,
    fill: { color: C.bgAlt }, line: { color: C.border, width: 1 },
  });
  s.addText("18 个月关键里程碑", {
    x: rx + 0.25, y: ry + 0.2, w: rw - 0.5, h: 0.4,
    fontSize: 14, bold: true, color: C.accent, fontFace: F.hanHeader, margin: 0,
  });

  const milestones = [
    "Mainnet 上线 + CLAW TGE",
    "月结算 ≥ $100K，12 个月内达 $1M",
    "活跃 Provider ≥ 500",
    "3 大 agent 框架官方集成",
    "Series A 基于真实 traction 发起",
  ];

  milestones.forEach((m, i) => {
    const y = ry + 0.75 + i * 0.4;
    s.addText("✓", {
      x: rx + 0.3, y, w: 0.3, h: 0.3,
      fontSize: 14, bold: true, color: C.good, fontFace: F.engHeader, margin: 0,
    });
    s.addText(m, {
      x: rx + 0.65, y, w: rw - 0.9, h: 0.35,
      fontSize: 12, color: C.text, fontFace: F.hanBody, margin: 0,
    });
  });

  // Contact bottom
  s.addText("邮箱：[ contact email ]    Telegram：[ @__ ]", {
    x: 0.8, y: 6.7, w: 11.7, h: 0.4,
    fontSize: 12, color: C.textMuted, fontFace: F.hanBody, align: "center", margin: 0,
  });
}

// ================================================================
// SLIDE 17: Closing
// ================================================================
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Accent stripes
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 0, w: 0.15, h: 7.5,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });
  s.addShape(pres.shapes.RECTANGLE, {
    x: 13.18, y: 0, w: 0.15, h: 7.5,
    fill: { color: C.accent }, line: { color: C.accent, width: 0 },
  });

  // Main statement
  s.addText([
    { text: "Visa 之于人类经济，", options: { color: C.textMuted, breakLine: true } },
    { text: "TAM 之于 AI Agent 经济。", options: { color: C.accent, bold: true } },
  ], {
    x: 1.0, y: 2.3, w: 11.3, h: 2.2,
    fontSize: 44, fontFace: F.hanHeader, align: "center", paraSpaceAfter: 20, margin: 0,
  });

  // Sub statement
  s.addText("我们不是在做一个更好的 API 聚合器。", {
    x: 1.0, y: 4.8, w: 11.3, h: 0.5,
    fontSize: 18, color: C.textMuted, fontFace: F.hanHeader, align: "center", italic: true, margin: 0,
  });
  s.addText("我们在建一个未来三年不可或缺的协议层。", {
    x: 1.0, y: 5.3, w: 11.3, h: 0.5,
    fontSize: 18, color: C.text, fontFace: F.hanHeader, align: "center", italic: true, bold: true, margin: 0,
  });

  // Q&A
  s.addText("Q & A", {
    x: 1.0, y: 6.5, w: 11.3, h: 0.5,
    fontSize: 20, color: C.accent, fontFace: F.engHeader, align: "center", bold: true, charSpacing: 8, margin: 0,
  });
}

// ================================================================
// Write file
// ================================================================
pres.writeFile({ fileName: require("node:path").join(__dirname, "TAM-Pitch-Deck-v1.pptx") })
  .then(fileName => console.log("✅ Generated: " + fileName));
