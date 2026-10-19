const targetList = document.querySelector("#target-list");
const targetCount = document.querySelector("#target-count");
const content = document.querySelector("#dashboard-content");
const refreshButton = document.querySelector("#refresh-button");

let selectedTargetId = null;
let currentTargetData = null;
const selectedFieldsByTarget = new Map();

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    return Number(value).toLocaleString();
}

function formatDuration(value) {
    if (value === null || value === undefined) return "—";
    if (value < 1000) return `${formatNumber(value)} ms`;
    return `${(value / 1000).toFixed(2)} s`;
}

function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function statusClass(value) {
    const allowed = new Set(["complete", "failed", "complete_with_failures", "running"]);
    return allowed.has(value) ? value : "";
}

async function getJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(body.detail || `Request failed with HTTP ${response.status}`);
    }
    return body;
}

function showError(message) {
    content.innerHTML = `
        <section class="error-state">
            <p class="eyebrow">Unable to load data</p>
            <h2>Evaluation dashboard error</h2>
            <p class="muted">${escapeHtml(message)}</p>
        </section>
    `;
}

function renderTargets(targets) {
    targetCount.textContent = targets.length;
    targetList.replaceChildren();

    if (!targets.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "No targets have been created.";
        targetList.append(empty);
        return;
    }

    for (const target of targets) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "target-button";
        button.dataset.targetId = target.target_id;
        button.setAttribute("aria-pressed", target.target_id === selectedTargetId ? "true" : "false");

        const id = document.createElement("span");
        id.className = "target-id";
        id.textContent = target.target_id;

        const label = document.createElement("span");
        label.className = "target-label";
        const name = document.createElement("strong");
        name.textContent = target.name;
        const meta = document.createElement("span");
        meta.textContent = `${target.runner_key} · ${target.result_count} results`;
        label.append(name, meta);
        button.append(id, label);

        if (target.target_id === selectedTargetId) {
            button.classList.add("active");
        }
        button.addEventListener("click", () => selectTarget(target.target_id));
        targetList.append(button);
    }
}

function metric(label, value) {
    return `
        <div class="metric">
            <span class="metric-label">${escapeHtml(label)}</span>
            <span class="metric-value">${escapeHtml(value)}</span>
        </div>
    `;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectResultPaths(value, prefix = "", paths = new Set()) {
    if (Array.isArray(value)) {
        if (!prefix) return paths;

        const objectItems = value.filter(isPlainObject);
        if (objectItems.length) {
            for (const item of objectItems) {
                collectResultPaths(item, `${prefix}[]`, paths);
            }
        } else {
            paths.add(prefix);
        }
        return paths;
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (!entries.length && prefix) paths.add(prefix);
        for (const [key, child] of entries) {
            collectResultPaths(child, prefix ? `${prefix}.${key}` : key, paths);
        }
        return paths;
    }

    if (prefix) paths.add(prefix);
    return paths;
}

function availableResultPaths(data) {
    const paths = new Set();
    for (const evaluation of data.evaluations || []) {
        for (const result of evaluation.results || []) {
            if (result.actual_result !== null && result.actual_result !== undefined) {
                collectResultPaths(result.actual_result, "", paths);
            }
        }
    }
    return [...paths].sort((left, right) => left.localeCompare(right, undefined, {
        numeric: true,
    }));
}

function resolveResultPath(result, path) {
    let values = [result];

    for (const rawSegment of path.split(".")) {
        const expandsArray = rawSegment.endsWith("[]");
        const key = expandsArray ? rawSegment.slice(0, -2) : rawSegment;
        const nextValues = [];

        for (const value of values) {
            if (!isPlainObject(value) || !(key in value)) continue;
            const child = value[key];
            if (expandsArray) {
                if (Array.isArray(child)) nextValues.push(...child);
            } else {
                nextValues.push(child);
            }
        }
        values = nextValues;
    }

    return values;
}

function queriedValue(result, path) {
    const values = resolveResultPath(result, path);
    if (!values.length) return "—";

    const value = values.length === 1 ? values[0] : values;
    if (typeof value === "string") return value;
    if (value === undefined) return "—";
    if (value === null) return "null";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
}

function renderFieldSelector(data, availablePaths, selectedFields) {
    const panel = document.createElement("section");
    panel.className = "field-selector";
    panel.innerHTML = `
        <div class="field-selector-heading">
            <div>
                <p class="eyebrow">Result query</p>
                <h3>Compare selected output fields</h3>
                <p class="muted">Add JSON fields as columns to compare their values across every run.</p>
            </div>
            <button class="secondary-button clear-fields" type="button">Clear fields</button>
        </div>
        <div class="field-selector-controls">
            <label>
                <span>Result field</span>
                <select class="field-select" aria-label="Result field"></select>
            </label>
            <button class="add-field-button" type="button">Add field</button>
        </div>
        <div class="selected-fields" aria-live="polite"></div>
    `;

    const select = panel.querySelector(".field-select");
    const addButton = panel.querySelector(".add-field-button");
    const clearButton = panel.querySelector(".clear-fields");
    const selectedContainer = panel.querySelector(".selected-fields");
    const selectablePaths = availablePaths.filter((path) => !selectedFields.includes(path));

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = selectablePaths.length
        ? "Choose a field…"
        : "No more fields available";
    select.append(placeholder);

    for (const path of selectablePaths) {
        const option = document.createElement("option");
        option.value = path;
        option.textContent = path;
        select.append(option);
    }

    addButton.disabled = !selectablePaths.length;
    clearButton.disabled = !selectedFields.length;

    const applySelection = (fields) => {
        selectedFieldsByTarget.set(data.target.target_id, fields);
        renderTarget(currentTargetData);
    };

    addButton.addEventListener("click", () => {
        if (!select.value) return;
        applySelection([...selectedFields, select.value]);
    });

    select.addEventListener("change", () => {
        addButton.disabled = !select.value;
    });

    clearButton.addEventListener("click", () => applySelection([]));

    if (!selectedFields.length) {
        const empty = document.createElement("p");
        empty.className = "muted field-selector-empty";
        empty.textContent = availablePaths.length
            ? "No result fields selected. The full performance table is shown below."
            : "No queryable result fields were found in this target's stored outputs.";
        selectedContainer.append(empty);
    }

    for (const path of selectedFields) {
        const chip = document.createElement("span");
        chip.className = "field-chip";

        const label = document.createElement("span");
        label.textContent = path;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${path}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
            applySelection(selectedFields.filter((field) => field !== path));
        });

        chip.append(label, remove);
        selectedContainer.append(chip);
    }

    return panel;
}

