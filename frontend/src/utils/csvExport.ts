// Client-side CSV of whatever rows are currently loaded on a board — used by
// every new DataTable-based page's "Export" button (TableToolbar). This is
// deliberately a page-scoped export (the rows already fetched), not a
// server-side full-filtered export — dealsService.downloadExport already
// covers that for Deals specifically; this is the one mechanism every board
// (Deals, Quotes, Products, ...) can use the same way.
export function exportRowsToCsv<T>(
  columns: { header: string; value: (row: T) => string | number | undefined }[],
  rows: T[],
  filename: string,
): void {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [
    columns.map((c) => escape(c.header)).join(','),
    ...rows.map((row) => columns.map((c) => escape(String(c.value(row) ?? ''))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
