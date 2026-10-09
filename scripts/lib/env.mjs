export function readOptionalEnv(name, env = process.env) {
  const raw = env[name];
  if (raw == null) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readCsvEnv(name, env = process.env) {
  const raw = readOptionalEnv(name, env);
  if (!raw) {
    return [];
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}
