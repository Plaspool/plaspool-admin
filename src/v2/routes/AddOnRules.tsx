import { Plus, Trash2 } from 'lucide-react';
import { attributesOfKind } from '../../../shared/commerce/add-ons';
import type { AddOnAttribute, AddOnCondition, AddOnRule, NumberAttribute } from '../../../shared/commerce/add-ons';
import { formatMinor, parseMajor, plainMajor } from '../../data/api-shop';
import { Card } from '../ui/Card';
import { AffixField, SelectField, TextField } from '../ui/Field';
import { Button } from '../ui/primitives';
import { TagInput } from '../ui/TagInput';
import { ATTRIBUTE_LABELS, NUMBER_OPS, SET_OPS, kindOf } from './add-on-copy';

/**
 * "When to offer it" — an ordered list of rule cards, each a Segmented for the
 * outcome, an optional Charge, and condition rows built from the registry:
 * attribute → operator → value inputs. Every string here is the admin's
 * vocabulary (CLAUDE.md §7) and every picker reads the registry, so an
 * attribute added in shared/ appears here with no edit.
 */
const ATTRIBUTES = [
  ...attributesOfKind(['number', 'money']),
  ...attributesOfKind(['set']),
  ...attributesOfKind(['flag']),
] as AddOnAttribute[];

/** A fresh condition for an attribute, in that attribute's shape. */
export function blankCondition(attribute: AddOnAttribute): AddOnCondition {
  switch (kindOf(attribute)) {
    case 'set':
      return { attribute: attribute as never, op: 'any_in', values: [] };
    case 'flag':
      return { attribute: attribute as never, op: 'is', value: true };
    default:
      return { attribute: attribute as never, op: 'gte', value: 1 };
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
      <AffixField
        label={label}
        prefix="₦"
        inputMode="decimal"
        defaultValue={plainMajor(value, currency)}
        onBlur={(e) => {
          const parsed = parseMajor(e.currentTarget.value, currency);
          if (parsed.ok) onChange(parsed.minor);
        }}
      />
    );
  }
  return (
    <TextField
      label={label}
      type="number"
      min={0}
      value={String(value)}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))}
    />
  );
}

/**
 * A number/money condition, narrowed once for the whole "operator + value(s)"
 * block below. `kindOf(condition.attribute)` is a plain function, not a type
 * guard tied to `condition`, so the JSX gate that calls it (`kind === 'number'
 * || kind === 'money'`) cannot narrow `AddOnCondition`'s union on its own —
 * this is the one place that gate is not also a check on `condition.op`
 * itself (the set and flag branches below test `condition.op` directly, which
 * DOES narrow). The cast is exactly as safe as that gate is: both read the
 * same registry.
 */
type NumberCondition =
  | { attribute: NumberAttribute; op: 'eq' | 'gte' | 'lte'; value: number }
  | { attribute: NumberAttribute; op: 'between'; min: number; max: number };

