// 最小 schemastery 桩：只支持本项目用到的那点 API（object / default / required）。
//
// ★ 桩必须跟着**真包 API** 长：真包返回的是**可调用的 schema**（`Config({})` 应用默认值），
//   并没有 `.parse` 方法。桩要是只给 `.parse`，就会「本地用桩全绿、线上装了真包当场崩」
//   —— 实测事故：`TypeError: Config.parse is not a function`。
const field = () => {
  const f = {
    _default: undefined,
    _required: false,
    default(v) { f._default = typeof v === "function" ? v() : v; return f; },
    required() { f._required = true; return f; },
  };
  return f;
};

const schema = (shape) => {
  const parse = (input = {}) => {
    const out = {};
    for (const [k, f] of Object.entries(shape)) {
      if (input[k] !== undefined) out[k] = input[k];
      else if (f && f._default !== undefined) out[k] = f._default;
      else if (f && f._required) throw new Error(`missing required config: ${k}`);
    }
    return { ...input, ...out };
  };
  parse.shape = shape;
  parse.parse = parse; // 兼容旧写法（真包没有，但留着不影响）
  return parse;
};

export default {
  object: (shape) => schema(shape),
  string: () => field(),
  number: () => field(),
  boolean: () => field(),
  array: () => field(),
};
