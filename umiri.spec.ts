// umiri.spec.ts
//
// 纯正 ChatGPT 手工生成，没有一丁点含人量
// 看我干什么，你难道觉得我会做测试吗，太高估我了吧？
// 感谢 GPT 桑捏
//
import { describe, it, expect } from "vitest";
import {
	UmiriEventBus,
	on,
	type IUmiriEvent,
	type EventHandler
} from "./src/index";

// —— 测试辅助 —— //
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 事件类型
enum T {
	A = 1,
	B = 2,
	C = 3
}

// 事件类：同时提供静态与实例 getType，以覆盖 extractTypes 的两种分支
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

// =============== 基础：事件 & 构建器 & 冻结 ===============
describe("event & builder", () => {
	it("on(builder) 正确提取 targets（静态+实例），且去重", () => {
		const h = on(AEvent, AEvent, BEvent)
			.priority(3)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();

		expect(new Set(h.targets)).toEqual(new Set([T.A, T.B]));
		expect(h.priority).toBe(3);
		// 冻结：不可修改
		expect(Object.isFrozen(h)).toBe(true);
	});

	it("handler 是冻结的，外部修改无效", () => {
		const h = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();
		expect(() => (h.priority = 999)).toThrow();
	});
});

// =============== 注册 / 注销 / 去重 / 清理 ===============
describe("register/unregister dedupe & cleanup", () => {
	it("同一 handler 重复注册同一类型不会重复执行；targets 去重", async () => {
		const bus = new UmiriEventBus();
		let count = 0;

		const h: EventHandler = Object.freeze({
			targets: [T.A, T.A],
			priority: 5,
			block: false,
			timeout: 0,
			handle: async () => {
				count++;
				return true;
			}
		});

		const off1 = bus.register(h);
		const off2 = bus.register(h);
		await bus.publish(new AEvent());
		expect(count).toBe(1);

		// 反复注销不应抛错
		off1();
		off2();
		await bus.publish(new AEvent());
		expect(count).toBe(1);
	});

	it("注销后空桶与空优先级会被清理", () => {
		const bus = new UmiriEventBus();
		const h = on(AEvent)
			.priority(7)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();
		const off = bus.register(h);
		off();

		const anyBus = bus as any;
		expect(anyBus.handlerMap.get(7)).toBeUndefined();
		expect(anyBus.priorities.includes(7)).toBe(false);
	});
});

// =============== 发布顺序 & 并发 ===============
describe("publish ordering", () => {
	it("高优先级先于低优先级；同优先级并发都能运行", async () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		// 同优先级两个并发
		const same1 = on(AEvent)
			.priority(10)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("10-a");
				return true;
			})
			.build();
		const same2 = on(AEvent)
			.priority(10)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("10-b");
				return true;
			})
			.build();
		const low = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("1");
				return true;
			})
			.build();

		bus.register(low);
		bus.register(same1);
		bus.register(same2);

		await bus.publish(new AEvent());

		// 两个 10 应早于 1；顺序不强制，但 1 必须在两者之后
		const idx1 = taps.indexOf("1");
		expect(idx1).toBeGreaterThan(-1);
		expect(idx1).toBeGreaterThan(taps.indexOf("10-a"));
		expect(idx1).toBeGreaterThan(taps.indexOf("10-b"));
	});
});

// =============== 阻断 & afterPublish & beforeBlockCheck ===============
describe("block & afterPublish & beforeBlockCheck", () => {
	it("block=true 且返回 true 时阻断后续优先级；afterPublish 一定执行", async () => {
		const bus = new UmiriEventBus();
		const seen: string[] = [];
		(bus as any).useAfterPublish?.call(
			bus,
			(e: IUmiriEvent, executed: EventHandler[]) => {
				seen.push("after");
				expect(executed.length).toBe(1); // 仅 block 成功那个
			}
		);

		const blocker = on(AEvent)
			.priority(9)
			.block(true)
			.timeout(0)
			.handle(async () => true)
			.build();
		const low = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => {
				seen.push("low");
				return true;
			})
			.build();

		bus.register(blocker);
		bus.register(low);
		await bus.publish(new AEvent());

		expect(seen).not.toContain("low");
		expect(seen).toContain("after");
	});

	it("beforeBlockCheck 可以取消阻断", async () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		bus.useBeforeBlockCheck((_h) => ({ handler: _h, cancel: true })); // 取消阻断

		const blocker = on(AEvent)
			.priority(9)
			.block(true)
			.timeout(0)
			.handle(async () => true)
			.build();
		const low = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("low");
				return true;
			})
			.build();

		bus.register(blocker);
		bus.register(low);
		await bus.publish(new AEvent());

		expect(taps).toContain("low"); // 阻断被取消
	});

	it("beforePublish cancel 会跳过发布，且（按你当前语义）不触发 afterPublish", async () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];
		bus.useBeforePublish((e) => ({ event: e, cancel: true }));
		bus.useAfterPublish((_e, _executed) => {
			taps.push("after");
		});

		await bus.publish(new AEvent());
		expect(taps).toEqual([]); // 不触发 afterPublish
	});
});

