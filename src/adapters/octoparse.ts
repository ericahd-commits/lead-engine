import { stringify } from "csv-stringify/sync";

// Read-only client for the Octoparse OpenAPI (https://openapi.octoparse.com). It lists tasks and
// reads the rows a task has already collected. It never starts a run, changes a task or marks
// data as exported: those write to Octoparse and are not built.
//
// Shapes are the ones in Octoparse's published spec (read 25 Nov 2026):
//   GET /taskGroup                      -> { data: [{ taskGroupId, taskGroupName }] }
//   GET /task/search?taskGroupId=       -> { data: [{ taskId, taskName }] }
//   GET /data/all?taskId=&offset=&size= -> { data: { data: [row], total, restTotal, offset } }
// TODO: the spec does not say what the largest page size is, or what the returned "offset"
// means. PAGE_SIZE is a cautious choice, and the next offset is the returned one only when it
// moves forward; otherwise the rows received are counted.

export class OctoparseError extends Error {}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type OctoparseTask = { taskId: string; taskName: string; group: string };

const BASE = "https://openapi.octoparse.com";
const PAGE_SIZE = 500;
const TIMEOUT_MS = 30_000;

async function call(fetchImpl: FetchLike, apiKey: string, path: string): Promise<unknown> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${BASE}${path}`, {
      method: "GET",
      headers: { "x-api-key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new OctoparseError(`Octoparse could not be reached: ${(error as Error).message}. Nothing was imported.`);
  }
  const body = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new OctoparseError(
      `Octoparse refused the API key (HTTP ${response.status}). Check OCTOPARSE_API_KEY, and that the plan includes API access. Nothing was imported.`,
    );
  }
  if (response.status === 429) throw new OctoparseError("Octoparse says too many requests. Wait a minute and try again. Nothing was imported.");
  if (!response.ok) {
    throw new OctoparseError(`Octoparse answered HTTP ${response.status}: ${body.slice(0, 200) || "no details"}. Nothing was imported.`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new OctoparseError("Octoparse sent an answer that is not JSON. Nothing was imported.");
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function listTasks(fetchImpl: FetchLike, apiKey: string): Promise<OctoparseTask[]> {
  const groups = await call(fetchImpl, apiKey, "/taskGroup");
  if (!isRecord(groups) || !Array.isArray(groups.data)) throw new OctoparseError("Octoparse sent a task group list in a shape this app does not know.");
  const tasks: OctoparseTask[] = [];
  for (const group of groups.data) {
    if (!isRecord(group) || group.taskGroupId === undefined) continue;
    const found = await call(fetchImpl, apiKey, `/task/search?taskGroupId=${encodeURIComponent(String(group.taskGroupId))}`);
    if (!isRecord(found) || !Array.isArray(found.data)) throw new OctoparseError("Octoparse sent a task list in a shape this app does not know.");
    for (const task of found.data) {
      if (!isRecord(task) || typeof task.taskId !== "string") continue;
      tasks.push({ taskId: task.taskId, taskName: String(task.taskName ?? task.taskId), group: String(group.taskGroupName ?? "") });
    }
  }
  return tasks;
}

// Every row the task currently holds. Refuses, rather than cuts short, when there are more rows
// than the import limit: a silently shortened import would look complete.
export async function fetchTaskRows(
  fetchImpl: FetchLike,
  apiKey: string,
  taskId: string,
  maxRows: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  const tooMany = (n: number) =>
    new OctoparseError(
      `This task holds ${n.toLocaleString("en-US")} rows or more; the import limit is ${maxRows.toLocaleString("en-US")}. Export it from Octoparse in parts and upload the files. Nothing was imported.`,
    );
  for (let page = 0; page < Math.ceil(maxRows / PAGE_SIZE) + 2; page += 1) {
    const answer = await call(fetchImpl, apiKey, `/data/all?taskId=${encodeURIComponent(taskId)}&offset=${offset}&size=${PAGE_SIZE}`);
    const data = isRecord(answer) ? answer.data : null;
    if (!isRecord(data) || !Array.isArray(data.data)) throw new OctoparseError("Octoparse sent task data in a shape this app does not know. Nothing was imported.");
    if (typeof data.total === "number" && data.total > maxRows) throw tooMany(data.total);
    const batch = data.data.filter(isRecord);
    if (batch.length === 0) return rows;
    rows.push(...batch);
    if (rows.length > maxRows) throw tooMany(rows.length);
    if (typeof data.total === "number" && rows.length >= data.total) return rows;
    offset = typeof data.offset === "number" && data.offset > offset ? data.offset : offset + batch.length;
  }
  throw new OctoparseError("Octoparse kept sending rows past the import limit. Nothing was imported.");
}

// The rows as a CSV, so they enter through exactly the same door as an uploaded file.
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const cell = (value: unknown): string =>
    value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return stringify([headers, ...rows.map((row) => headers.map((header) => cell(row[header])))]);
}
