// 最小 schemastery 桩：只支持本项目用到的那点 API（object / default / required / parse）。
const field = () => {
  const f = {
    _default: undefined,
    _required: false,
    default(v) { f._default = typeof v === "function" ? v() : v; return f; },
    required() { f._required = true; return f; },
  };
  return f;
};

const schema = (shape) => ({
  shape,
  parse(input = {}) {
    const out = {};
    for (const [k, f] of Object.entries(shape)) {
      if (input[k] !== undefined) out[k] = input[k];
      else if (f && f._default !== undefined) out[k] = f._default;
      else if (f && f._required) throw new Error(`missing required config: ${k}`);
    }
    return { ...input, ...out };
  },
});

export default {
  object: (shape) => schema(shape),
  string: () => field(),
  number: () => field(),
  boolean: () => field(),
};
