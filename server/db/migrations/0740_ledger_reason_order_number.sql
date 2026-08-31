-- LEDGER REASONS SAY THE CUSTOMER'S ORDER NUMBER (range 0740-0759; owner's
-- queue, 2026-08-31).
--
-- WHAT WAS WRONG. `server/marketing/redemption/port.ts` wrote the INTERNAL
-- order id into the one ledger column a shopper reads:
--
--   Order ord_01H8XYZ: 500 points spent
--
-- `marketing_ledger.reason` is render-final — written once, displayed verbatim,
-- never re-rendered through today's labels — and the storefront's rewards
-- history renders it exactly as stored. So every customer who has ever spent
-- points was shown a string only this codebase can resolve, beside a
-- confirmation email that called the same order `2026-000009-D`.
--
-- THE GENERATOR IS FIXED FORWARD; THIS FIXES WHAT IS ALREADY WRITTEN. Both
-- halves are needed and neither is sufficient on its own: the generator alone
-- leaves a permanent seam in every history a customer has already accumulated,
-- and this alone would be undone by the next order placed.
--
-- WHY THIS DOES NOT BREAK THE RENDER-FINAL RULE. That rule exists so a RENAME
-- cannot rewrite the past: rename the points currency in June and a March
-- receipt must still read as March wrote it. It is a rule about LABELS, which
-- move, and it is enforced by never re-rendering `reason` through today's
-- settings. An order number is not a label. It is fixed when the order is
-- placed, `shop_orders_order_number_uq` keeps it unique, and no admin action
-- changes it — so rewriting `ord_01H8XYZ` to `2026-000009-D` restates one
-- unchanging fact in the identifier the customer was given in the first place,
-- rather than re-rendering a snapshot through a label that has since moved.
-- The points words, the amounts and the trailing prose are not touched, and
-- those are the part the rule actually guards.
--
-- SURGICAL, AND A NO-OP ON ANYTHING IT DOES NOT RECOGNISE. The predicate is an
-- exact prefix match against the string the generator actually produced, NOT a
-- LIKE — an order id contains `_`, which LIKE reads as a single-character
-- wildcard and would let this match prose it did not write. A row whose shape
-- differs (a hand-written adjustment, some later format) is left alone.
-- Everything from the colon onward is carried across verbatim, so the amount
-- and a cancellation's reason survive byte for byte.
--
-- RE-RUNNABLE. A rewritten reason starts with the order NUMBER, which cannot
-- match a prefix built from that row's order ID, so a second application
-- changes nothing.
UPDATE marketing_ledger AS l
   SET reason = 'Order ' || o.order_number || substring(l.reason FROM length(l.order_id) + 7)
  FROM shop_orders AS o
 WHERE o.id = l.order_id
   AND l.kind IN ('redemption', 'redemption_release')
   AND left(l.reason, length(l.order_id) + 7) = 'Order ' || l.order_id || ':';--> statement-breakpoint
