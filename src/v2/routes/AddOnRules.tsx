import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { ADD_ON_BASES, ADD_ON_MODES, attributesOfKind, basisFor } from '../../../shared/commerce/add-ons';
import type { AddOnAttribute, AddOnBasis, AddOnCondition, AddOnMode, AddOnRule, NumberAttribute } from '../../../shared/commerce/add-ons';
import { formatMinor, parseMajor, plainMajor } from '../../data/api-shop';
import { Card } from '../ui/Card';
import { Button } from '../ui/primitives';
import { SearchSelect } from '../ui/SearchSelect';
import { ATTRIBUTE_LABELS, BASIS_LABELS, MODE_LABELS, NUMBER_OPS, SET_OPS, kindOf } from './add-on-copy';

/**
 * "When to offer it" — one block per rule, laid out the way the reference
 * admin lays out a collection's conditions (the owner's screenshots):
 *
 *   ┌ Ask the customer ⌃ ──────────────── Charge ₦ [      ] 🗑 ┐
 *   │ Items in cart ⌃  is between ⌃                       🗑 │
 *   │ [ 1 ]  and  [ 4 ]                                       │
 *   │ ⊕ Add condition                                         │
 *   └─────────────────────────────────────────────────────────┘
 *   ┌ - - - - - - - - - -  + Add rule  - - - - - - - - - - - ┐
 *
 * Every string here is the admin's vocabulary (CLAUDE.md §7) and every picker
 * reads the registry, so an attribute added in shared/ appears here with no
 * edit. The pickers are NATIVE selects drawn as pills: the keyboard and the
 * screen reader get a real control, and a test can `selectOptions` on it.
 */

/** The three outcomes a rule can decide, in the admin's words. */
const OUTCOMES = ADD_ON_MODES.map((value) => ({ value, label: MODE_LABELS[value] }));
const BASES = ADD_ON_BASES.map((value) => ({ value, label: BASIS_LABELS[value] }));

/**
 * The money box's label, which is NOT always "Charge" any more. Under
 * `opt_out` the number is money going BACK to the shopper, and a box called
 * Charge holding the amount of a refund is the kind of label that gets a
 * price entered with the wrong sign in mind.
 */
const moneyLabel = (mode: AddOnMode) => (mode === 'opt_out' ? 'Save' : 'Charge');
const moneyHint = (mode: AddOnMode) =>
  mode === 'opt_out'
    ? 'What comes off the bill when they take it out. Leave empty to use the add-on’s price.'
    : 'Leave empty to charge the add-on’s price. 0 makes it free.';

const ATTRIBUTES = [
  ...attributesOfKind(['number', 'money']),
  ...attributesOfKind(['set']),
  ...attributesOfKind(['flag']),
] as AddOnAttribute[];

/**
 * Client-only identity for a draft rule or condition — never sent to the
 * server (`AddOnDetail.tsx`'s `plain()` strips it before every save and every
 * dirty check). Keying a rule block or a condition row on its array INDEX
 * meant that removing an earlier row shifted every later one's uncontrolled
 * inputs (Charge, the money From/To/Value fields) onto the wrong data — the
 * DOM node stayed where it was, and an uncontrolled input's `defaultValue`
 * only applies at mount, so it kept showing whatever it showed before. A
 * stable id fixes that: React unmounts exactly the removed row and leaves
 * every surviving row's inputs keyed to itself, wherever it now sits.
 */
let uidSeq = 0;
export function nextUid(): string {
  uidSeq += 1;
  return `u${uidSeq}`;
}

export type EditableCondition = AddOnCondition & { uid: string };
export type EditableRule = Omit<AddOnRule, 'when'> & { uid: string; when: EditableCondition[] };

/** A fresh condition for an attribute, in that attribute's shape. */
export function blankCondition(attribute: AddOnAttribute): EditableCondition {
  switch (kindOf(attribute)) {
    case 'set':
      return { attribute: attribute as never, op: 'any_in', values: [], uid: nextUid() };
    case 'flag':
      return { attribute: attribute as never, op: 'is', value: true, uid: nextUid() };
    default:
      return { attribute: attribute as never, op: 'gte', value: 1, uid: nextUid() };
  }
}

