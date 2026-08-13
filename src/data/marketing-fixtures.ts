/**
 * The marketing screens' test fixtures, in one module so every suite lies the
 * same way.
 *
 * EVERY FIXTURE USES ABSURD LABELS — "Bottle Cap"/"Bottle Caps" for the points
 * word, "canister"/"canisters" for the unit — and that is the point of the file
 * existing at all. The programme this section ships with is about returning
 * spools, so a screen that hardcoded "spool" would pass any test written with
 * realistic fixtures and fail the first customer who renamed the program. With
 * these, a hardcode is visible: the assertion asks for "6 canisters", and the
 * suites additionally assert `/spool/i` appears nowhere in what was rendered.
 *
 * Stream B fills this in (plan Task B1).
 */

export {};
