import { config } from "../config.js";

type LogFn = (...args: unknown[]) => void;

export type Logger = {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
};

const LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function stamp(): string {
  return new Date().toISOString();
}

function enabled(level: number): boolean {
  const minimum = LEVELS[config.LOG_LEVEL] ?? LEVELS.info!;
  return level >= minimum;
}

export const logger: Logger = {
  debug: (...args) => {
    if (enabled(LEVELS.debug!)) console.debug(stamp(), ...args);
  },
  info: (...args) => {
    if (enabled(LEVELS.info!)) console.info(stamp(), ...args);
  },
  warn: (...args) => {
    if (enabled(LEVELS.warn!)) console.warn(stamp(), ...args);
  },
  error: (...args) => {
    if (enabled(LEVELS.error!)) console.error(stamp(), ...args);
  },
};
