import { z } from 'zod';
import { str } from '../../../middleware/errors';
import { ADD_ON_BASES, ADD_ON_MODES, attributesOfKind } from '../../../../shared/commerce/add-ons';

/**
 * The shape of shop_add_ons.rules, built FROM THE REGISTRY so an attribute
 * added to shared/commerce/add-ons.ts is accepted here without a second edit.
 * Strict everywhere: an unknown key on a rule is a 400, never a silent drop.
 */
const MAX_INT4 = 2_147_483_647;
const enumOf = (values: string[]) => z.enum(values as [string, ...string[]]);
const NumberAttr = enumOf(attributesOfKind(['number', 'money']));
const SetAttr = enumOf(attributesOfKind(['set']));
const FlagAttr = enumOf(attributesOfKind(['flag']));
const Whole = z.number().int().min(0).max(MAX_INT4);

export const ConditionSchema = z.union([
  z.object({ attribute: NumberAttr, op: z.enum(['eq', 'gte', 'lte']), value: Whole }).strict(),
  z
    .object({ attribute: NumberAttr, op: z.literal('between'), min: Whole, max: Whole })
    .strict()
    .refine((c) => c.min <= c.max, { message: 'min', path: ['min'] }),
  z
    .object({
      attribute: SetAttr,
      op: z.enum(['any_in', 'none_in']),
      values: z.array(str().trim().min(1).max(200)).min(1).max(50),
    })
    .strict(),
  z.object({ attribute: FlagAttr, op: z.literal('is'), value: z.boolean() }).strict(),
]);

export const RuleSchema = z
  .object({
    when: z.array(ConditionSchema).max(8),
    then: enumOf([...ADD_ON_MODES]),
    /** Overrides the add-on's price for this rule, PER UNIT; null/absent = the price; 0 = free. */
    amountMinor: Whole.nullable().optional(),
    /**
     * What the per-unit amount is multiplied by (0960). Null/absent = 'order',
     * which is what every rule stored before this existed means — so an old
     * row must keep validating, and `.nullable().optional()` is how it does.
     */
    basis: enumOf([...ADD_ON_BASES]).nullable().optional(),
  })
  .strict();

export const RulesSchema = z.array(RuleSchema).min(1).max(8);
