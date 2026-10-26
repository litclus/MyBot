import assert from "node:assert/strict";
import {
  DEFAULT_PERSONA_TEMPLATE,
  DEFAULT_SYSTEM_TEMPLATE,
  loadPromptTemplate,
  renderSystemPrompt,
} from "../../src/agent/prompt.js";

const systemTemplate = loadPromptTemplate("prompts/system.md", DEFAULT_SYSTEM_TEMPLATE);
const personaTemplate = loadPromptTemplate("prompts/persona.md", DEFAULT_PERSONA_TEMPLATE);

assert.ok(systemTemplate.includes("memory_search"), "系统提示词应包含工具规则");
assert.ok(!systemTemplate.includes("{{name}}"), "运行规则里不应出现名字占位符");
assert.ok(personaTemplate.includes("{{name}}"), "人设提示词应包含名字占位符");
assert.ok(personaTemplate.includes("{{nicknames}}"), "人设提示词应包含昵称占位符");

const system = renderSystemPrompt(systemTemplate, { name: "小Q" });
const persona = renderSystemPrompt(personaTemplate, {
  name: "小Q",
  nicknames: ["鲸鲸", "鲸鱼", "小Q"],
});

assert.ok(persona.includes("小Q"), "人设里没有注入名字");
assert.ok(!persona.includes("{{name}}"), "人设占位符没有被替换");
assert.ok(!persona.includes("{{nicknames}}"), "昵称占位符没有被替换");
assert.ok(persona.includes("鲸鲸") && persona.includes("鲸鱼"), "人设里没有注入昵称");
assert.ok(!system.includes("{{"), "运行规则里不应残留占位符");
assert.ok(!system.includes("老群友"), "运行规则不应混入人设");
assert.ok(!persona.includes("memory_search"), "人设不应混入工具规则");

assert.equal(
  renderSystemPrompt("{{nicknames}}", { name: "小Q", nicknames: ["鲸鲸", "鲸鲸", "鲸鱼"] }),
  "鲸鲸、鲸鱼",
  "重复的昵称只留一次",
);
assert.equal(
  renderSystemPrompt("{{nicknames}}", { name: "小Q", nicknames: ["小Q"] }),
  "小Q",
  "昵称与名字相同也要保留",
);
assert.equal(
  renderSystemPrompt("{{nicknames}}", { name: "小Q" }),
  "小Q",
  "没有昵称时应回落到名字",
);

console.log("PROMPT OK");
console.log("--- system ---");
console.log(system.split("\n").slice(0, 3).join("\n"));
console.log("--- persona ---");
console.log(persona.split("\n").slice(0, 3).join("\n"));
