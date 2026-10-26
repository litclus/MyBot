import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import {
  applySetting,
  findSetting,
  initialSettingValue,
  normalizeSetting,
  SETTING_DEFS,
  settingValue,
  type SettingDef,
} from "./schema.js";

export type StoredSetting = {
  key: string;
  value: unknown;
  updatedAt: Date;
};

export async function loadRuntimeSettings(): Promise<Record<string, unknown>> {
  const rows = await db.select().from(appSettings);
  const values: Record<string, unknown> = {};
  for (const row of rows) {
    const def = findSetting(row.key);
    if (!def) continue;
    try {
      const value = normalizeSetting(def, row.value);
      applySetting(def.key, value);
      values[row.key] = value;
    } catch {
      // 忽略坏掉的单条配置，不影响启动
    }
  }
  return values;
}

export async function saveRuntimeSettings(
  input: Record<string, unknown>,
): Promise<{ changed: string[]; restartRequired: string[] }> {
  // 先全部校验，避免写到一半才失败
  const updates: Array<{ def: SettingDef; key: string; value: unknown }> = [];
  for (const [key, raw] of Object.entries(input)) {
    const def = findSetting(key);
    if (!def) throw new Error(`未知配置项 ${key}`);
    updates.push({ def, key, value: normalizeSetting(def, raw) });
  }

  // 一次事务写库，失败就全部回滚，内存里的 config 也不动
  await db.transaction(async (tx) => {
    for (const { key, value } of updates) {
      await tx
        .insert(appSettings)
        .values({ key, value })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedAt: new Date() },
        });
    }
  });

  const changed: string[] = [];
  const restartRequired: string[] = [];
  for (const { def, key, value } of updates) {
    applySetting(def.key, value);
    changed.push(key);
    if (def.restart) restartRequired.push(key);
  }
  return { changed, restartRequired };
}

export function panelSettings(): Array<{
  key: string;
  label: string;
  group: string;
  kind: string;
  restart: boolean;
  secret: boolean;
  hint?: string;
  options?: string[];
  value: unknown;
  configured: boolean;
  length?: number;
}> {
  return SETTING_DEFS.map((def) => {
    const value = settingValue(def.key);
    const secret = def.secret ?? false;
    const secretLength = typeof value === "string" ? value.length : 0;
    return {
      key: def.key,
      label: def.label,
      group: def.group,
      kind: def.kind,
      restart: def.restart ?? false,
      secret,
      ...(def.hint ? { hint: def.hint } : {}),
      ...(def.options ? { options: def.options } : {}),
      value: secret ? null : value,
      configured: secret ? secretLength > 0 : true,
      ...(secret ? { length: secretLength } : {}),
    };
  });
}

/** 删除面板覆盖项，并恢复到启动时的 .env 值；返回是否真的删掉了覆盖项 */
export async function deleteRuntimeSetting(key: string): Promise<boolean> {
  const def = findSetting(key);
  if (!def) throw new Error(`未知配置项 ${key}`);
  const rows = await db
    .delete(appSettings)
    .where(eq(appSettings.key, key))
    .returning({ key: appSettings.key });
  applySetting(def.key, initialSettingValue(def.key));
  return rows.length > 0;
}
