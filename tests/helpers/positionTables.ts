/** In-memory relational query double; applies filters/order/limits, never uses a network. */
export type Row = Record<string, string | number | boolean | null>;
export type Table = 'positions' | 'speculations' | 'contests';
export type Tables = Record<Table, Row[]>;
export interface Query {
  table: Table;
  select?: string;
  eq: Array<[string, unknown]>;
  gt: Array<[string, unknown]>;
  lt: Array<[string, unknown]>;
  joins: Array<[string, unknown[]]>;
  orders: Array<[string, { ascending: boolean; nullsFirst?: boolean }]>;
  limit?: number;
}
export interface Reply { data: Row[] | null; error: { message: string } | null }

export function positionTables(
  tables: Tables,
  intercept?: (query: Query, occurrence: number, reply: Reply) => Reply | void,
) {
  const queries: Query[] = [];
  const occurrences: Record<Table, number> = { positions: 0, speculations: 0, contests: 0 };
  return {
    queries,
    from(table: Table) {
      const q: Query = { table, eq: [], gt: [], lt: [], joins: [], orders: [] };
      const builder = {
        select(columns: string) { q.select = columns; return builder; },
        eq(column: string, value: unknown) { q.eq.push([column, value]); return builder; },
        gt(column: string, value: unknown) { q.gt.push([column, value]); return builder; },
        lt(column: string, value: unknown) { q.lt.push([column, value]); return builder; },
        in(column: string, values: unknown[]) { q.joins.push([column, values]); return builder; },
        order(column: string, options: { ascending: boolean; nullsFirst?: boolean }) {
          q.orders.push([column, options]); return builder;
        },
        limit(value: number) { q.limit = value; return builder; },
        range() { throw new Error('Offset paging must never be used for an unclaimed scan'); },
        then(resolve: (reply: Reply) => void) {
          queries.push(q);
          const data = tables[table].filter((row) =>
            q.eq.every(([k, v]) => row[k] === v) &&
            q.gt.every(([k, v]) => BigInt(String(row[k])) > BigInt(String(v))) &&
            q.lt.every(([k, v]) => BigInt(String(row[k])) < BigInt(String(v))) &&
            q.joins.every(([k, values]) => values.includes(row[k])),
          ).sort((a, b) => {
            for (const [k, options] of q.orders) {
              if (a[k] === b[k]) continue;
              if (a[k] == null) return options.nullsFirst ? -1 : 1;
              if (b[k] == null) return options.nullsFirst ? 1 : -1;
              const av = k === 'id' ? BigInt(String(a[k])) : a[k];
              const bv = k === 'id' ? BigInt(String(b[k])) : b[k];
              const comparison = av! < bv! ? -1 : av! > bv! ? 1 : 0;
              if (comparison) return options.ascending ? comparison : -comparison;
            }
            return 0;
          }).slice(0, q.limit);
          const reply: Reply = { data, error: null };
          resolve(intercept?.(q, ++occurrences[table], reply) ?? reply);
        },
      };
      return builder;
    },
  };
}

export const ADDRESS = '0xabcdefabcdef0123456789abcdef0123456789ab';
export const STAMP = '2026-09-05T01:02:03.123456+00:00';

/** Synthetic scale inputs only — these are NOT captured ledger rows. */
export function scaleTables(count: number): Tables {
  const tables: Tables = { positions: [], speculations: [], contests: [] };
  for (let id = 1; id <= count; id++) {
    tables.positions.push({
      id, speculation_id: id, user_address: ADDRESS, network: 'polygon', position_type: 'upper',
      risk_amount: '10000', profit_amount: '15000', claimed: false,
      position_created_at: STAMP, row_updated_at: STAMP,
    });
    tables.speculations.push({
      speculation_id: id, contest_id: id, network: 'polygon', market_type: 'moneyline',
      line_ticks: 0, speculation_status: 'open', win_side: 'tbd', row_updated_at: STAMP,
    });
    tables.contests.push({
      contest_id: id, network: 'polygon', away_team: 'Away', home_team: 'Home', sport_slug: 'mlb',
      contest_status: 'scored', away_score: 7, home_score: 6, row_updated_at: STAMP,
    });
  }
  return tables;
}
