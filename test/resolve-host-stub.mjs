// 解析钩子：dsh 宿主包（peer）在测试/CI 环境里通常不存在，缺失时用最小桩替代。
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const HOST_PACKAGES = {
  "@deepseek-ai/schemastery": "./stub-schemastery.mjs",
  "@deepseek-ai/cordis": "./stub-cordis.mjs",
};

export async function resolve(specifier, context, next) {
  const stub = HOST_PACKAGES[specifier];
  if (stub) {
    try {
      return await next(specifier, context); // 真包装了就用真包
    } catch {
      return { url: new URL(stub, import.meta.url).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
