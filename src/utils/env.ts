export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseJsonStringArray(value: string | undefined, fallback: string[] = []): string[] {
  if (!value || value.trim() === '') {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return fallback;
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    const trimmed = value.trim();
    const bracketMatch = trimmed.match(/^\[(.*)\]$/s);
    const rawItems = bracketMatch ? bracketMatch[1].split(',') : trimmed.split(',');
    const parsed = rawItems
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
  }
}