// =============== timeout 语义 & reject 安全 ===============
describe("timeout & rejection safety", () => {
	it("timeout=0 不启用超时：慢 handler 也会完成", async () => {
		const bus = new UmiriEventBus();
		let hit = 0;
		const slow = on(AEvent)
			.priority(3)
			.block(false)
			.timeout(0)
			.handle(async () => {
				await sleep(20);
				hit++;
				return true;
			})
			.build();
		bus.register(slow);

		await bus.publish(new AEvent());
		expect(hit).toBe(1);
	});

	it("timeout>0 超时返回 false，但 handler 仍继续运行", async () => {
		const bus = new UmiriEventBus();
		let called = 0;

		const tooSlow = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(5)
			.handle(async () => {
				await sleep(30); // 超过 timeout
				called++;
				return true;
			})
			.build();

		bus.register(tooSlow);

		await bus.publish(new AEvent());
		// publish 完成时，handler 可能仍在执行
		expect(called).toBe(0);

		// 等它跑完
		await sleep(40);
		expect(called).toBe(1);

		// 并且它不会阻断（即视为失败 false）
		let lowSeen = false;
		const low = on(AEvent)
			.priority(0)
			.block(false)
			.timeout(0)
			.handle(async () => {
				lowSeen = true;
				return true;
			})
			.build();
		bus.register(low);
		await bus.publish(new AEvent());
		expect(lowSeen).toBe(true);
	});

	it("handler reject 不会让 publish 整体失败；其它 handler 仍执行", async () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		const bad = on(AEvent)
			.priority(5)
			.block(false)
			.timeout(0)
			.handle(async () => {
				throw new Error("boom");
			})
			.build();
		const good = on(AEvent)
			.priority(5)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("good");
				return true;
			})
			.build();

		bus.register(bad);
		bus.register(good);

		await expect(bus.publish(new AEvent())).resolves.toBeUndefined();
		expect(taps).toContain("good");
	});
});

// =============== 多事件类型订阅 ===============
describe("multi-type subscription", () => {
	it("同一 handler 订阅多个类型，发布对应类型能命中", async () => {
		const bus = new UmiriEventBus();
		const seen: string[] = [];

		const h = on(AEvent, BEvent)
			.priority(3)
			.block(false)
			.timeout(0)
			.handle(async (e) => {
				seen.push(e.getType()[0] === T.A ? "A" : "B");
				return true;
			})
			.build();

		bus.register(h);
		await bus.publish(new AEvent());
		await bus.publish(new BEvent());

		expect(new Set(seen)).toEqual(new Set(["A", "B"]));
	});
});

// =============== beforePriorityCheck 过滤 & 快照清理 ===============
describe("beforePriorityCheck & priority snapshot", () => {
	it("beforePriorityCheck 可以过滤当前优先级的 handlers", async () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		const keep = on(AEvent)
			.priority(8)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("keep");
				return true;
			})
			.build();
		const drop = on(AEvent)
			.priority(8)
			.block(false)
			.timeout(0)
			.handle(async () => {
				taps.push("drop");
				return true;
			})
			.build();

		bus.register(keep);
		bus.register(drop);

		bus.useBeforePriorityCheck((_priority, handlers) => {
			return {
				handlers: handlers.filter((h) => h === keep),
				cancel: false
			};
		});

		await bus.publish(new AEvent());
		expect(taps).toEqual(["keep"]); // drop 被滤掉
	});

	it("发布期间删除低优先级桶不会破坏迭代；结束后 stale 优先级会被清理", async () => {
		const bus = new UmiriEventBus();
		const high = on(AEvent)
			.priority(10)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();
		const low = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();

		bus.register(high);
		bus.register(low);

		// 在检查 10 的阶段删除 1 的桶
		bus.useBeforePriorityCheck((priority, handlers) => {
			if (priority === 10) {
				const anyBus = bus as any;
				const map: Map<
					number,
					Map<number, Set<EventHandler>>
				> = anyBus.handlerMap;
				map.delete(1);
			}
			return { handlers, cancel: false };
		});

		await bus.publish(new AEvent());

		const anyBus = bus as any;
		expect(anyBus.priorities.includes(1)).toBe(false); // 已清理
		expect(anyBus.priorities.includes(10)).toBe(true);
	});
});

// =============== 中间件链路：注册/注销前后 ===============
describe("register/unregister middlewares", () => {
	it("beforeRegister 可以取消注册；afterRegister 在成功注册后执行", () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		bus.useBeforeRegister((h) => ({ handler: h, cancel: true }));
		bus.useAfterRegister((_h) => {
			taps.push("afterReg");
		});

		const h = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();
		bus.register(h);

		// 被取消注册，所以 afterRegister 不会被调用
		expect(taps).toEqual([]);

		// 取消 before，再注册一次
		(bus as any).beforeRegisterMiddlewares.length = 0;
		bus.register(h);
		expect(taps).toEqual(["afterReg"]);
	});

	it("beforeUnregister 可取消注销；afterUnregister 在成功注销后执行", () => {
		const bus = new UmiriEventBus();
		const taps: string[] = [];

		const h = on(AEvent)
			.priority(2)
			.block(false)
			.timeout(0)
			.handle(async () => true)
			.build();
		const off = bus.register(h);

		bus.useBeforeUnregister((hh) => ({ handler: hh, cancel: true }));
		bus.useAfterUnregister((_h) => {
			taps.push("afterUnreg");
		});

		off(); // 被取消，不应触发 afterUnregister
		expect(taps).toEqual([]);

		// 移除取消中间件
		(bus as any).beforeUnregisterMiddlewares.length = 0;

		// 只做一次真正的注销
		const off2 = bus.register(h);
		off2();

		expect(taps).toEqual(["afterUnreg"]); // ✅ 现在只会触发一次
	});
});

// =============== 黑盒性能压力测试 ===============
describe("blackbox performance stress test", () => {
	it("massive duplicate registrations still dedupe efficiently", async () => {
		const bus = new UmiriEventBus();
		let count = 0;
		const handler = on(AEvent)
			.priority(1)
			.block(false)
			.timeout(0)
			.handle(async () => {
				count++;
				return true;
			})
			.build();

		for (let i = 0; i < 10000; i++) {
			bus.register(handler);
		}
		await bus.publish(new AEvent());
		expect(count).toBe(1);
	});
});