function ConditionRow({
  condition,
  currency,
  onChange,
  onRemove,
}: {
  condition: AddOnCondition;
  currency: string;
  onChange: (next: AddOnCondition) => void;
  onRemove: () => void;
}) {
  const kind = kindOf(condition.attribute);
  return (
    <div className="rule__condition" style={{ display: 'flex', gap: 'var(--s2)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <SelectField
        label="Attribute"
        value={condition.attribute}
        onChange={(e) => onChange(blankCondition(e.currentTarget.value as AddOnAttribute))}
      >
        {ATTRIBUTES.map((a) => (
          <option key={a} value={a}>
            {ATTRIBUTE_LABELS[a]}
          </option>
        ))}
      </SelectField>

      {kind === 'number' || kind === 'money' ? (
        (() => {
          const nc = condition as NumberCondition;
          return (
            <>
              <SelectField
                label="Operator"
                value={nc.op}
                onChange={(e) => {
                  const op = e.currentTarget.value as (typeof NUMBER_OPS)[number]['value'];
                  const current = 'value' in nc ? nc.value : nc.min;
                  onChange(
                    op === 'between'
                      ? { attribute: nc.attribute, op, min: current, max: current }
                      : { attribute: nc.attribute, op, value: current },
                  );
                }}
              >
                {NUMBER_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </SelectField>
              {nc.op === 'between' ? (
                <>
                  <NumberValue label="From" attribute={nc.attribute} value={nc.min} currency={currency} onChange={(min) => onChange({ ...nc, min })} />
                  <NumberValue label="To" attribute={nc.attribute} value={nc.max} currency={currency} onChange={(max) => onChange({ ...nc, max })} />
                </>
              ) : (
                <NumberValue label="Value" attribute={nc.attribute} value={nc.value} currency={currency} onChange={(value) => onChange({ ...nc, value })} />
              )}
            </>
          );
        })()
      ) : null}

      {kind === 'set' && (condition.op === 'any_in' || condition.op === 'none_in') ? (
        <>
          <SelectField label="Operator" value={condition.op} onChange={(e) => onChange({ ...condition, op: e.currentTarget.value as 'any_in' | 'none_in' })}>
            {SET_OPS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
          <TagInput label="Values" value={condition.values} onChange={(values) => onChange({ ...condition, values })} placeholder="Type one and press Enter" hint="Joined by OR." />
        </>
      ) : null}

      {kind === 'flag' && condition.op === 'is' ? (
        <SelectField label="Value" value={condition.value ? 'yes' : 'no'} onChange={(e) => onChange({ ...condition, value: e.currentTarget.value === 'yes' })}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </SelectField>
      ) : null}

      <Button tone="plain" iconOnly aria-label="Remove condition" onClick={onRemove}>
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}

export function AddOnRules({
  rules,
  priceMinor,
  currency,
  onChange,
}: {
  rules: AddOnRule[];
  priceMinor: number;
  currency: string;
  onChange: (next: AddOnRule[]) => void;
}) {
  const update = (i: number, next: AddOnRule) => onChange(rules.map((r, j) => (j === i ? next : r)));
  return (
    <Card title="When to offer it">
      <p className="muted">Rules are read top to bottom. The first one that fits decides.</p>
      {rules.map((rule, i) => (
        <div key={i} className="card" data-testid={`rule-${i}`} style={{ marginTop: 'var(--s3)', padding: 'var(--s3)' }}>
          <div className="segmented" role="group" aria-label={`Rule ${i + 1}`}>
            <button type="button" className="segmented__opt" aria-pressed={rule.then === 'ask'} onClick={() => update(i, { ...rule, then: 'ask' })}>
              Ask the customer
            </button>
            <button type="button" className="segmented__opt" aria-pressed={rule.then === 'include'} onClick={() => update(i, { ...rule, then: 'include' })}>
              Add it automatically
            </button>
          </div>
          <AffixField
            label="Charge"
            prefix="₦"
            inputMode="decimal"
            placeholder={majorPlaceholder(priceMinor, currency)}
            hint="Leave empty to charge the add-on’s price. 0 makes it free."
            defaultValue={rule.amountMinor == null ? '' : plainMajor(rule.amountMinor, currency)}
            onBlur={(e) => {
              const text = e.currentTarget.value.trim();
              if (text === '') return update(i, { ...rule, amountMinor: null });
              const parsed = parseMajor(text, currency);
              if (parsed.ok) update(i, { ...rule, amountMinor: parsed.minor });
            }}
          />
          {rule.when.map((condition, c) => (
            <ConditionRow
              key={c}
              condition={condition}
              currency={currency}
              onChange={(next) => update(i, { ...rule, when: rule.when.map((x, k) => (k === c ? next : x)) })}
              onRemove={() => update(i, { ...rule, when: rule.when.filter((_, k) => k !== c) })}
            />
          ))}
          <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
            <Button onClick={() => update(i, { ...rule, when: [...rule.when, blankCondition('item_count')] })}>
              <Plus aria-hidden="true" />
              Add condition
            </Button>
            {rules.length > 1 ? (
              <Button tone="plain" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                <Trash2 aria-hidden="true" />
                Remove rule
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 'var(--s3)' }}>
        <Button onClick={() => onChange([...rules, { when: [], then: 'ask' }])}>
          <Plus aria-hidden="true" />
          Add rule
        </Button>
      </div>
    </Card>
  );
}
