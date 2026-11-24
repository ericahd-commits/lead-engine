import { parse } from "csv-parse/sync";

export type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

export class CsvError extends Error {}

function pickDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: [string, number][] = [",", ";", "\t", "|"].map((delimiter) => [
    delimiter,
    firstLine.split(delimiter).length - 1,
  ]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ",";
}

// Reads a CSV with a header row. Every column is kept, including ones with a blank or repeated
// header (named column_3, "Phone (2)"), so the stored raw record is the whole scraped row.
export function parseCsv(text: string, maxRows: number): ParsedCsv {
  const body = text.replace(/^﻿/, "");
  if (body.trim().length === 0) throw new CsvError("The file is empty.");
  if (body.slice(0, 4) === "PK\u0003\u0004") {
    throw new CsvError("This looks like an Excel file (.xlsx). Save it as CSV and upload that.");
  }

  let records: string[][];
  try {
    records = parse(body, {
      delimiter: pickDelimiter(body),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
    }) as string[][];
  } catch (error) {
    throw new CsvError(`The file could not be read as CSV: ${(error as Error).message}`);
  }

  const headerRow = records[0];
  if (!headerRow) throw new CsvError("The file has no header row.");

  const width = records.reduce((max, record) => Math.max(max, record.length), 0);
  const seen = new Map<string, number>();
  const headers: string[] = [];
  for (let index = 0; index < width; index += 1) {
    const base = (headerRow[index] ?? "").replace(/\s+/g, " ").trim() || `column_${index + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    headers.push(count === 1 ? base : `${base} (${count})`);
  }

  const dataRows = records.slice(1).filter((record) => record.some((cell) => cell.trim().length > 0));
  if (dataRows.length === 0) throw new CsvError("The file has a header row but no data rows.");
  if (dataRows.length > maxRows) {
    throw new CsvError(
      `The file has ${dataRows.length.toLocaleString("en-US")} rows; the limit is ${maxRows.toLocaleString("en-US")}. Split it and upload the parts.`,
    );
  }

  const rows = dataRows.map((record) => {
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = record[index] ?? "";
    });
    return row;
  });

  return { headers, rows };
}
