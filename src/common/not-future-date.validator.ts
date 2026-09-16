import { registerDecorator, ValidationOptions, ValidationArguments } from 'class-validator';

/**
 * Rejects a trade date that has not happened yet.
 *
 * A ledger row dated in the future is not merely odd, it is invisible: every
 * valuation replays `date <= asOfDate`, so the row contributes nothing to any
 * window that ends today while the live Holding rows it wrote still show the
 * position. That asymmetry is exactly how a member holding GRAPHITE.NS, ANUP.NS
 * and MBEL.NS reported a closing value of 96,583 - the ANUP row alone - on a
 * book whose holdings sheet plainly showed 4,92,466. The trades had been
 * entered on the 15th but dated the 17th, so two of the three were silently
 * outside every measured period.
 *
 * The add-symbol form already refuses a future date twice (a `max` on the input
 * and a check in `validate`), but the API accepted one from any other caller,
 * and `@IsDateString` is happy with any parseable date. The rule belongs here,
 * at the boundary every write path crosses.
 *
 * Compared against the END of today in UTC rather than the instant of the
 * request: a manager in IST booking a trade on the morning of the 17th local
 * time is entering a real trade for a date that is still the 16th in UTC, and
 * refusing that would be the more confusing failure. The guard exists to catch
 * a date that cannot have traded yet, not to police the timezone boundary.
 */
export function IsNotFutureDate(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotFutureDate',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          const parsed = new Date(value);
          if (Number.isNaN(parsed.getTime())) return false;

          const now = new Date();
          const endOfToday = Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            23,
            59,
            59,
            999,
          );
          return parsed.getTime() <= endOfToday;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} cannot be in the future — a trade dated ahead of today is excluded from every performance window while still showing in holdings`;
        },
      },
    });
  };
}
