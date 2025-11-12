// scripts/bench.ts
// 基于 Bun + TypeScript 的轻量基准测试（零依赖）
//
// 覆盖：低/中/高压力；开启/关闭中间件；阻断比例/超时比例；优先级分层；多事件类型。
// 输出：吞吐 ops/sec、平均耗时、p50/p95/p99 延迟（纳秒），以及 publish 总耗时。
// 注意：这是“合成负载”参考，性能主要取决于你的 handler 工作量与中间件内容；
//      真实场景请按你自己的业务混合负载微调。

// 对，这个也是 ChatGPT 纯手工生成，不包含任何一点含人量
// 我这个人不是很擅长跟ai讲话，prompt写的不好，所以这个bench效果可能比图一乐还要打个折扣
//
// 本来事件总线上的性能瓶颈就在 handler 上，一般来讲没有太大硬伤的话总线本身的性能没什么量化的办法...吧？
// 或者只是单纯是我不明白这种东西的性能要怎么测，如果你有更好的想法欢迎提 PR
//
// 总而言之，图一乐，仅供参考，没什么实际价值

import {
    UmiriEventBus,
    on,
    type IUmiriEvent,
    type EventHandler
} from "../src/index";

// -------- 工具：计时与统计 --------
const nsNow = () => {
    // process.hrtime.bigint 在 Bun/Node 都可用
    return Number(process.hrtime.bigint()); // 纳秒
};

function stats(nsList: number[]) {
    const n = nsList.length;
    const sorted = [...nsList].sort((a, b) => a - b);
    const sum = nsList.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const pick = (p: number) => {
        const idx = Math.min(n - 1, Math.max(0, Math.floor(p * n)));
        return sorted[idx];
    };
    return {
        count: n,
        min: sorted[0],
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        max: sorted[n - 1],
        mean
    };
}

