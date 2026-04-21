// Minimal JSON Schema validator(零依赖)。
// 覆盖 review-output.schema.json 实际用到的关键字:
// type / enum / required / additionalProperties / minLength / minimum /
// maximum / properties / items(object+array 的递归)。
//
// 返回 null = 合法;返回 errors[] = 非法,每项 { instancePath, message }。
//
// 故意不支持完整 JSON Schema — 只覆盖 review schema 用到的,保证校验到位
// 的同时不把 plugin 变成 ajv 壳子。Schema 扩展要先扩这里,再跑测试。

const TYPE_CHECK = {
  string: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number",
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  array: (v) => Array.isArray(v),
  object: (v) => v != null && typeof v === "object" && !Array.isArray(v),
};

function push(errors, path, message) {
  errors.push({ instancePath: path || "/", message });
}

function validateNode(data, schema, path, errors) {
  if (schema == null) return;

  // type
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((t) => TYPE_CHECK[t]?.(data));
    if (!ok) {
      push(errors, path, `expected type ${types.join("|")}, got ${typeof data}`);
      return; // 类型错了后面约束都没意义
    }
  }

  // enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      push(errors, path, `value not in enum [${schema.enum.join(", ")}]`);
    }
  }

  // string constraints
  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      push(errors, path, `string shorter than minLength ${schema.minLength}`);
    }
  }

  // number constraints
  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      push(errors, path, `value ${data} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      push(errors, path, `value ${data} > maximum ${schema.maximum}`);
    }
  }

  // object:required + properties + additionalProperties
  if (TYPE_CHECK.object(data)) {
    for (const req of schema.required ?? []) {
      if (!(req in data)) push(errors, `${path}/${req}`, `required property missing`);
    }
    if (schema.properties) {
      for (const [k, propSchema] of Object.entries(schema.properties)) {
        if (k in data) {
          validateNode(data[k], propSchema, `${path}/${k}`, errors);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      for (const k of Object.keys(data)) {
        if (!allowed.has(k)) {
          push(errors, `${path}/${k}`, `additional property not allowed`);
        }
      }
    }
  }

  // array:items(单 schema,不支持 tuple form)
  if (TYPE_CHECK.array(data) && schema.items) {
    for (let i = 0; i < data.length; i++) {
      validateNode(data[i], schema.items, `${path}/${i}`, errors);
    }
  }
}

/**
 * 校验 data 是否满足 schema。
 * @returns {null | Array<{ instancePath: string, message: string }>}
 */
export function validateReviewOutput(data, schema) {
  const errors = [];
  validateNode(data, schema, "", errors);
  return errors.length ? errors : null;
}
