import { randomUUID } from 'node:crypto';
export function newLogisticsId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
export const LID = { webhook: 'lgw_' } as const;