function appendTextCell(row, value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    row.append(cell);
    return cell;
}

function appendOutputCell(row, result) {
    const cell = document.createElement("td");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const output = document.createElement("pre");

    summary.textContent = result.error_message ? "View error" : "View JSON";
    output.className = result.error_message ? "error-message" : "result-json";
    output.textContent = result.error_message
        || JSON.stringify(result.actual_result, null, 2)
        || "No output was stored.";
    details.append(summary, output);
    cell.append(details);
    row.append(cell);
}

function renderEvaluation(evaluation, selectedFields) {
    const results = evaluation.results || [];
    const isBatch = evaluation.input_mode === "batch";
    const durations = results
        .map((result) => result.performance?.duration_ms)
        .filter((value) => typeof value === "number");
    const averageDuration = durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : null;
    const totalTokens = results.reduce(
        (sum, result) => sum + (result.performance?.total_tokens || 0),
        0,
    );
    const completed = results.filter((result) => result.status === "complete").length;
    const inputBadge = isBatch
        ? `Batch #${escapeHtml(evaluation.batch_id)} · ${escapeHtml(evaluation.batch_name)}`
        : `Dataset #${escapeHtml(evaluation.dataset_id)} · ${escapeHtml(evaluation.dataset_name)} v${escapeHtml(evaluation.dataset_version)}`;

    const card = document.createElement("article");
    card.className = "evaluation-card";
    card.innerHTML = `
        <div class="evaluation-header">
            <div>
                <p class="eyebrow">Evaluation ${escapeHtml(evaluation.evaluation_id)}</p>
                <h3>${escapeHtml(evaluation.name)}</h3>
                <p class="muted">Started ${escapeHtml(formatDate(evaluation.started_at))}</p>
            </div>
            <div class="dataset-badge">${inputBadge}</div>
        </div>
        <div class="metrics">
            ${metric("Status", evaluation.status)}
            ${metric(isBatch ? "Completed datasets" : "Completed runs", `${completed}/${evaluation.requested_runs}`)}
            ${metric("Average time", formatDuration(averageDuration))}
            ${metric("Total tokens", formatNumber(totalTokens))}
            ${metric("Model", evaluation.model_requested)}
            ${metric("Prompt ID", evaluation.prompt_id)}
        </div>
        <div class="results-wrap">
            <table class="results-table">
                <thead><tr></tr></thead>
                <tbody></tbody>
            </table>
        </div>
    `;

    const headingRow = card.querySelector("thead tr");
    const headings = selectedFields.length
        ? ["Run", ...(isBatch ? ["Dataset"] : []), ...selectedFields, "Status", "Duration", "Output"]
        : ["Run", ...(isBatch ? ["Dataset"] : []), "Status", "Duration", "Prompt tokens", "Completion", "Total", "Finish", "Output"];
    for (const heading of headings) {
        const cell = document.createElement("th");
        cell.textContent = heading;
        headingRow.append(cell);
    }

    const body = card.querySelector("tbody");
    for (const result of results) {
        const performance = result.performance || {};
        const row = document.createElement("tr");
        appendTextCell(row, result.run_number, "numeric");

        if (isBatch) {
            appendTextCell(
                row,
                `#${result.dataset_id} · ${result.dataset_name} v${result.dataset_version}`,
                "dataset-cell",
            );
        }

        for (const path of selectedFields) {
            const value = queriedValue(result.actual_result, path);
            const cell = appendTextCell(row, value, "query-value");
            cell.title = value;
        }

        const statusCell = document.createElement("td");
        const status = document.createElement("span");
        status.className = `status ${statusClass(result.status)}`;
        status.textContent = result.status;
        statusCell.append(status);
        row.append(statusCell);

        appendTextCell(row, formatDuration(performance.duration_ms), "numeric");

        if (!selectedFields.length) {
            appendTextCell(row, formatNumber(performance.prompt_tokens), "numeric");
            appendTextCell(row, formatNumber(performance.completion_tokens), "numeric");
            appendTextCell(row, formatNumber(performance.total_tokens), "numeric");
            appendTextCell(row, performance.finish_reason || "—");
        }

        appendOutputCell(row, result);
        body.append(row);
    }

    if (!results.length) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = headings.length;
        cell.className = "muted";
        cell.textContent = "No result rows were stored for this evaluation.";
        row.append(cell);
        body.append(row);
    }

    return card;
}

