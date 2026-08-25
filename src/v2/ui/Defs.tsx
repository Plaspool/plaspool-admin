import type { ReactNode } from 'react';

export interface DefRow {
  label: ReactNode;
  value: ReactNode;
  /** The sum line: heavier, ruled off from the rows above it. */
  total?: boolean;
}

/**
 * Label left, value right, one fact per row — the payment summary, the
 * customer card, the frozen totals. Values that are money should arrive
 * already formatted (minor units through `money()`), because this component
 * has no opinion about currencies and must never grow one.
 */
export function Defs({ rows }: { rows: DefRow[] }) {
  return (
    <div className="defs">
      {rows.map((row, i) => (
        <div key={i} className={row.total ? 'defs__row defs__row--total' : 'defs__row'}>
          <span className="defs__label">{row.label}</span>
          <span className="defs__value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}
