"""
AIMM CUC 仿真脚本
=====================

模拟 AIMM 协议核心机制:
1. CUC 定价曲线: p(u) = p₀ / (1-u)^α
2. 贪婪路由 vs 概率路由 的行为差异
3. 羊群效应的可视化

运行方式:
    pip install matplotlib numpy
    python simulation.py

产出:
    figures/01_cuc_curves.png        — CUC 曲线族
    figures/02_quote_depth.png       — 报价深度示例
    figures/03_greedy_vs_softmax.png — 路由策略对比
    figures/04_price_over_time.png   — 价格随时间演化

作者会读: 整个文件 ~300 行, 初学者也能改
"""

from __future__ import annotations

import os
import random
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

# ------------------------------------------------------------
# 基础配置
# ------------------------------------------------------------

FIG_DIR = Path(__file__).parent / "figures"
FIG_DIR.mkdir(exist_ok=True)

# 中文字体(如果环境支持)
plt.rcParams["font.sans-serif"] = ["PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

random.seed(42)
np.random.seed(42)


# ------------------------------------------------------------
# 核心公式: CUC
# ------------------------------------------------------------

def cuc_price(p0: float, u: float, alpha: float) -> float:
    """
    CUC 定价公式: p(u) = p₀ / (1-u)^α

    Args:
        p0:    底价 (USDC / 1M tokens)
        u:     当前容量利用率, [0, 1)
        alpha: 斜率参数, 越大涨价越激进

    Returns:
        当前报价
    """
    # u 接近 1 时数值保护
    u_clamped = min(u, 0.999)
    return p0 / (1 - u_clamped) ** alpha


# ------------------------------------------------------------
# 实体定义
# ------------------------------------------------------------

@dataclass
class Maker:
    """做市商 (卖家)"""
    name: str
    p0: float           # 底价
    alpha: float        # CUC 斜率
    capacity: float     # 每小时容量 (tokens)
    used: float = 0.0   # 已用容量

    @property
    def utilization(self) -> float:
        return min(self.used / self.capacity, 0.999) if self.capacity > 0 else 0.0

    def quote(self) -> float:
        return cuc_price(self.p0, self.utilization, self.alpha)

    def serve(self, tokens: float) -> bool:
        """尝试服务 tokens 数量, 容量不足返回 False"""
        if self.used + tokens > self.capacity:
            return False
        self.used += tokens
        return True

    def reset(self):
        self.used = 0.0


# ------------------------------------------------------------
# 路由策略
# ------------------------------------------------------------

def greedy_route(makers: list[Maker]) -> Maker | None:
    """贪婪路由: 总是选最便宜的"""
    available = [m for m in makers if m.utilization < 0.99]
    if not available:
        return None
    return min(available, key=lambda m: m.quote())


def softmax_route(makers: list[Maker], beta: float = 3.0) -> Maker | None:
    """概率路由: 按 (1/price)^beta 加权采样"""
    available = [m for m in makers if m.utilization < 0.99]
    if not available:
        return None
    prices = np.array([m.quote() for m in available])
    weights = (1.0 / prices) ** beta
    weights /= weights.sum()
    idx = np.random.choice(len(available), p=weights)
    return available[idx]


# ------------------------------------------------------------
# 图 1: CUC 曲线族 (展示不同 α 的形状)
# ------------------------------------------------------------

def plot_cuc_curves():
    fig, ax = plt.subplots(figsize=(9, 5.5))
    u = np.linspace(0, 0.99, 200)
    p0 = 2.0

    for alpha in [0.3, 0.5, 1.0, 1.5, 2.0]:
        p = [cuc_price(p0, ui, alpha) for ui in u]
        ax.plot(u, p, linewidth=2, label=f"α = {alpha}")

    ax.set_xlabel("容量利用率 u")
    ax.set_ylabel("报价 p (USDC / 1M tokens)")
    ax.set_title(f"CUC 曲线族: p(u) = {p0} / (1-u)^α")
    ax.set_ylim(0, 20)
    ax.axhline(y=p0, linestyle="--", alpha=0.3, color="gray")
    ax.text(0.01, p0 + 0.2, f"底价 p₀ = {p0}", fontsize=9, color="gray")
    ax.legend(loc="upper left")
    ax.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(FIG_DIR / "01_cuc_curves.png", dpi=140)
    plt.close(fig)
    print("[OK] figures/01_cuc_curves.png")


# ------------------------------------------------------------
# 图 2: Quote Depth (报价深度)
# ------------------------------------------------------------

def plot_quote_depth():
    """模拟 10 个做市商, 画出市场的累计报价深度曲线"""
    makers = [
        Maker(f"M{i+1}",
              p0=round(random.uniform(1.5, 3.5), 2),
              alpha=round(random.uniform(0.5, 1.5), 2),
              capacity=random.randint(50_000, 200_000))
        for i in range(10)
    ]

    # 随机分配一些初始用量 (模拟当前已有流量)
    for m in makers:
        m.used = m.capacity * random.uniform(0, 0.4)

    # 对每个价格水平, 计算累计可提供容量
    price_range = np.linspace(1.5, 20, 100)
    depths = []
    for p_target in price_range:
        total = 0
        for m in makers:
            # 解 p_target = p0 / (1-u*)^α 得到 u*
            if p_target < m.p0:
                continue  # 这个价格下该做市商不接单
            u_star = 1 - (m.p0 / p_target) ** (1 / m.alpha)
            u_star = min(u_star, 0.99)
            # 在当前 u 基础上还能卖多少
            available = max(0, m.capacity * u_star - m.used)
            total += available
        depths.append(total)

    fig, ax = plt.subplots(figsize=(9, 5.5))
    ax.plot(price_range, np.array(depths) / 1000, linewidth=2.5, color="#2E7D32")
    ax.fill_between(price_range, 0, np.array(depths) / 1000, alpha=0.2, color="#2E7D32")
    ax.set_xlabel("价格水平 (USDC / 1M tokens)")
    ax.set_ylabel("累计可提供容量 (K tokens/hr)")
    ax.set_title("Quote Depth 示例 — 10 做市商组成的 Claude 市场")
    ax.grid(alpha=0.3)

    # 标注关键点
    for target_p in [3, 5, 10]:
        idx = np.argmin(np.abs(price_range - target_p))
        d = depths[idx] / 1000
        ax.plot(target_p, d, "o", color="red", markersize=8)
        ax.annotate(f"${target_p}: {d:.0f}K",
                    xy=(target_p, d), xytext=(target_p + 0.5, d + 50),
                    fontsize=10, arrowprops=dict(arrowstyle="->", color="gray"))

    fig.tight_layout()
    fig.savefig(FIG_DIR / "02_quote_depth.png", dpi=140)
    plt.close(fig)
    print("[OK] figures/02_quote_depth.png")


# ------------------------------------------------------------
# 图 3: 贪婪路由 vs 概率路由 (羊群效应对比)
# ------------------------------------------------------------

def simulate_routing(strategy: str, n_requests: int = 500):
    """模拟一批请求, 返回每个做市商被选中的次数和最终利用率"""
    makers = [
        Maker(f"M{i+1}", p0=2.0, alpha=1.0, capacity=100_000)
        for i in range(5)
    ]
    # 初始利用率略有差异
    for i, m in enumerate(makers):
        m.used = m.capacity * (0.1 + 0.05 * i)  # M1 最空, M5 最满

    hit_counts = [0] * len(makers)
    u_history = [[] for _ in makers]

    route_fn = greedy_route if strategy == "greedy" else softmax_route

    for _ in range(n_requests):
        chosen = route_fn(makers)
        if chosen is None:
            break
        chosen.serve(500)  # 每单 500 tokens
        idx = makers.index(chosen)
        hit_counts[idx] += 1
        for i, m in enumerate(makers):
            u_history[i].append(m.utilization)

    return makers, hit_counts, u_history


def plot_greedy_vs_softmax():
    fig, axes = plt.subplots(1, 2, figsize=(14, 5.5))

    for ax, strategy, title in [
        (axes[0], "greedy", "贪婪路由 (羊群效应)"),
        (axes[1], "softmax", "概率路由 β=3 (流量分散)"),
    ]:
        makers, hits, u_history = simulate_routing(strategy)
        names = [m.name for m in makers]
        final_u = [m.utilization for m in makers]

        x = np.arange(len(makers))
        bars = ax.bar(x, hits, color=["#1976D2", "#388E3C", "#F57C00", "#C2185B", "#512DA8"])
        ax.set_xticks(x)
        ax.set_xticklabels(names)
        ax.set_ylabel("被选中次数")
        ax.set_title(title)
        ax.grid(alpha=0.3, axis="y")

        # 标注最终利用率
        for i, (bar, u) in enumerate(zip(bars, final_u)):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 3,
                    f"u={u:.2f}", ha="center", fontsize=9)

    fig.suptitle("500 笔请求在 5 个做市商间的分布", fontsize=13)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "03_greedy_vs_softmax.png", dpi=140)
    plt.close(fig)
    print("[OK] figures/03_greedy_vs_softmax.png")