function renderTarget(data) {
    const { target, evaluations } = data;
    currentTargetData = data;
    content.replaceChildren();

    const header = document.createElement("section");
    header.className = "target-header";
    header.innerHTML = `
        <div>
            <p class="eyebrow">Target ${escapeHtml(target.target_id)}</p>
            <h2>${escapeHtml(target.name)}</h2>
            <p class="muted">${escapeHtml(target.description || "No target description supplied.")}</p>
        </div>
        <div class="target-meta">
            <span class="pill">${escapeHtml(target.runner_key)}</span>
            <span class="pill">${escapeHtml(target.target_key)}</span>
            <span class="pill">${evaluations.length} evaluation${evaluations.length === 1 ? "" : "s"}</span>
        </div>
    `;
    content.append(header);

    const availablePaths = availableResultPaths(data);
    const selectedFields = (selectedFieldsByTarget.get(target.target_id) || [])
        .filter((path) => availablePaths.includes(path));
    selectedFieldsByTarget.set(target.target_id, selectedFields);
    content.append(renderFieldSelector(data, availablePaths, selectedFields));

    if (!evaluations.length) {
        const empty = document.createElement("section");
        empty.className = "empty-state";
        empty.innerHTML = `
            <p class="eyebrow">No evaluations</p>
            <h2>This target has no stored runs yet.</h2>
            <p class="muted">Run it through the CLI, then refresh this page.</p>
        `;
        content.append(empty);
        return;
    }

    const list = document.createElement("section");
    list.className = "evaluation-list";
    for (const evaluation of evaluations) {
        list.append(renderEvaluation(evaluation, selectedFields));
    }
    content.append(list);
}

async function selectTarget(targetId) {
    selectedTargetId = targetId;
    currentTargetData = null;
    for (const button of targetList.querySelectorAll(".target-button")) {
        const isActive = Number(button.dataset.targetId) === Number(targetId);
        button.classList.toggle("active", isActive);
        button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
    content.innerHTML = '<section class="empty-state"><p class="muted">Loading evaluation results…</p></section>';
    try {
        renderTarget(await getJson(`/api/targets/${targetId}`));
    } catch (error) {
        showError(error.message);
    }
}

async function loadDashboard() {
    try {
        const { targets } = await getJson("/api/targets");
        renderTargets(targets);
        if (selectedTargetId && targets.some((target) => target.target_id === selectedTargetId)) {
            await selectTarget(selectedTargetId);
        } else if (targets.length) {
            await selectTarget(targets[0].target_id);
        }
    } catch (error) {
        targetList.innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
        showError(error.message);
    }
}

refreshButton.addEventListener("click", loadDashboard);
loadDashboard();