/**
 * `2500, 'GBP'` → `25.00`, so a hint reads the shape it wants back — but
 * grouped, unlike `plainMajor`: this is never typed over, only read, and the
 * grouping is what makes `2,000` legible at a glance. Mirrors `ShopOrders.tsx`'s
 * own `majorPlaceholder`, which is not exported from that route.
 */
function majorPlaceholder(minor: number, currency: string): string {
  return formatMinor(minor, currency).replace(/[^\d.,]/g, '');
}

/** A money box with the currency inside its border: `.affix`, as AffixField
 *  draws it, without the field label and margins a pill row has no room for.
 *  Uncontrolled and committed on blur, so a half-typed "2000." never round-trips
 *  through the parser mid-keystroke. */
function MoneyBox({
  label,
  defaultValue,
  placeholder,
  onCommit,
}: {
  label: string;
  defaultValue: string;
  placeholder?: string;
  onCommit: (text: string) => void;
}) {
  return (
    <span className="affix">
      <span className="affix__tag" aria-hidden="true">
        ₦
      </span>
      <input
        className="input"
        aria-label={label}
        inputMode="decimal"
        defaultValue={defaultValue}
        placeholder={placeholder}
        onBlur={(e) => onCommit(e.currentTarget.value.trim())}
      />
    </span>
  );
}

function NumberValue({
  label,
  attribute,
  value,
  currency,
  onChange,
}: {
  label: string;
  attribute: AddOnAttribute;
  value: number;
  currency: string;
  onChange: (next: number) => void;
}) {
  if (kindOf(attribute) === 'money') {
    return (
      <MoneyBox
        label={label}
        defaultValue={plainMajor(value, currency)}
        onCommit={(text) => {
          const parsed = parseMajor(text, currency);
          if (parsed.ok) onChange(parsed.minor);
        }}
      />
    );
  }
  return (
    <input
      className="input rule__num"
      type="number"
      min={0}
      aria-label={label}
      value={String(value)}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
    />
  );
}

/** Chips joined by OR, exactly as the reference shows chosen values. */
function Chips({
  values,
  labelOf,
  onRemove,
}: {
  values: string[];
  labelOf: (value: string) => string;
  onRemove: (value: string) => void;
}) {
  return (
    <>
      {values.map((value, i) => (
        <span key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--s2)' }}>
          {i > 0 ? <span className="rule__or">OR</span> : null}
          <span className="tagin__chip">
            {labelOf(value)}
            <button type="button" className="tagin__x" aria-label={`Remove ${labelOf(value)}`} onClick={() => onRemove(value)}>
              <X aria-hidden="true" />
            </button>
          </span>
        </span>
      ))}
    </>
  );
}

/** Typed values (a tag, a state, a district, a product code): chips plus one
 *  box that adds on Enter or comma and removes the last chip on Backspace. */
function TypedValues({
  values,
  placeholder,
  onChange,
}: {
  values: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const next = draft.trim();
    if (next === '' || values.includes(next)) {
      setDraft('');
      return;
    }
    onChange([...values, next]);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <>
      <Chips values={values} labelOf={(v) => v} onRemove={(v) => onChange(values.filter((x) => x !== v))} />
      <input
        className="input rule__chip-input"
        aria-label="Values"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
      />
    </>
  );
}

/**
 * The Product condition picks by TITLE, not by typing a raw id: a SearchSelect
 * adds one product at a time to `condition.values`, and the chosen ids render
 * as chips resolved back to their titles (falling back to the bare id for one
 * this page's product list does not carry — a deleted product, or one past
 * the first page). `describeCondition` in `add-on-copy.ts` still prints the
 * stored ids in the rule's summary sentence: that sentence has no product
 * list to resolve against, and that is a controller ruling, not an oversight.
 */
