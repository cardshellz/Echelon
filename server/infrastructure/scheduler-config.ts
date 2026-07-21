export function envFlagEnabled(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[name] === "true";
}

export function getSchedulerDisableReason(
  disableEnvName?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (envFlagEnabled("DISABLE_SCHEDULERS", env)) {
    return "DISABLE_SCHEDULERS=true";
  }

  if (disableEnvName && envFlagEnabled(disableEnvName, env)) {
    return `${disableEnvName}=true`;
  }

  return null;
}

export function schedulerIsDisabled(
  disableEnvName?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getSchedulerDisableReason(disableEnvName, env) !== null;
}

export function envPositiveInteger(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function envBoundedPositiveInteger(
  name: string,
  fallback: number,
  maximum: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new Error(`Maximum for ${name} must be a positive integer`);
  }
  if (!Number.isSafeInteger(fallback) || fallback <= 0 || fallback > maximum) {
    throw new Error(`Fallback for ${name} must be an integer between 1 and ${maximum}`);
  }

  const value = Number(env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}
