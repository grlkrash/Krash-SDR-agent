// Walk forward (or backward) `addDays` business days from `date`, skipping
// Saturdays and Sundays. Used by the follow-up sequencer to land touches on
// weekdays only. Operates in local time (cron runs in server TZ); using
// setDate avoids DST off-by-one bugs that ms arithmetic causes.

const SATURDAY = 6;
const SUNDAY = 0;

export const businessDay = (date: Date, addDays: number): Date => {
  const result = new Date(date.getTime());
  let remaining = Math.abs(addDays);
  const step = addDays >= 0 ? 1 : -1;
  while (remaining > 0) {
    result.setDate(result.getDate() + step);
    const dow = result.getDay();
    if (dow !== SATURDAY && dow !== SUNDAY) remaining -= 1;
  }
  return result;
};