function ProductValues({
  values,
  products,
  onChange,
}: {
  values: string[];
  products: { id: string; title: string }[];
  onChange: (next: string[]) => void;
}) {
  const titleOf = (id: string) => products.find((p) => p.id === id)?.title ?? id;
  const available = products.filter((p) => !values.includes(p.id));
  return (
    <>
      <Chips values={values} labelOf={titleOf} onRemove={(id) => onChange(values.filter((v) => v !== id))} />
      <SearchSelect
        label="Add a product"
        value=""
        options={available.map((p) => ({ value: p.id, label: p.title }))}
        onChange={(id) => {
          if (!id || values.includes(id)) return;
          onChange([...values, id]);
        }}
        placeholder="Search products…"
        emptyText="No product matches that."
        triggerPrefix={<Plus aria-hidden="true" />}
      />
    </>
  );
}

/**
 * A number/money condition, narrowed once for the whole "operator + value(s)"
 * block below. `kindOf(condition.attribute)` is a plain function, not a type
 * guard tied to `condition`, so the JSX gate that calls it cannot narrow
 * `AddOnCondition`'s union on its own — the set and flag branches test
 * `condition.op` directly, which DOES narrow. The cast is exactly as safe as
 * that gate is: both read the same registry.
 */
type NumberCondition =
  | { attribute: NumberAttribute; op: 'eq' | 'gte' | 'lte'; value: number; uid: string }
  | { attribute: NumberAttribute; op: 'between'; min: number; max: number; uid: string };

const TYPED_PLACEHOLDER: Partial<Record<AddOnAttribute, string>> = {
  category: 'Type a category and press Enter',
  tag: 'Type a tag and press Enter',
  sku: 'Type a product code and press Enter',
  country: 'Two-letter country code, then Enter',
  region: 'Type a state and press Enter',
  district: 'Type a district key and press Enter',
  shipping_option: 'Type a delivery option id and press Enter',
};

