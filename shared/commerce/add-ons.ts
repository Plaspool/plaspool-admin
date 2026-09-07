import { money } from './money';
import type { Money } from './money';

/**
 * Checkout add-ons (spec 2026-09-06): the shapes the admin, the cart and the
 * storefront all agree on, and the one pure function that turns an add-on's
 * rules plus a cart's facts into an offer.
 *
 * BROWSER-SAFE. Imports nothing from server/; `src/` reads the registry for
 * its pickers and the storefront brief copies `AddOnOffer` verbatim.
 */

/**
 * WHAT THE RULE DOES.
 *
 * `ask` and `include` are the original two. `opt_out` (migration 0960) is the
 * third and it is the one that reads backwards: the extra is ALREADY IN THE
 * PRODUCT PRICE, so keeping it costs nothing and REMOVING it pays the shopper
 * back. A box baked into a filament's price is the case it was added for — the
 * shopper who does not want four boxes takes them out and saves 4 × ₦500.
 *
 * That is why `amount` on an offer may now be NEGATIVE, and it is the only way
 * it can be. See `AddOnOffer.amount`.
 */
export type AddOnMode = 'ask' | 'include' | 'opt_out';
export const ADD_ON_MODES: readonly AddOnMode[] = ['ask', 'include', 'opt_out'];

/**
 * WHAT THE PRICE IS MULTIPLIED BY (migration 0960).
 *
 * `order` is once for the whole cart and is the DEFAULT — every rule written
 * before this existed means `order`, and an absent key must keep meaning that
 * forever. `item` is once per unit in the cart (Σ qty, `AddOnFacts.itemCount`):
 * two filaments and three nozzles is five boxes.
 *
 * Deliberately only two. "Once per different product" was considered and left
 * out (owner, 2026-09-07): it is a third thing to explain in the picker and
 * nothing wanted it yet. Adding it later is one entry here, one branch in
 * `unitsFor`, and one label in the admin's `add-on-copy.ts`.
 */
export type AddOnBasis = 'order' | 'item';
export const ADD_ON_BASES: readonly AddOnBasis[] = ['order', 'item'];

export type AddOnChoice = 'accepted' | 'declined';
export type AddOnStatus = 'draft' | 'active' | 'archived';
export const ADD_ON_STATUSES: readonly AddOnStatus[] = ['draft', 'active', 'archived'];

/**
 * THE CONDITION REGISTRY. Adding an attribute is one entry here, one fact in
 * `AddOnFacts` (and its source in `factsFrom`), and one label in the admin's
 * `add-on-copy.ts`. The evaluator, the Zod schema and the picker all read this.
 */
export const ADD_ON_ATTRIBUTES = {
  item_count: { kind: 'number' },
  distinct_products: { kind: 'number' },
  subtotal_minor: { kind: 'money' },
  total_weight_grams: { kind: 'number' },
  category: { kind: 'set' },
  tag: { kind: 'set' },
  product: { kind: 'set' },
  sku: { kind: 'set' },
  country: { kind: 'set' },
  region: { kind: 'set' },
  district: { kind: 'set' },
  shipping_option: { kind: 'set' },
  signed_in: { kind: 'flag' },
  has_discount_code: { kind: 'flag' },
} as const;

export type AddOnAttribute = keyof typeof ADD_ON_ATTRIBUTES;
export type AddOnAttributeKind = (typeof ADD_ON_ATTRIBUTES)[AddOnAttribute]['kind'];

type OfKind<K extends AddOnAttributeKind> = {
  [A in AddOnAttribute]: (typeof ADD_ON_ATTRIBUTES)[A]['kind'] extends K ? A : never;
}[AddOnAttribute];
export type NumberAttribute = OfKind<'number' | 'money'>;
export type SetAttribute = OfKind<'set'>;
export type FlagAttribute = OfKind<'flag'>;

export function attributesOfKind(kinds: readonly AddOnAttributeKind[]): AddOnAttribute[] {
  return (Object.keys(ADD_ON_ATTRIBUTES) as AddOnAttribute[]).filter((a) =>
    kinds.includes(ADD_ON_ATTRIBUTES[a].kind),
  );
}

export type AddOnCondition =
  | { attribute: NumberAttribute; op: 'eq' | 'gte' | 'lte'; value: number }
  /** Inclusive at both ends; the admin validates min <= max. */
  | { attribute: NumberAttribute; op: 'between'; min: number; max: number }
  | { attribute: SetAttribute; op: 'any_in' | 'none_in'; values: string[] }
  | { attribute: FlagAttribute; op: 'is'; value: boolean };

export interface AddOnRule {
  /** AND. An empty list always holds. */
  when: AddOnCondition[];
  then: AddOnMode;
  /**
   * Overrides the add-on's price for this rule, PER UNIT. Absent or null = the
   * price; 0 = free. Under `basis: 'item'` this is the price of ONE — the
   * ₦500 in "₦500 a box" — never the cart's total.
   */
  amountMinor?: number | null;
  /** Absent or null = `'order'`, which is what every rule written before 0960 meant. */
  basis?: AddOnBasis | null;
}

