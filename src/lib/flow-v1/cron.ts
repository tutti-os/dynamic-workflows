export class FlowV1CronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowV1CronError";
  }
}

type CronField = {
  values: Set<number>;
  wildcard: boolean;
};

type ParsedCron = {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function validateFlowV1Cron(expression: string): void {
  parseCron(expression);
}

export function nextFlowV1CronFire(input: {
  expression: string;
  timezone: string;
  after: string | Date;
}): string {
  const cron = parseCron(input.expression);
  const after =
    input.after instanceof Date ? input.after : new Date(input.after);
  if (!Number.isFinite(after.getTime())) {
    throw new FlowV1CronError("Cron base time is invalid.");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: input.timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      weekday: "short",
    });
  } catch {
    throw new FlowV1CronError(`Invalid IANA timezone: ${input.timezone}.`);
  }

  const start =
    Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const searchLimit = start + 366 * 24 * 60 * 60_000 * 5;
  for (let time = start; time <= searchLimit; time += 60_000) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(time))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const minute = Number(parts.minute);
    const hour = Number(parts.hour);
    const day = Number(parts.day);
    const month = Number(parts.month);
    const weekday = WEEKDAYS[parts.weekday ?? ""];
    if (
      cron.minute.values.has(minute) &&
      cron.hour.values.has(hour) &&
      cron.month.values.has(month) &&
      dayMatches(cron, day, weekday)
    ) {
      return new Date(time).toISOString();
    }
  }
  throw new FlowV1CronError(
    "Cron expression has no occurrence in the next five years.",
  );
}

function dayMatches(
  cron: ParsedCron,
  dayOfMonth: number,
  dayOfWeek: number | undefined,
): boolean {
  if (dayOfWeek === undefined) {
    return false;
  }
  const dom = cron.dayOfMonth.values.has(dayOfMonth);
  const dow = cron.dayOfWeek.values.has(dayOfWeek);
  if (cron.dayOfMonth.wildcard) {
    return dow;
  }
  if (cron.dayOfWeek.wildcard) {
    return dom;
  }
  return dom || dow;
}

function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) {
    throw new FlowV1CronError(
      "Cron expression must contain exactly five fields.",
    );
  }
  return {
    minute: parseField(fields[0]!, 0, 59, "minute"),
    hour: parseField(fields[1]!, 0, 23, "hour"),
    dayOfMonth: parseField(fields[2]!, 1, 31, "day-of-month"),
    month: parseField(fields[3]!, 1, 12, "month"),
    dayOfWeek: parseField(fields[4]!, 0, 7, "day-of-week", true),
  };
}

function parseField(
  source: string,
  minimum: number,
  maximum: number,
  name: string,
  normalizeSunday = false,
): CronField {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const [rangeSource, stepSource] = item.split("/");
    const step = stepSource === undefined ? 1 : Number(stepSource);
    if (!Number.isInteger(step) || step < 1) {
      throw new FlowV1CronError(`Cron ${name} step is invalid: ${item}.`);
    }
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = minimum;
      end = maximum;
    } else if (rangeSource?.includes("-")) {
      const [left, right] = rangeSource.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangeSource);
      end = start;
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new FlowV1CronError(`Cron ${name} range is invalid: ${item}.`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return { values, wildcard: source === "*" };
}
