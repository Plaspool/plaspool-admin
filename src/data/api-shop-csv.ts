/**
 * The product-catalogue CSV surface (migration 0720) — export-by-email and
 * Shopify-style import.
 *
 * A SEPARATE MODULE RATHER THAN A BLOCK IN `api-shop.ts`, for the reason that
 * file itself gives about `api.ts`: it is a file another session is editing
 * right now, and a file two writers append to is a file that loses a block.
 * Nothing here is a different convention — `apiFetch` is the shared request
 * function, so `credentials: 'include'`, the error envelope and spec §8's
 * status table are the shared ones.
 *
 * Every path, method and body shape below is copied from
 * `server/shop/catalog/csv.ts` rather than remembered.
 */
import { apiFetch } from './api';

const BASE = '/shop/admin';

/** What `POST /api/shop/admin/products/export` answers (201). */
export interface ProductExportResult {
  export: {
    id: string;
    /** One row per variant; a variantless product counts one row. */
    rowCount: number;
    /**
     * The tokened download link — the SAME link the email carries. Works for
     * seven days with no session; the token in it is the whole credential.
     */
    url: string;
  };
  /** False when this deployment has no mail configured, or the send failed.
   *  The URL above is good either way. */
  emailed: boolean;
}

/** One refused row: 1-based DATA row (the header line is not counted). */
export interface CsvImportProblem {
  line: number;
  problem: string;
}

/** `mode: 'preview'` — what WOULD happen, nothing written. */
export interface CsvImportPreview {
  creates: number;
  /** Handles that already exist (non-trashed, any status). */
  updates: number;
  invalid: CsvImportProblem[];
  /** Data rows in the file, refused ones included. */
  total: number;
}

/** `mode: 'apply'` — what happened. Problem rows are skipped, never fatal. */
export interface CsvImportResult {
  applied: true;
  created: number;
  updated: number;
  /** Existing handles left alone because `replace` was false. */
  skipped: number;
  invalid: CsvImportProblem[];
}

export const shopCsvApi = {
  /**
   * Build the export NOW over the whole catalogue and email the signed-in
   * admin the download link. 201.
   */
  async exportProducts(): Promise<ProductExportResult> {
    return apiFetch<ProductExportResult>(`${BASE}/products/export`, {
      method: 'POST',
      body: {},
    });
  },

  /** Parse and count, write nothing. */
  async previewImport(csv: string, replace: boolean): Promise<CsvImportPreview> {
    return apiFetch<CsvImportPreview>(`${BASE}/products/import`, {
      method: 'POST',
      body: { csv, mode: 'preview', replace },
    });
  },

  /** Apply the file. `replace: false` skips handles that already exist. */
  async applyImport(csv: string, replace: boolean): Promise<CsvImportResult> {
    return apiFetch<CsvImportResult>(`${BASE}/products/import`, {
      method: 'POST',
      body: { csv, mode: 'apply', replace },
    });
  },
};
