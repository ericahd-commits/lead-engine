import { fetchTaskRows, getTaskInputs, listTasks, OctoparseError, rowsToCsv, type FetchLike, type OctoparseTask } from "../../adapters/octoparse.js";
import { logAudit } from "../../audit.js";
import { createImport } from "../../pipeline/importRun.js";
import { can, need, ok, str, type App, type Deps } from "../http.js";
import { count, Csrf, Page, render } from "../views.js";

// Octoparse, read-only: pick a task, and the rows it has already collected come in as an import.
// Starting a run or changing a task's keywords writes to Octoparse and is not built.
export function registerOctoparseRoutes(app: App, { db, config, fetchImpl }: Deps): void {
  const http: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));

  app.get("/scrape", async (c) => {
    const session = c.get("session");
    let tasks: OctoparseTask[] = [];
    let failure: string | null = null;
    if (config.octoparseApiKey) {
      try {
        tasks = await listTasks(http, config.octoparseApiKey);
      } catch (error) {
        if (!(error instanceof OctoparseError)) throw error;
        failure = error.message;
      }
    }

    return render(
      c,
      <Page
        c={c}
        title="Scrape"
        active="scrape"
        step="Step 1"
        crumb="Scrape"
        sub="Leads are scraped by your Octoparse tasks. Pick a task here to bring the rows it collected into the app."
      >
        <div class="note">
          Keywords, category and location are set inside each Octoparse task, not here. This page only reads rows a task has
          already collected. It does not start a run, change a task, or mark anything as exported in Octoparse. Typing
          keywords here and starting the scrape from this page is not built yet.
        </div>
        {!config.octoparseApiKey ? (
          <div class="card" style="display:grid;gap:6px">
            <strong>Octoparse is not connected</strong>
            <span class="small">
              An admin of the server has to add the variable <code>OCTOPARSE_API_KEY</code> (in Railway, or in the local .env file)
              and restart. The key is made in the Octoparse account center. Until then, export the task as CSV and upload it on the{" "}
              <a href="/imports">Import</a> screen.
            </span>
          </div>
        ) : failure ? (
          <div class="note err">{failure}</div>
        ) : (
          <div class="card flush">
            <div class="card-h">
              <h2>Tasks</h2>
              <span class="muted small">{count(tasks.length)} in the connected Octoparse account</span>
            </div>
            {tasks.length === 0 ? (
              <div class="empty">The connected Octoparse account has no tasks.</div>
            ) : (
              <div class="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Group</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => (
                      <tr>
                        <td style="font-weight:600">{task.taskName}</td>
                        <td class="muted">{task.group || "—"}</td>
                        <td class="num">
                          {can(session, "admin") ? (
                            <a
                              class="small"
                              style="margin-right:12px"
                              href={`/scrape/inputs?task_id=${encodeURIComponent(task.taskId)}&task_name=${encodeURIComponent(task.taskName)}`}
                            >
                              See inputs
                            </a>
                          ) : null}
                          {can(session, "reviewer") ? (
                            <form method="post" action="/scrape" style="display:inline">
                              <Csrf session={session} />
                              <input type="hidden" name="task_id" value={task.taskId} />
                              <input type="hidden" name="task_name" value={task.taskName} />
                              <button type="submit">Pull rows into Import</button>
                            </form>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Page>,
    );
  });

  // What a task is set up to search for, as Octoparse stores it. Shown as received, because
  // Octoparse does not document the shape. Admins only: it is a diagnostic view.
  app.get("/scrape/inputs", async (c) => {
    need(c, "admin");
    const taskId = c.req.query("task_id")?.trim() ?? "";
    const taskName = c.req.query("task_name")?.trim() || taskId;
    let inputs: unknown = null;
    let failure: string | null = null;
    if (!config.octoparseApiKey) failure = "Octoparse is not connected (OCTOPARSE_API_KEY is not set).";
    else if (!taskId) failure = "Choose a task on the Octoparse screen first.";
    else {
      try {
        inputs = await getTaskInputs(http, config.octoparseApiKey, taskId);
      } catch (error) {
        if (!(error instanceof OctoparseError)) throw error;
        failure = `${error.message} Octoparse only allows reading a task's inputs on the Professional or Enterprise plan.`;
      }
    }
    return render(
      c,
      <Page
        c={c}
        title="Task inputs"
        active="scrape"
        step="Step 1"
        crumb="Scrape / Task inputs"
        sub={`${taskName}: what this Octoparse task is set up to search for.`}
      >
        <div class="note">
          This is read from Octoparse and shown exactly as it arrived. Nothing in the task is changed. The keyword or URL list
          should be somewhere in it.
        </div>
        {failure ? (
          <div class="note err">{failure}</div>
        ) : (
          <div class="card">
            <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px">{JSON.stringify(inputs, null, 2)}</pre>
          </div>
        )}
        <div>
          <a class="btn" href="/scrape">
            Back to tasks
          </a>
        </div>
      </Page>,
    );
  });

  app.post("/scrape", async (c) => {
    const session = need(c, "reviewer");
    if (!config.octoparseApiKey) throw new OctoparseError("Octoparse is not connected (OCTOPARSE_API_KEY is not set). Nothing was imported.");
    const form = c.get("form");
    const taskId = str(form, "task_id");
    if (!taskId) throw new OctoparseError("Choose a task.");
    const taskName = str(form, "task_name") || taskId;

    const rows = await fetchTaskRows(http, config.octoparseApiKey, taskId, config.maxImportRows);
    if (rows.length === 0) throw new OctoparseError(`Octoparse has no rows for "${taskName}". Run the task in Octoparse first. Nothing was imported.`);
    const { runId } = await createImport(db, {
      user: session.user,
      sourceName: `Octoparse: ${taskName}`,
      fileName: `octoparse-${taskId}.csv`,
      text: rowsToCsv(rows),
      maxRows: config.maxImportRows,
    });
    await logAudit(db, session.user, "octoparse.pulled", `run:${runId}`, { taskId, taskName, rows: rows.length });
    return ok(c, `/imports/${runId}`, `Pulled ${count(rows.length)} rows from Octoparse. Match the columns below to finish the import.`);
  });
}
