/**
 * RFC 4180 CSV reader for uploaded import files. Quoted fields may hold commas, quotes ("")
 * and line breaks; CRLF and LF both end a record; a UTF-8 byte-order mark is dropped. A
 * semicolon or tab separator is detected from the header line (spreadsheets in some locales
 * export with `;`).
 */
export class CsvParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

export interface ParsedCsv {
  headers: string[];
  /** Data rows, each as long as `headers` (short rows are padded with ""). */
  rows: string[][];
}

function detectSeparator(text: string): string {
  let firstLine = "";
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    firstLine += ch;
  }
  const count = (sep: string) => firstLine.split(sep).length - 1;
  const candidates: Array<[string, number]> = [
    [",", count(",")],
    [";", count(";")],
    ["\t", count("\t")],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  return candidates[0]![1] > 0 ? candidates[0]![0] : ",";
}

export function parseCsv(input: string, opts: { maxRows?: number } = {}): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = detectSeparator(text);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  const endRecord = () => {
    record.push(field);
    field = "";
    // A blank line is not a record.
    if (!(record.length === 1 && record[0] === "")) records.push(record);
    record = [];
    if (opts.maxRows != null && records.length > opts.maxRows + 1)
      throw new CsvParseError(`The file has more than ${opts.maxRows} rows.`, line);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      quoteLine = line;
    } else if (ch === sep) {
      record.push(field);
      field = "";
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else if (ch === "\n") {
      endRecord();
      line++;
    } else field += ch;
  }
  if (inQuotes)
    throw new CsvParseError(
      `A quoted value that starts on line ${quoteLine} has no end.`,
      quoteLine,
    );
  if (field !== "" || record.length) endRecord();
  if (!records.length) throw new CsvParseError("The file is empty.", 1);
  const headers = records[0]!.map((h) => h.trim());
  if (headers.every((h) => h === ""))
    throw new CsvParseError("The first line has no column names.", 1);
  const rows = records.slice(1).map((r) => {
    if (r.length < headers.length) return [...r, ...Array(headers.length - r.length).fill("")];
    return r;
  });
  return { headers, rows };
}
