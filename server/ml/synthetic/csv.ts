/**
 * CSV reading and writing for the synthetic dataset (Phase 3).
 *
 * The brief allows CSV and nothing else for saved data, so every file the
 * generator writes — observed rows, layer rows, ground truth, manifest,
 * checksums and the quality report — goes through `toCsv`, and everything the
 * loader and checks read goes through `parseCsv`. Both are plain RFC 4180 so the
 * files open correctly in any spreadsheet or script.
 *
 * Timestamps are written as ISO 8601 (UTC) and read back with `fromIso`, so a
 * value survives a round trip exactly.
 */

export type Cell = string | number | null

function escapeCell(value: Cell): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? String(value) : value
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

/** Serialise a header and rows to CSV text (LF endings, trailing newline). */
export function toCsv(header: string[], rows: Cell[][]): string {
  const lines = [header.join(',')]
  for (const row of rows) lines.push(row.map(escapeCell).join(','))
  return lines.join('\n') + '\n'
}

/** Parse CSV text into rows of raw strings. Handles quoted fields and CRLF. */
export function parseCsv(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let index = 0
  while (index < normalized.length) {
    const ch = normalized[index]
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        inQuotes = false
        index += 1
        continue
      }
      field += ch
      index += 1
      continue
    }
    if (ch === '"') {
      inQuotes = true
      index += 1
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      index += 1
      continue
    }
    field += ch
    index += 1
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export type CsvRecord = Record<string, string>

/** Parse CSV text whose first row is a header into records keyed by column. */
export function parseCsvRecords(text: string): CsvRecord[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0]
  const out: CsvRecord[] = []
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i]
    if (cells.length === 1 && cells[0] === '') continue
    const record: CsvRecord = {}
    for (let c = 0; c < header.length; c += 1) record[header[c]] = cells[c] ?? ''
    out.push(record)
  }
  return out
}

/** Milliseconds to ISO 8601 (UTC). */
export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** ISO 8601 back to milliseconds; throws on an unparseable value. */
export function fromIso(value: string): number {
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) throw new Error(`Not an ISO timestamp: ${value}`)
  return ms
}

/** Parse a required integer cell. */
export function intCell(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`Not a number: ${value}`)
  return parsed
}

/** Parse an optional cell: an empty string is `null`, never zero. */
export function optionalCell(value: string): string | null {
  return value === '' ? null : value
}

export function optionalInt(value: string): number | null {
  return value === '' ? null : Number(value)
}
