/**
 * A box fill the database refused as a whole (migration 1220). Answered 409 by
 * `server/shop/app.ts`, because each is a conflict with the world as it now is,
 * not a malformed request.
 *
 *  - `box_short`: an item ran out between the dialog opening and Save. `short`
 *    names which, so the screen can say so.
 *  - `box_changed`: somebody else filled or changed this box first.
 *  - `box_in_parcel`: the box is already in a parcel that has not been cancelled.
 */
export class BoxRefusedError extends Error {
  constructor(
    readonly reason: 'box_short' | 'box_changed' | 'box_in_parcel',
    readonly short: string[] = [],
  ) {
    super(reason);
    this.name = 'BoxRefusedError';
  }
}
