// 让测试在"没有 dsh 宿主包"的环境里也能跑：
// 真包在就用真包，缺失就落到 test/stub-*.mjs。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./resolve-host-stub.mjs", pathToFileURL(import.meta.filename));
