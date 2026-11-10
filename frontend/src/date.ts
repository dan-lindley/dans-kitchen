export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function weekdayMondayZero(isoDate: string): number {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(isoDate) ||
    parsed.toISOString().slice(0, 10) !== isoDate
  ) {
    throw new RangeError(`Invalid calendar date: ${isoDate}`);
  }
  return (parsed.getUTCDay() + 6) % 7;
}