/** What the evaluator needs of a stored add-on. Catalog projects rows into this. */
export interface AddOnRecord {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  priceMinor: number;
  currency: string;
  rules: AddOnRule[];
}

/** One add-on as it applies to THIS cart, right now. The storefront's object. */
export interface AddOnOffer {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  /** The add-on's list price, PER UNIT. Struck through when `unitAmount` is less. */
  price: Money;
  /**
   * What one unit costs under the rule that fired — SIGNED, so an `opt_out`
   * removal is negative. Render "₦500 each" from its magnitude.
   */
  unitAmount: Money;
  /** How many units `unitAmount` is multiplied by: 1 for `order`, Σ qty for `item`. */
  units: number;
  basis: AddOnBasis;
  /**
   * What will be charged. Render this, never `price`.
   *
   * `unitAmount × units`, and NEGATIVE when an `opt_out` add-on has been
   * removed — the shopper is being paid back for packaging already inside the
   * product price. Nothing else can make it negative.
   *
   * FLOORED SO THE BILL CANNOT GO BELOW THE GOODS. Savings across all add-ons
   * are capped at the cart subtotal, so `amount` is `unitAmount × units`
   * EXCEPT where that cap bit — which only a misconfiguration (a ₦50,000
   * per-item saving on a ₦28,000 cart) can reach, and which must not be
   * allowed to mint a negative Paystack intent.
   */
  amount: Money;
  mode: AddOnMode;
  /**
   * The shopper's answer for an `ask` or `opt_out` add-on; null = not asked
   * yet, and always null for `include`, which offers no choice.
   *
   * For `opt_out`, null and `'accepted'` mean the same thing — the extra stays,
   * because it is already in the price — and only `'declined'` takes it out.
   */
  choice: AddOnChoice | null;
}

export interface AddOnFacts {
  currency: string;
  itemCount: number;
  distinctProducts: number;
  /** Goods after the bulk ladder, before codes — FrozenTotals.subtotal. */
  subtotalMinor: number;
  /** Σ qty × weight over the lines with a known weight. */
  totalWeightGrams: number;
  categories: readonly string[];
  tags: readonly string[];
  productIds: readonly string[];
  skus: readonly string[];
  country: string | null;
  region: string | null;
  district: string | null;
  shippingOptionId: string | null;
  signedIn: boolean;
  hasDiscountCode: boolean;
  choices: Readonly<Record<string, AddOnChoice>>;
}

