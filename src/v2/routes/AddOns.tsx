import { useMemo, useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import { shopApi, type AddOnStatus, type ShopAddOn } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, money, productTone } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { StoredImg } from '../ui/Img';
import { InfoTip } from '../ui/InfoTip';
import { describeRule, summariseRules } from './add-on-copy';

/**
 * ADD-ONS — `/products/add-ons`. Extras offered to shoppers: a picture, a
 * name, a price, and rules that say when the shopper is asked or when it is
 * simply included.
 *
 * The columns, in the order a scan wants them (the owner's second round,
 * 2026-09-06): the add-on, its STATUS right beside it — draft or active is
 * the first thing to know — the price, and a few words on when it is
 * offered, with the full sentences behind an (i). The first cut spelled every
 * rule out in the row and pushed Status off the right edge of the screen.
 */
const TABS: { value: AddOnStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

/** "Ask · 1–4 items  +1 more (i)" — the lead, the count, the long form. */
function Offered({ addOn }: { addOn: ShopAddOn }) {
  const { lead, more } = summariseRules(addOn.rules, addOn.priceMinor, addOn.currency);
  return (
    <span className="offered">
      <span>{lead}</span>
      {more > 0 ? <span className="muted">+{more} more</span> : null}
      {addOn.rules.length > 0 ? (
        <InfoTip label={`How ${addOn.title} is offered, in full`}>
          <ul className="itip__list">
            {addOn.rules.map((rule, i) => (
              <li key={i}>{describeRule(rule, addOn.priceMinor, addOn.currency)}</li>
            ))}
          </ul>
        </InfoTip>
      ) : null}
    </span>
  );
}

export default function AddOns() {
  const [tab, setTab] = useState<AddOnStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const { data, error, loading } = useAsync((signal) => shopApi.listAddOns(signal), []);
  const all = data ?? [];

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return all.filter((a) => (tab === 'all' || a.status === tab) && (!q || a.title.toLowerCase().includes(q)));
  }, [all, tab, search]);

  const columns: Column<ShopAddOn>[] = [
    {
      key: 'title',
      header: 'Add-on',
      primary: true,
      render: (a) => (
        <IdCell
          thumb={a.imageId ? <StoredImg id={a.imageId} alt="" /> : <Gift aria-hidden="true" />}
          title={a.title}
          meta={
            a.description ? (
              // One line, clipped — a long description must not make its
              // row taller than its neighbours, or set the column's width.
              <span className="addons__desc" title={a.description}>
                {a.description}
              </span>
            ) : (
              <span className="muted">No description</span>
            )
          }
        />
      ),
    },
    {
      key: 'status',
      header: 'Status',
      tight: true,
      mobile: 'keep',
      render: (a) => <Badge tone={productTone(a.status)}>{humanise(a.status)}</Badge>,
    },
    { key: 'price', header: 'Price', numeric: true, render: (a) => <span className="num">{money(a.priceMinor, a.currency)}</span> },
    { key: 'rules', header: "When it's offered", render: (a) => <Offered addOn={a} /> },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Gift />}
        title="Add-ons"
        subtitle="Extras offered at checkout, and on the product page — packaging, a gift note."
        actions={
          <ButtonLink tone="primary" size="lg" to="/products/add-ons/new">
            <Plus aria-hidden="true" />
            New add-on
          </ButtonLink>
        }
      />

      {error ? (
        <Banner tone="critical" title="Couldn’t load add-ons">
          {error}
        </Banner>
      ) : null}

      <DataTable
        caption="Add-ons"
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        hrefFor={(a) => `/products/add-ons/${a.id}`}
        loading={loading}
        tabs={{ value: tab, tabs: TABS, onChange: setTab }}
        search={{ value: search, placeholder: 'Filter add-ons', onChange: setSearch }}
        empty={
          <EmptyState
            icon={search || tab !== 'all' ? <Gift /> : undefined}
            title={search || tab !== 'all' ? 'No add-ons match' : 'No add-ons yet'}
            body={
              search || tab !== 'all'
                ? 'Try another tab or a shorter search.'
                : 'Add-ons are extras offered at checkout, and on the product page — packaging, a gift note. Set the price and say when to offer it.'
            }
            actions={
              search ? (
                <Button onClick={() => setSearch('')}>Clear filter</Button>
              ) : (
                <ButtonLink tone="primary" to="/products/add-ons/new">New add-on</ButtonLink>
              )
            }
          />
        }
      />
    </div>
  );
}
