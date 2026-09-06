import { useMemo, useState } from 'react';
import { Gift, Plus } from 'lucide-react';
import { shopApi, type AddOnStatus, type ShopAddOn } from '../../data/api-shop';
import { useAsync } from '../lib/useAsync';
import { humanise, money, productTone } from '../lib/format';
import { PageHeader } from '../ui/Page';
import { Badge, Banner, Button, ButtonLink, EmptyState } from '../ui/primitives';
import { DataTable, IdCell, type Column } from '../ui/DataTable';
import { StoredImg } from '../ui/Img';
import { describeRules } from './add-on-copy';

/**
 * ADD-ONS — `/products/add-ons`. Extras offered at checkout: a picture, a
 * name, a price, and rules that say when the shopper is asked or when it is
 * simply included. The list shows the rules as one sentence so the owner can
 * read the shop's behaviour without opening each row.
 */
const TABS: { value: AddOnStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'archived', label: 'Archived' },
];

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
          meta={a.description ?? <span className="muted">No description</span>}
        />
      ),
    },
    { key: 'price', header: 'Price', numeric: true, render: (a) => <span className="num">{money(a.priceMinor, a.currency)}</span> },
    { key: 'rules', header: "When it's offered", render: (a) => describeRules(a.rules, a.priceMinor, a.currency) },
    { key: 'status', header: 'Status', tight: true, render: (a) => <Badge tone={productTone(a.status)}>{humanise(a.status)}</Badge> },
  ];

  return (
    <div className="page">
      <PageHeader
        icon={<Gift />}
        title="Add-ons"
        subtitle="Extras offered at checkout — packaging, a gift note."
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
                : 'Add-ons are extras offered at checkout — packaging, a gift note. Set the price and say when to offer it.'
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