/** What Cart hands the port: cart facts only, no product attributes (Catalog adds those). */
export interface AddOnCartInput {
  currency: string;
  lines: ReadonlyArray<{
    productId: string;
    variantId: string;
    sku: string;
    qty: number;
    weightGrams: number | null;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  address: { country: string; region: string | null; district: string | null } | null;
  shippingOptionId: string | null;
  signedIn: boolean;
  hasDiscountCode: boolean;
  choices: Readonly<Record<string, AddOnChoice>> | null;
}

/**
 * Implemented by Catalog (`server/shop/catalog/add-ons/port.ts`), consumed by
 * Cart through `ShopCartDeps.addOns`. Db is a type parameter for the reason
 * every port in `ports.ts` gives: this file is compiled into the browser too.
 */
export interface AddOnPort<Db> {
  /** Offers for this cart, evaluated now. Never throws for a business outcome. */
  offers(db: Db, input: AddOnCartInput): Promise<AddOnOffer[]>;
}

/** What ONE unit costs under this rule, unsigned. The rule may override the price. */
export function unitAmountFor(addOn: AddOnRecord, rule: AddOnRule): number {
  return rule.amountMinor ?? addOn.priceMinor;
}

/** `'order'` for a rule written before 0960, and for one that never set it. */
export function basisFor(rule: AddOnRule): AddOnBasis {
  return rule.basis ?? 'order';
}

/** How many units the price is multiplied by. */
export function unitsFor(basis: AddOnBasis, facts: AddOnFacts): number {
  return basis === 'item' ? facts.itemCount : 1;
}

/** Names match case-insensitively and trimmed; ids and codes exactly; countries uppercased. */
const NAME_LIKE: ReadonlySet<AddOnAttribute> = new Set(['category', 'tag', 'region', 'district']);
function normalise(attribute: SetAttribute, value: string): string {
  const trimmed = value.trim();
  if (attribute === 'country') return trimmed.toUpperCase();
  return NAME_LIKE.has(attribute) ? trimmed.toLowerCase() : trimmed;
}

function numberFact(attribute: NumberAttribute, facts: AddOnFacts): number {
  switch (attribute) {
    case 'item_count':
      return facts.itemCount;
    case 'distinct_products':
      return facts.distinctProducts;
    case 'subtotal_minor':
      return facts.subtotalMinor;
    case 'total_weight_grams':
      return facts.totalWeightGrams;
  }
}

function setFact(attribute: SetAttribute, facts: AddOnFacts): readonly string[] {
  switch (attribute) {
    case 'category':
      return facts.categories;
    case 'tag':
      return facts.tags;
    case 'product':
      return facts.productIds;
    case 'sku':
      return facts.skus;
    case 'country':
      return facts.country === null ? [] : [facts.country];
    case 'region':
      return facts.region === null ? [] : [facts.region];
    case 'district':
      return facts.district === null ? [] : [facts.district];
    case 'shipping_option':
      return facts.shippingOptionId === null ? [] : [facts.shippingOptionId];
  }
}

function flagFact(attribute: FlagAttribute, facts: AddOnFacts): boolean {
  switch (attribute) {
    case 'signed_in':
      return facts.signedIn;
    case 'has_discount_code':
      return facts.hasDiscountCode;
  }
}

export function holds(condition: AddOnCondition, facts: AddOnFacts): boolean {
  switch (condition.op) {
    case 'eq':
      return numberFact(condition.attribute, facts) === condition.value;
    case 'gte':
      return numberFact(condition.attribute, facts) >= condition.value;
    case 'lte':
      return numberFact(condition.attribute, facts) <= condition.value;
    case 'between': {
      const v = numberFact(condition.attribute, facts);
      return v >= condition.min && v <= condition.max;
    }
    case 'any_in':
    case 'none_in': {
      const wanted = new Set(condition.values.map((v) => normalise(condition.attribute, v)));
      const hit = setFact(condition.attribute, facts).some((f) =>
        wanted.has(normalise(condition.attribute, f)),
      );
      return condition.op === 'any_in' ? hit : !hit;
    }
    case 'is':
      return flagFact(condition.attribute, facts) === condition.value;
  }
}

/** Cart input plus Catalog's product lookup → facts. Distinct, in first-seen order. */
export function factsFrom(
  input: AddOnCartInput,
  products: ReadonlyMap<string, { category: string; tags: readonly string[] }>,
): AddOnFacts {
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const categories = new Set<string>();
  const tags = new Set<string>();
  for (const id of productIds) {
    const p = products.get(id);
    if (!p) continue;
    categories.add(p.category);
    for (const t of p.tags) tags.add(t);
  }
  return {
    currency: input.currency,
    itemCount: input.lines.reduce((n, l) => n + l.qty, 0),
    distinctProducts: productIds.length,
    subtotalMinor: input.subtotalMinor,
    totalWeightGrams: input.lines.reduce(
      (n, l) => n + (l.weightGrams === null ? 0 : l.weightGrams * l.qty),
      0,
    ),
    categories: [...categories],
    tags: [...tags],
    productIds,
    skus: input.lines.map((l) => l.sku),
    country: input.address?.country ?? null,
    region: input.address?.region ?? null,
    district: input.address?.district ?? null,
    shippingOptionId: input.shippingOptionId,
    signedIn: input.signedIn,
    hasDiscountCode: input.hasDiscountCode,
    choices: input.choices ?? {},
  };
}

/**
 * The first rule that fits decides; no rule → no offer. Add-ons in another
 * currency are SKIPPED — a misconfiguration must not stop a checkout. The
 * input order is the output order (Catalog sorts by position).
 *
 * THE SAVINGS BUDGET is why this is a loop with state rather than a `map`.
 * `opt_out` amounts are negative, and enough of them could in principle drive
 * a grand total below zero — which is not a discount, it is a payout, and
 * Paystack cannot be asked for one. The goods subtotal is the budget; each
 * removal spends from it and a removal that would overdraw is capped. One
 * misconfigured add-on therefore costs the shop the cart's value at worst,
 * never more, and the checkout still completes — an add-on must never be the
 * reason a shopper cannot pay.
 */
export function evaluateAddOns(
  addOns: readonly AddOnRecord[],
  facts: AddOnFacts,
): AddOnOffer[] {
  const offers: AddOnOffer[] = [];
  let savingsBudget = Math.max(0, facts.subtotalMinor);
  for (const addOn of addOns) {
    if (addOn.currency !== facts.currency) continue;
    const rule = addOn.rules.find((r) => r.when.every((c) => holds(c, facts)));
    if (!rule) continue;

    const mode = rule.then;
    const basis = basisFor(rule);
    const unit = unitAmountFor(addOn, rule);
    const units = unitsFor(basis, facts);
    // `include` offers no choice, so it never carries one; the other two read
    // the cart's stored answers, and for `opt_out` only 'declined' does anything.
    const choice = mode === 'include' ? null : (facts.choices[addOn.id] ?? null);
    const gross = unit * units;

    let signedUnit = unit;
    let amount: number;
    if (mode === 'opt_out') {
      if (choice === 'declined') {
        signedUnit = -unit;
        amount = -Math.min(gross, savingsBudget);
        savingsBudget += amount;
      } else {
        // Kept. It is already inside the product price; charging again would
        // bill the shopper twice for the same box.
        amount = 0;
      }
    } else if (mode === 'include') {
      amount = gross;
    } else {
      amount = choice === 'accepted' ? gross : 0;
    }

    offers.push({
      id: addOn.id,
      title: addOn.title,
      description: addOn.description,
      imageUrl: addOn.imageUrl,
      price: money(addOn.priceMinor, addOn.currency),
      unitAmount: money(signedUnit, addOn.currency),
      units,
      basis,
      amount: money(amount, addOn.currency),
      mode,
      choice,
    });
  }
  return offers;
}