function fmtNs(ns: number) {
    // 统一展示微秒/毫秒的直觉：优先 μs，> 1e6 则 ms
    if (ns >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
    if (ns >= 1e3) return `${(ns / 1e3).toFixed(3)} μs`;
    return `${ns} ns`;
}

// -------- 事件类型/类 --------
enum T {
    A = 1,
    B = 2,
    C = 3
}

class AEvent implements IUmiriEvent {
    static getType() {
        return [T.A];
    }
    getType() {
        return [T.A];
    }
    constructor(public payload?: any) {}
}

class BEvent implements IUmiriEvent {
    static getType() {
        return [T.B];
    }
    getType() {
        return [T.B];
    }
}

class CEvent implements IUmiriEvent {
    static getType() {
        return [T.C];
    }
    getType() {
        return [T.C];
    }
}

// -------- 可调参数（Bench 预设） --------
type CostKind = "noop" | "micro-cpu" | "light-async" | "heavy-async";

type Preset = {
    name: string;
    handlers: number; // 处理器总数量
    priorities: number; // 优先级层数（从高到低均匀分布）
    typesPerHandler: number; // 每个 handler 订阅几种事件类型（1~3）
    cost: CostKind; // 处理成本模型
    timeoutRatio: number; // 有超时的处理器比例（0~1）
    timeoutMs: number; // 超时时长
    blockRatio: number; // block=true 的处理器比例
    publishes: number; // publish 的次数
    eventMix: number[]; // 发布事件类型分布：如 [0.5, 0.3, 0.2] => A/B/C
    withMiddlewares: boolean; // 是否启用中间件（影响注册/发布/阻断）
};

const PRESETS: Preset[] = [
    // 低压力：少量 handler，CPU 与 IO 都很轻
    {
        name: "LOW  | noop cost, no middlewares",
        handlers: 16,
        priorities: 2,
        typesPerHandler: 1,
        cost: "noop",
        timeoutRatio: 0,
        timeoutMs: 0,
        blockRatio: 0.05,
        publishes: 5_000,
        eventMix: [0.7, 0.2, 0.1],
        withMiddlewares: false
    },
    {
        name: "LOW  | noop cost, with middlewares",
        handlers: 16,
        priorities: 2,
        typesPerHandler: 1,
        cost: "noop",
        timeoutRatio: 0,
        timeoutMs: 0,
        blockRatio: 0.05,
        publishes: 5_000,
        eventMix: [0.7, 0.2, 0.1],
        withMiddlewares: true
    },

    // 中等压力：更多 handler，适度 CPU/微异步
    {
        name: "MED  | micro-cpu cost, no middlewares",
        handlers: 128,
        priorities: 3,
        typesPerHandler: 2,
        cost: "micro-cpu",
        timeoutRatio: 0.1,
        timeoutMs: 2,
        blockRatio: 0.1,
        publishes: 3_000,
        eventMix: [0.6, 0.3, 0.1],
        withMiddlewares: false
    },
    {
        name: "MED  | light-async cost, with middlewares",
        handlers: 128,
        priorities: 3,
        typesPerHandler: 2,
        cost: "light-async",
        timeoutRatio: 0.1,
        timeoutMs: 2,
        blockRatio: 0.1,
        publishes: 3_000,
        eventMix: [0.6, 0.3, 0.1],
        withMiddlewares: true
    },

    // 高压力：大量 handler，多优先级，重异步
    {
        name: "HIGH | heavy-async cost, with middlewares",
        handlers: 1000,
        priorities: 5,
        typesPerHandler: 3,
        cost: "heavy-async",
        timeoutRatio: 0.2,
        timeoutMs: 3,
        blockRatio: 0.15,
        publishes: 1_000,
        eventMix: [0.5, 0.3, 0.2],
        withMiddlewares: true
    }
];

// -------- 成本模型实现 --------
function makeHandle(cost: CostKind): (payload: any) => Promise<boolean> {
    switch (cost) {
        case "noop":
            return async () => true;
        case "micro-cpu":
            return async () => {
                // 轻度 CPU：小循环 + 位运算
                let x = 0;
                for (let i = 0; i < 200; i++) x = (x ^ i) & 0xffff;
                return x >= -1; // true
            };
        case "light-async":
            return async () => {
                // 微异步（一次微任务）
                await Promise.resolve();
                return true;
            };
        case "heavy-async":
            return async () => {
                // 模拟 IO-ish：等待 1ms 左右
                await new Promise((r) => setTimeout(r, 1));
                return true;
            };
    }
}

// -------- 中间件（可开关） --------
function installMiddlewares(bus: UmiriEventBus, enabled: boolean) {
    if (!enabled) return;

    // 轻量 beforeRegister/afterRegister
    bus.useBeforeRegister((h) => ({
        handler: h,
        cancel: false
    })).useAfterRegister((_h) => {
        /* no-op */
    });

    // beforeUnregister/afterUnregister
    bus.useBeforeUnregister((h) => ({
        handler: h,
        cancel: false
    })).useAfterUnregister((_h) => {
        /* no-op */
    });

    // beforePublish：浅包装 event，不取消
    bus.useBeforePublish((e) => ({ event: e, cancel: false }));

    // beforePriorityCheck：原样透传，但保留钩子开销
    bus.useBeforePriorityCheck((_p, hs) => ({ handlers: hs, cancel: false }));

    // beforeBlockCheck：默认不取消阻断
    bus.useBeforeBlockCheck((h) => ({ handler: h, cancel: false }));

    // afterPublish：统计 executed 的长度（不做输出，避免 IO 干扰）
    bus.useAfterPublish((_e, executed) => {
        void executed.length;
    });
}

// -------- handler 构造与注册 --------
function registerHandlers(bus: UmiriEventBus, preset: Preset) {
    const pickTypes = (k: number) => {
        // 从 A/B/C 中选 k 个
        const all = [AEvent, BEvent, CEvent] as const;
        const chosen: any[] = [];
        for (let i = 0; i < k; i++) chosen.push(all[i % all.length]);
        return chosen;
    };

    const handle = makeHandle(preset.cost);
    const hList: EventHandler[] = [];

    for (let i = 0; i < preset.handlers; i++) {
        const priority = preset.priorities - (i % preset.priorities); // 高到低均匀分布
        const block = Math.random() < preset.blockRatio;
        const useTimeout = Math.random() < preset.timeoutRatio;
        const timeout = useTimeout ? preset.timeoutMs : 0;

        const classes = pickTypes(preset.typesPerHandler);
        const h = on(...classes)
            .priority(priority)
            .block(block)
            .timeout(timeout)
            .handle(async (e) => {
                // 让不同事件类型触发略微不同的成本
                if (e instanceof BEvent && preset.cost === "micro-cpu") {
                    // 再稍微加一点点 CPU
                    let acc = 0;
                    for (let j = 0; j < 50; j++) acc += j & 7;
                    void acc;
                }
                return handle((e as any).payload);
            })
            .build();

        hList.push(h);
        bus.register(h);
    }

    return hList;
}

/**
 * -------- 事件混合生成 --------
 * 修复报错：
 * 1. mix[0]、mix[1] 可能 undefined，需加默认值。
 * 2. new BEvent(2)、new CEvent(3) 报错，因 BEvent/CEvent 构造函数无参数。
 */
function makeEventGenerator(mix: number[]) {
    // mix: [pA, pB, pC]
    const total = mix.reduce((a, b) => a + b, 0) || 1;
    const pA = (mix[0] ?? 0) / total;
    const pB = (mix[1] ?? 0) / total;
    return () => {
        const r = Math.random();
        if (r < pA) return new AEvent(1);
        if (r < pA + pB) return new BEvent();
        return new CEvent();
    };
}

// -------- 单个 preset 的跑法 --------
async function runPreset(preset: Preset) {
    globalThis.gc?.(); // 如果用 node --expose-gc，可减少噪声

    const bus = new UmiriEventBus();
    installMiddlewares(bus, preset.withMiddlewares);
    registerHandlers(bus, preset);

    // 预热：避免 JIT 抖动影响（不计入统计）
    const warmupGen = makeEventGenerator(preset.eventMix);
    for (let i = 0; i < 500; i++) await bus.publish(warmupGen());

    const gen = makeEventGenerator(preset.eventMix);

    const durations: number[] = [];
    const startAll = nsNow();
    for (let i = 0; i < preset.publishes; i++) {
        const t0 = nsNow();
        await bus.publish(gen());
        const t1 = nsNow();
        durations.push(t1 - t0);
    }
    const endAll = nsNow();

    const s = stats(durations);
    const totalNs = endAll - startAll;
    const totalMs = totalNs / 1e6;
    const opsSec = (preset.publishes / (totalNs / 1e9)).toFixed(0);

    // 输出
    console.log(
        "\n────────────────────────────────────────────────────────────"
    );
    console.log(preset.name);
    console.log(
        `handlers=${preset.handlers}, priorities=${preset.priorities}, typesPerHandler=${preset.typesPerHandler}`
    );
    console.log(
        `cost=${preset.cost}, timeoutRatio=${preset.timeoutRatio}, timeoutMs=${preset.timeoutMs}, blockRatio=${preset.blockRatio}`
    );
    console.log(
        `withMiddlewares=${preset.withMiddlewares}, publishes=${preset.publishes}`
    );
    console.log(
        `total: ${totalMs.toFixed(1)} ms  |  throughput: ${opsSec} ops/sec`
    );
    // 修复报错：fmtNs 参数可能为 undefined，需加默认值
    console.log(
        `latency: min=${fmtNs(s.min ?? 0)}  p50=${fmtNs(s.p50 ?? 0)}  p95=${fmtNs(s.p95 ?? 0)}  p99=${fmtNs(s.p99 ?? 0)}  max=${fmtNs(s.max ?? 0)}  avg=${fmtNs(s.mean ?? 0)}`
    );
}

(async () => {
    console.log("UmiriEventBus Benchmark (Bun)");
    console.log(
        "Tips: 为了更稳定的结果，建议关闭其他负载、使用固定 CPU 频率、并多跑几次取中位值。"
    );
    for (const p of PRESETS) {
        await runPreset(p);
    }
})();