# ------------------------------------------------------------
# 图 4: 价格随时间演化 (震荡 vs 稳定)
# ------------------------------------------------------------

def plot_price_over_time():
    """模拟 1000 tick, 对比两种策略下的价格稳定性"""
    fig, axes = plt.subplots(1, 2, figsize=(14, 5.5), sharey=True)

    for ax, strategy, title in [
        (axes[0], "greedy", "贪婪路由下价格震荡"),
        (axes[1], "softmax", "概率路由下价格稳定"),
    ]:
        makers = [
            Maker(f"M{i+1}", p0=2.0, alpha=1.0, capacity=100_000)
            for i in range(5)
        ]
        for i, m in enumerate(makers):
            m.used = m.capacity * (0.1 + 0.05 * i)

        route_fn = greedy_route if strategy == "greedy" else softmax_route

        price_history = [[] for _ in makers]
        ticks = range(1000)
        for _ in ticks:
            chosen = route_fn(makers)
            if chosen is not None:
                chosen.serve(300)
            for i, m in enumerate(makers):
                price_history[i].append(m.quote())

        for i, (m, hist) in enumerate(zip(makers, price_history)):
            ax.plot(ticks, hist, label=m.name, alpha=0.85, linewidth=1.3)

        ax.set_xlabel("时间 (tick)")
        ax.set_ylabel("报价 (USDC / 1M tokens)")
        ax.set_title(title)
        ax.set_ylim(0, 20)
        ax.legend(loc="upper left", fontsize=9)
        ax.grid(alpha=0.3)

    fig.tight_layout()
    fig.savefig(FIG_DIR / "04_price_over_time.png", dpi=140)
    plt.close(fig)
    print("[OK] figures/04_price_over_time.png")


# ------------------------------------------------------------
# 入口
# ------------------------------------------------------------

def main():
    print("\n🚀 AIMM CUC 仿真 — 开始生成图表\n")
    plot_cuc_curves()
    plot_quote_depth()
    plot_greedy_vs_softmax()
    plot_price_over_time()
    print(f"\n✅ 全部完成. 图表输出在: {FIG_DIR}\n")
    print("可以把这些图放进白皮书 / 博客 / Pinned Tweet 里作为配图.\n")


if __name__ == "__main__":
    main()