function ConditionRow({
  condition,
  currency,
  products,
  onChange,
  onRemove,
}: {
  condition: EditableCondition;
  currency: string;
  products: { id: string; title: string }[];
  onChange: (next: EditableCondition) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(condition.attribute);
  const numeric = kind === 'number' || kind === 'money' ? (condition as NumberCondition) : null;

  return (
    <div className="rule__cond">
      <div className="rule__pills">
        <select
          className="rule__pill"
          aria-label="Attribute"
          value={condition.attribute}
          onChange={(e) => onChange(blankCondition(e.currentTarget.value as AddOnAttribute))}
        >
          {ATTRIBUTES.map((a) => (
            <option key={a} value={a}>
              {ATTRIBUTE_LABELS[a]}
            </option>
          ))}
        </select>

        {numeric ? (
          <select
            className="rule__pill"
            aria-label="Operator"
            value={numeric.op}
            onChange={(e) => {
              const op = e.currentTarget.value as (typeof NUMBER_OPS)[number]['value'];
              const current = 'value' in numeric ? numeric.value : numeric.min;
              onChange(
                op === 'between'
                  ? { attribute: numeric.attribute, op, min: current, max: current, uid: numeric.uid }
                  : { attribute: numeric.attribute, op, value: current, uid: numeric.uid },
              );
            }}
          >
            {NUMBER_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : null}

        {kind === 'set' && (condition.op === 'any_in' || condition.op === 'none_in') ? (
          <select
            className="rule__pill"
            aria-label="Operator"
            value={condition.op}
            onChange={(e) => onChange({ ...condition, op: e.currentTarget.value as 'any_in' | 'none_in' })}
          >
            {SET_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : null}

        {kind === 'flag' && condition.op === 'is' ? (
          <select
            className="rule__pill"
            aria-label="Value"
            value={condition.value ? 'yes' : 'no'}
            onChange={(e) => onChange({ ...condition, value: e.currentTarget.value === 'yes' })}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        ) : null}

        <span className="rule__spacer" />
        <Button tone="plain" iconOnly aria-label="Remove condition" onClick={onRemove}>
          <Trash2 aria-hidden="true" />
        </Button>
      </div>

      {numeric ? (
        <div className="rule__values">
          {numeric.op === 'between' ? (
            <>
              <NumberValue label="From" attribute={numeric.attribute} value={numeric.min} currency={currency} onChange={(min) => onChange({ ...numeric, min })} />
              <span className="rule__or">and</span>
              <NumberValue label="To" attribute={numeric.attribute} value={numeric.max} currency={currency} onChange={(max) => onChange({ ...numeric, max })} />
            </>
          ) : (
            <NumberValue label="Value" attribute={numeric.attribute} value={numeric.value} currency={currency} onChange={(value) => onChange({ ...numeric, value })} />
          )}
        </div>
      ) : null}

      {kind === 'set' && (condition.op === 'any_in' || condition.op === 'none_in') ? (
        <div className="rule__values">
          {condition.attribute === 'product' ? (
            <ProductValues values={condition.values} products={products} onChange={(values) => onChange({ ...condition, values })} />
          ) : (
            <TypedValues
              values={condition.values}
              placeholder={TYPED_PLACEHOLDER[condition.attribute] ?? 'Type a value and press Enter'}
              onChange={(values) => onChange({ ...condition, values })}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AddOnRules({
  rules,
  priceMinor,
  currency,
  products,
  onChange,
}: {
  rules: EditableRule[];
  priceMinor: number;
  currency: string;
  products: { id: string; title: string }[];
  onChange: (next: EditableRule[]) => void;
}) {
  const update = (i: number, next: EditableRule) => onChange(rules.map((r, j) => (j === i ? next : r)));
  return (
    <Card title="When to offer it">
      <p className="muted">Rules are read top to bottom. The first one that fits decides.</p>
      {rules.map((rule, i) => (
        <section key={rule.uid} className="rule" data-testid={`rule-${i}`} aria-label={`Rule ${i + 1}`}>
          <div className="rule__head">
            <select
              className="rule__pill"
              aria-label="What happens"
              value={rule.then}
              onChange={(e) => update(i, { ...rule, then: e.currentTarget.value as AddOnMode })}
            >
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="rule__spacer" />
            {/* Empty charges the add-on's price (the placeholder shows it); 0 makes it free. */}
            <span className="rule__charge" title={moneyHint(rule.then)}>
              {moneyLabel(rule.then)}
              <MoneyBox
                label={moneyLabel(rule.then)}
                placeholder={majorPlaceholder(priceMinor, currency)}
                defaultValue={rule.amountMinor == null ? '' : plainMajor(rule.amountMinor, currency)}
                onCommit={(text) => {
                  if (text === '') return update(i, { ...rule, amountMinor: null });
                  const parsed = parseMajor(text, currency);
                  if (parsed.ok) update(i, { ...rule, amountMinor: parsed.minor });
                }}
              />
              {/* Reads straight on from the money: ₦500 for each item. */}
              <select
                className="rule__pill"
                aria-label="How often"
                value={basisFor(rule)}
                onChange={(e) => update(i, { ...rule, basis: e.currentTarget.value as AddOnBasis })}
              >
                {BASES.map((b) => (
                  <option key={b.value} value={b.value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </span>
            {rules.length > 1 ? (
              <Button tone="plain" iconOnly aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden="true" />
              </Button>
            ) : null}
          </div>

          {rule.when.length === 0 ? (
            <p className="rule__empty">Every cart. Add a condition to narrow it down.</p>
          ) : null}
          {rule.when.map((condition, c) => (
            <ConditionRow
              key={condition.uid}
              condition={condition}
              currency={currency}
              products={products}
              onChange={(next) => update(i, { ...rule, when: rule.when.map((x, k) => (k === c ? next : x)) })}
              onRemove={() => update(i, { ...rule, when: rule.when.filter((_, k) => k !== c) })}
            />
          ))}

          <div className="rule__foot">
            <Button onClick={() => update(i, { ...rule, when: [...rule.when, blankCondition('item_count')] })}>
              <Plus aria-hidden="true" />
              Add condition
            </Button>
          </div>
        </section>
      ))}
      <button
        type="button"
        className="rule__add"
        onClick={() => onChange([...rules, { uid: nextUid(), when: [], then: 'ask', amountMinor: null }])}
      >
        <Plus aria-hidden="true" />
        Add rule
      </button>
    </Card>
  );
}
