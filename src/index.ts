/**
 * aidcp-api 的公共出口。
 *
 * **组装根与启动入口不在这里出口。** `server.ts` 是本进程的装配（建池、注册路由、起定时器），
 * `api-service-entry.ts` 是可执行入口（门 → 建根 → 监听 → 信号）。把任何一个挂进公共出口，
 * 意味着 `import 'aidcp-api'` 会顺带把这些副作用拉进调用方进程——今天 `server.ts` 靠一个
 * 「是不是被直接执行」的判断挡着，那道判断是运行期的，出口列表却是编译期的事实：
 * 只要它在列表里，任何一次意外的顶层求值都能把整套装配拽起来。
 *
 * 所以这份清单按**正向**写：只列本仓愿意被别人 import 的能力面，
 * 而不是「排除掉某个名字」——正向写法在新增文件时默认安全，反向写法默认危险。
 */
export * from './account-store.js';
export * from './client-auth/index.js';
export * from './config/index.js';
export * from './feishu/index.js';
export * from './interactions/interaction-api-writes.js';
export * from './panel/index.js';
export * from './publish-agent/publish-log-store.js';
