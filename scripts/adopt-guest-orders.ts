/**
 * Link the guest orders already placed to the accounts created after them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS REPAIRS. A guest checkout stores the typed email and leaves
 * `shop_orders.customer_id NULL`; signing in with Google mints a customer row
 * keyed by a verified address. Nothing joined the two, and order history is
 * scoped `WHERE customer_id = $1` — so every shopper who bought first and
 * registered later had an empty order history. The code half is fixed (the
 * identity exchange now adopts on every sign-in), but that only runs at the
 * NEXT sign-in; the rows already orphaned need this.
 *
 * IT IS THE SAME MATCH THE ROUTE MAKES, deliberately: an existing customer row
 * whose email equals the order's, case-insensitively, and `customer_id IS NULL`
 * on the order. So it can adopt nothing the application would not have adopted,
 * and it can never move an order that already has an owner.
 *
 * A CUSTOMER ROW IS REQUIRED. This does not invent accounts for guests who
 * never signed up — an order with no matching customer is reported and left
 * exactly as it is, which is a working guest order and not a defect.
 *
 * IDEMPOTENT: the second run finds nothing, because the first one cleared the
 * `customer_id IS NULL` predicate for every row it touched.
 *
 * IT NEVER TOUCHES `shop_orders.email`. That column is what the emailed receipt
 * link authenticates against, and a link already in a mailbox must keep working.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   APP_ORIGINS="https://migration.invalid" \
 *     npx tsx --env-file=.prod.env scripts/adopt-guest-orders.ts --check
 *
 * `--check` prints what it would do and writes nothing. Without it, it writes.
 * Point `--env-file` at `.dev.env` to repair the dev host.
 */
import { sql } from 'drizzle-orm';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';

const CHECK = process.argv.includes('--check');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = drizzle(neon(url));

  /*
   * One read that answers the whole question: every orphaned order, with the
   * customer it WOULD be adopted by, or NULL when nobody has that address yet.
   *
   * A LEFT JOIN rather than two queries, so the report and the write agree by
   * construction. `shop_customers.email` is normalised lower-case on write and
   * `shop_orders.email` is the address exactly as it was typed, so the join has
   * to fold case on both sides or it silently matches nothing.
   */
  const res = await db.execute(sql`
    SELECT o.id, o.order_number, o.email, o.placed_at, c.id AS customer_id
      FROM shop_orders o
      LEFT JOIN shop_customers c ON lower(c.email) = lower(o.email)
     WHERE o.customer_id IS NULL
     ORDER BY o.placed_at`);

  let adopted = 0;
  let noAccount = 0;
  for (const row of res.rows) {
    const orderNumber = String(row.order_number);
    const email = String(row.email);
    if (row.customer_id == null) {
      noAccount += 1;
      console.log(`SKIP  ${orderNumber}  ${email}  (no account with this address)`);
      continue;
    }
    const customerId = String(row.customer_id);
    adopted += 1;
    console.log(`${CHECK ? 'WOULD' : 'WRITE'} ${orderNumber}  ${email}  -> ${customerId}`);
    if (!CHECK) {
      /* The route's own predicate, repeated here rather than trusted from the
         SELECT above: the read and the write are separate statements, and only
         the write's WHERE clause can stop a row that gained an owner between
         them. */
      await db.execute(sql`
        UPDATE shop_orders
           SET customer_id = ${customerId}
         WHERE id = ${String(row.id)} AND customer_id IS NULL`);
    }
  }

  console.log(
    `\n${res.rows.length} guest order(s): ${adopted} ${CHECK ? 'would be adopted' : 'adopted'}, ` +
      `${noAccount} left as guest orders (nobody has signed up with that address)`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
