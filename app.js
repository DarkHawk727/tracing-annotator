import {
  DEFAULT_CUTOFF_HZ,
  DEFAULT_TRANSITION_HZ,
  PEAK_SNAP_WINDOW_S,
  annotationsToCsv,
  createZip,
  fftLowpassDenoise,
  formatClock,
  formatDuration,
  nearestIndex,
  parsePermissionText,
  parseTracingText,
  snapToPeak,
  toSeconds
} from "./core.js";

const byId = (id) => document.getElementById(id);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const fileSize = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

class TracingAnnotatorApp {
  constructor() {
    this.pendingTraceFiles = [];
    this.pendingPermissionFile = null;
    this.traces = new Map();
    this.permissionByMrn = new Map();
    this.annotations = [];
    this.unsureMrns = new Set();
    this.currentMrn = null;
    this.filter = { cutoff: DEFAULT_CUTOFF_HZ, transition: DEFAULT_TRANSITION_HZ };
    this.yAxis = { minimum: -50, maximum: 100 };
    this.filterCache = new Map();
    this.currentResult = null;
    this.view = null;
    this.renderToken = 0;
    this.pointerState = null;
    this.bindUploadControls();
    this.bindWorkspaceControls();
    this.configureChart();
  }

  bindUploadControls() {
    const dropzone = byId("traceDropzone");
    const traceInput = byId("traceFiles");
    dropzone.addEventListener("click", (event) => {
      if (event.target !== traceInput) traceInput.click();
    });
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        traceInput.click();
      }
    });
    for (const eventName of ["dragenter", "dragover"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add("dragover");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("dragover");
      });
    }
    dropzone.addEventListener("drop", (event) => this.queueTraceFiles(event.dataTransfer.files));
    traceInput.addEventListener("change", () => {
      this.queueTraceFiles(traceInput.files);
      traceInput.value = "";
    });
    byId("permissionButton").addEventListener("click", (event) => {
      if (event.target !== byId("permissionFile")) byId("permissionFile").click();
    });
    byId("permissionFile").addEventListener("change", (event) => {
      this.pendingPermissionFile = event.target.files[0] || null;
      byId("permissionFileLabel").textContent = this.pendingPermissionFile ? `${this.pendingPermissionFile.name} · ${fileSize(this.pendingPermissionFile.size)}` : "Choose one lookup table · Optional";
    });
    byId("startButton").addEventListener("click", () => this.startReview());
  }

  bindWorkspaceControls() {
    byId("patientSelect").addEventListener("change", (event) => this.selectPatient(event.target.value));
    byId("setPermissionButton").addEventListener("click", () => this.setPermissionTime());
    byId("permissionTimeInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.setPermissionTime();
    });
    byId("applyFilterButton").addEventListener("click", () => this.applyFilter());
    byId("applyYAxisButton").addEventListener("click", () => this.applyYAxisRange());
    for (const id of ["yMinInput", "yMaxInput"]) {
      byId(id).addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.applyYAxisRange();
      });
    }
    byId("rawToggle").addEventListener("change", () => this.drawChart());
    byId("resetZoomButton").addEventListener("click", () => {
      this.resetView();
      this.drawChart();
    });
    byId("addPointButton").addEventListener("click", () => this.addManualPoint());
    byId("annotationTimeInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.addManualPoint();
    });
    byId("undoButton").addEventListener("click", () => this.undoPoint());
    byId("unsureButton").addEventListener("click", () => this.toggleUnsure());
    byId("nextUnsureButton").addEventListener("click", () => this.selectNextUnsure());
    byId("clearPatientButton").addEventListener("click", () => this.clearPatientPoints());
    byId("downloadButton").addEventListener("click", () => this.downloadReview());
    byId("clearReviewButton").addEventListener("click", () => this.clearReview());
    byId("addMoreButton").addEventListener("click", () => {
      const picker = document.createElement("input");
      picker.type = "file";
      picker.accept = ".csv,.tsv,.txt,text/csv";
      picker.multiple = true;
      picker.addEventListener("change", () => this.addTracingFiles(picker.files));
      picker.click();
    });
  }

  configureChart() {
    this.canvas = byId("traceChart");
    this.context = this.canvas.getContext("2d");
    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObserver.observe(byId("chartWrap"));
    this.canvas.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.onPointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.onPointerUp(event));
    this.canvas.addEventListener("pointercancel", () => { this.pointerState = null; });
    this.canvas.addEventListener("pointerleave", () => {
      if (!this.pointerState) byId("chartTooltip").hidden = true;
    });
    this.canvas.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
  }

  queueTraceFiles(fileList) {
    const files = [...fileList].filter((file) => /\.(csv|tsv|txt)$/i.test(file.name));
    for (const file of files) {
      const existing = this.pendingTraceFiles.findIndex((queued) => queued.name === file.name);
      if (existing >= 0) this.pendingTraceFiles[existing] = file;
      else this.pendingTraceFiles.push(file);
    }
    this.renderTraceQueue();
  }

  renderTraceQueue() {
    const queue = byId("traceQueue");
    queue.replaceChildren();
    this.pendingTraceFiles.forEach((file, index) => {
      const item = document.createElement("div");
      item.className = "queued-file";
      item.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${fileSize(file.size)}</span><button type="button" aria-label="Remove ${escapeHtml(file.name)}">×</button>`;
      item.querySelector("button").addEventListener("click", () => {
        this.pendingTraceFiles.splice(index, 1);
        this.renderTraceQueue();
      });
      queue.append(item);
    });
    byId("startButton").disabled = this.pendingTraceFiles.length === 0;
    byId("uploadError").hidden = true;
  }

  async startReview() {
    const button = byId("startButton");
    const errorBox = byId("uploadError");
    button.disabled = true;
    button.textContent = "Loading files…";
    errorBox.hidden = true;
    await nextFrame();
    const errors = [];
    const parsedTraces = new Map();
    for (const file of this.pendingTraceFiles) {
      try {
        const trace = parseTracingText(await file.text(), file.name);
        trace.originalFile = file;
        parsedTraces.set(trace.mrn, trace);
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }
    if (!parsedTraces.size) {
      errorBox.innerHTML = `<strong>No tracings could be loaded.</strong><br>${errors.map(escapeHtml).join("<br>")}`;
      errorBox.hidden = false;
      button.disabled = false;
      button.innerHTML = "Start reviewing <span aria-hidden=\"true\">→</span>";
      return;
    }

    this.traces = parsedTraces;
    this.permissionByMrn = new Map();
    if (this.pendingPermissionFile) {
      try {
        this.permissionByMrn = parsePermissionText(await this.pendingPermissionFile.text());
      } catch (error) {
        errors.push(`${this.pendingPermissionFile.name}: ${error.message}`);
      }
    }
    this.annotations = [];
    this.unsureMrns.clear();
    this.filterCache.clear();
    byId("uploadView").hidden = true;
    byId("workspaceView").hidden = false;
    this.populatePatientSelect();
    await this.selectPatient([...this.traces.keys()][0]);
    if (errors.length) this.showMessage(`Loaded ${this.traces.size} tracing(s). ${errors.join(" ")}`, true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async addTracingFiles(fileList) {
    const errors = [];
    let loaded = 0;
    for (const file of [...fileList]) {
      try {
        const trace = parseTracingText(await file.text(), file.name);
        trace.originalFile = file;
        this.traces.set(trace.mrn, trace);
        for (const key of this.filterCache.keys()) {
          if (key.startsWith(`${trace.mrn}|`)) this.filterCache.delete(key);
        }
        loaded += 1;
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }
    this.populatePatientSelect();
    this.updateSummary();
    if (loaded) await this.selectPatient(this.currentMrn || [...this.traces.keys()][0]);
    this.showMessage(`${loaded} tracing(s) added or replaced.${errors.length ? ` ${errors.join(" ")}` : ""}`, errors.length > 0);
  }

  populatePatientSelect() {
    const select = byId("patientSelect");
    const current = this.currentMrn;
    select.replaceChildren();
    [...this.traces.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((mrn) => {
      const option = document.createElement("option");
      option.value = mrn;
      option.textContent = `${this.unsureMrns.has(mrn) ? "⚑ " : ""}MRN ${mrn}`;
      select.append(option);
    });
    if (current && this.traces.has(current)) select.value = current;
  }

  async selectPatient(mrn) {
    if (!this.traces.has(String(mrn))) return;
    this.currentMrn = String(mrn);
    byId("patientSelect").value = this.currentMrn;
    this.resetView();
    this.updatePatientDetails();
    this.renderAnnotations();
    await this.computeCurrentSignal();
  }

  async computeCurrentSignal() {
    const token = ++this.renderToken;
    const overlay = byId("processingOverlay");
    overlay.hidden = false;
    await nextFrame();
    const key = `${this.currentMrn}|${this.filter.cutoff}|${this.filter.transition}`;
    try {
      if (!this.filterCache.has(key)) {
        const trace = this.traces.get(this.currentMrn);
        this.filterCache.set(key, fftLowpassDenoise(trace.time, trace.pdet, this.filter.cutoff, this.filter.transition));
      }
      if (token !== this.renderToken) return;
      this.currentResult = this.filterCache.get(key);
      this.drawChart();
    } catch (error) {
      this.showMessage(`Could not filter MRN ${this.currentMrn}: ${error.message}`, true);
    } finally {
      if (token === this.renderToken) overlay.hidden = true;
    }
  }

  updatePatientDetails() {
    const trace = this.traces.get(this.currentMrn);
    const keys = [...this.traces.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const permission = this.permissionByMrn.get(this.currentMrn);
    byId("currentMrn").textContent = this.currentMrn;
    byId("patientPosition").textContent = `${keys.indexOf(this.currentMrn) + 1} of ${keys.length}`;
    byId("currentFilename").textContent = trace.filename;
    byId("currentFilename").title = trace.filename;
    byId("sampleCount").textContent = trace.time.length.toLocaleString();
    byId("durationLabel").textContent = formatDuration(trace.time[trace.time.length - 1] - trace.time[0]);
    byId("permissionTimeInput").value = Number.isFinite(permission) ? formatClock(permission) : "";
    byId("permissionStatus").textContent = Number.isFinite(permission) ? "Matched" : "Not found";
    byId("permissionStatus").classList.toggle("found", Number.isFinite(permission));
    this.updateSummary();
    this.updateUnsureControls();
  }

  updateSummary() {
    byId("traceCount").textContent = this.traces.size;
    byId("permissionCount").textContent = [...this.traces.keys()].filter((mrn) => this.permissionByMrn.has(mrn)).length;
    byId("annotationCount").textContent = this.annotations.length;
    byId("unsureCount").textContent = this.unsureMrns.size;
  }

  toggleUnsure() {
    if (!this.currentMrn) return;
    const wasUnsure = this.unsureMrns.has(this.currentMrn);
    if (wasUnsure) this.unsureMrns.delete(this.currentMrn);
    else this.unsureMrns.add(this.currentMrn);
    this.populatePatientSelect();
    byId("patientSelect").value = this.currentMrn;
    this.updateUnsureControls();
    this.updateSummary();
    this.showMessage(wasUnsure
      ? `MRN ${this.currentMrn} removed from the unsure review queue.`
      : `MRN ${this.currentMrn} marked unsure. Use “Next unsure” to return to flagged tracings.`);
  }

  updateUnsureControls() {
    const button = byId("unsureButton");
    const isUnsure = this.currentMrn && this.unsureMrns.has(this.currentMrn);
    button.classList.toggle("active", Boolean(isUnsure));
    button.setAttribute("aria-pressed", String(Boolean(isUnsure)));
    button.querySelector("span").textContent = isUnsure ? "Marked unsure" : "Mark unsure";
    const nextButton = byId("nextUnsureButton");
    nextButton.hidden = this.unsureMrns.size === 0;
    nextButton.title = this.unsureMrns.size ? `${this.unsureMrns.size} tracing(s) marked unsure` : "";
  }

  async selectNextUnsure() {
    if (!this.unsureMrns.size) return;
    const tracingOrder = [...this.traces.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const flagged = tracingOrder.filter((mrn) => this.unsureMrns.has(mrn));
    const currentIndex = flagged.indexOf(this.currentMrn);
    const nextMrn = flagged[(currentIndex + 1 + flagged.length) % flagged.length];
    await this.selectPatient(nextMrn);
    this.showMessage(`Reviewing unsure tracing MRN ${nextMrn} (${flagged.indexOf(nextMrn) + 1} of ${flagged.length}).`);
  }

  setPermissionTime() {
    const seconds = toSeconds(byId("permissionTimeInput").value);
    if (!Number.isFinite(seconds)) {
      this.showMessage("Enter the permission time as seconds, MM:SS, or HH:MM:SS.", true);
      return;
    }
    this.permissionByMrn.set(this.currentMrn, seconds);
    this.updatePatientDetails();
    this.drawChart();
    this.showMessage(`Permission to void set to ${formatClock(seconds)} for MRN ${this.currentMrn}.`);
  }

  async applyFilter() {
    const cutoff = Number(byId("cutoffInput").value);
    const transition = Number(byId("transitionInput").value);
    if (!Number.isFinite(cutoff) || cutoff < 0 || !Number.isFinite(transition) || transition < 0) {
      this.showMessage("Cutoff and transition frequencies must be zero or greater.", true);
      return;
    }
    this.filter = { cutoff, transition };
    await this.computeCurrentSignal();
    this.showMessage(`Filter applied: ${cutoff} Hz cutoff, ${transition} Hz transition.`);
  }

  applyYAxisRange() {
    const minimum = Number(byId("yMinInput").value);
    const maximum = Number(byId("yMaxInput").value);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
      this.showMessage("Enter valid numbers for both Y-axis limits.", true);
      return;
    }
    if (minimum >= maximum) {
      this.showMessage("The Y-axis maximum must be greater than the minimum.", true);
      return;
    }
    this.yAxis = { minimum, maximum };
    this.drawChart();
    this.showMessage(`Y-axis range set to ${minimum}–${maximum} cmH₂O.`);
  }

  addManualPoint() {
    const requestedTime = Number(byId("annotationTimeInput").value);
    if (!Number.isFinite(requestedTime)) {
      this.showMessage("Click the chart or enter a valid time before adding a point.", true);
      return;
    }
    this.addPoint(requestedTime, byId("annotationNoteInput").value);
  }

  addPoint(requestedTime, note = "") {
    if (!this.currentResult) return;
    const minimum = this.currentResult.time[0];
    const maximum = this.currentResult.time[this.currentResult.time.length - 1];
    if (requestedTime < minimum || requestedTime > maximum) {
      this.showMessage(`Time must be between ${minimum.toFixed(1)} and ${maximum.toFixed(1)} seconds.`, true);
      return;
    }
    const snapped = snapToPeak(this.currentResult, requestedTime, PEAK_SNAP_WINDOW_S);
    this.annotations.push({
      MRN: this.currentMrn,
      Time: Number(snapped.time.toFixed(6)),
      Pdet: Number(snapped.pdet.toFixed(6)),
      FFT_Cutoff_Hz: this.filter.cutoff,
      FFT_Transition_Hz: this.filter.transition,
      Note: String(note || "").trim(),
    });
    byId("annotationTimeInput").value = snapped.time.toFixed(1);
    byId("annotationNoteInput").value = "";
    this.renderAnnotations();
    this.drawChart();
    this.showMessage(`Point added at the local peak ${snapped.time.toFixed(1)}s (requested ${requestedTime.toFixed(1)}s, ±${PEAK_SNAP_WINDOW_S}s).`);
  }

  patientAnnotations() {
    return this.annotations.map((point, globalIndex) => ({ point, globalIndex })).filter(({ point }) => point.MRN === this.currentMrn);
  }

  renderAnnotations() {
    const body = byId("annotationTableBody");
    const points = this.patientAnnotations();
    body.replaceChildren();
    points.forEach(({ point, globalIndex }, patientIndex) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${patientIndex + 1}</td><td>${Number(point.Time).toFixed(1)} s</td><td>${Number(point.Pdet).toFixed(2)}</td><td>${Number(point.FFT_Cutoff_Hz).toFixed(3)} Hz</td><td>${Number(point.FFT_Transition_Hz).toFixed(3)} Hz</td><td class="note-cell">${escapeHtml(point.Note) || "—"}</td><td><button class="delete-point" type="button" aria-label="Delete point ${patientIndex + 1}">×</button></td>`;
      row.querySelector("button").addEventListener("click", () => {
        this.annotations.splice(globalIndex, 1);
        this.renderAnnotations();
        this.drawChart();
      });
      body.append(row);
    });
    byId("emptyAnnotations").hidden = points.length > 0;
    body.closest("table").hidden = points.length === 0;
    this.updateSummary();
  }

  undoPoint() {
    const patientPoints = this.patientAnnotations();
    if (!patientPoints.length) {
      this.showMessage(`There are no points to undo for MRN ${this.currentMrn}.`, true);
      return;
    }
    this.annotations.splice(patientPoints[patientPoints.length - 1].globalIndex, 1);
    this.renderAnnotations();
    this.drawChart();
    this.showMessage(`Removed the latest point for MRN ${this.currentMrn}.`);
  }

  clearPatientPoints() {
    const count = this.patientAnnotations().length;
    if (!count) return;
    if (!window.confirm(`Remove all ${count} point(s) for MRN ${this.currentMrn}?`)) return;
    this.annotations = this.annotations.filter((point) => point.MRN !== this.currentMrn);
    this.renderAnnotations();
    this.drawChart();
  }

  async downloadReview() {
    const button = byId("downloadButton");
    const originalContent = button.innerHTML;
    button.disabled = true;
    button.textContent = "Preparing ZIP…";
    await nextFrame();
    try {
      const sorted = [...this.annotations].sort((a, b) => a.MRN.localeCompare(b.MRN, undefined, { numeric: true }) || a.Time - b.Time);
      const entries = [{ name: "pdet_annotated_points.csv", data: annotationsToCsv(sorted) }];
      for (const [mrn, trace] of this.traces) {
        const folder = this.unsureMrns.has(mrn) ? "flagged_tracings" : "sure_tracings";
        const safeFilename = String(trace.filename || `${mrn}.csv`).split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, "_");
        const data = trace.originalFile
          ? new Uint8Array(await trace.originalFile.arrayBuffer())
          : new TextEncoder().encode("Time,Pdet\r\n" + [...trace.time].map((time, index) => `${time},${trace.pdet[index]}`).join("\r\n"));
        entries.push({ name: `${folder}/${safeFilename}`, data });
      }
      const zip = createZip(entries);
      const blob = new Blob([zip], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "tracing_review_export.zip";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const flaggedCount = [...this.traces.keys()].filter((mrn) => this.unsureMrns.has(mrn)).length;
      this.showMessage(`Exported ${this.traces.size - flaggedCount} sure and ${flaggedCount} flagged tracing(s), plus ${sorted.length} annotated point(s).`);
    } catch (error) {
      this.showMessage(`Could not create the review ZIP: ${error.message}`, true);
    } finally {
      button.disabled = false;
      button.innerHTML = originalContent;
    }
  }

  clearReview() {
    if (!window.confirm("Clear all loaded tracings, permission times, and annotations?")) return;
    window.location.reload();
  }

  showMessage(message, isError = false) {
    const box = byId("workspaceMessage");
    box.textContent = message;
    box.classList.toggle("error-message", isError);
    box.hidden = false;
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => { box.hidden = true; }, 7000);
  }

  resizeCanvas() {
    const bounds = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * ratio));
    const height = Math.max(1, Math.round(bounds.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
      this.drawChart();
    }
  }

  resetView() {
    const trace = this.traces.get(this.currentMrn);
    this.view = trace ? { start: trace.time[0], end: trace.time[trace.time.length - 1] } : null;
  }

  chartGeometry() {
    const bounds = this.canvas.getBoundingClientRect();
    return { width: bounds.width, height: bounds.height, left: 56, right: 18, top: 18, bottom: 34 };
  }

  xToPixel(time, geometry) {
    return geometry.left + (time - this.view.start) / (this.view.end - this.view.start) * (geometry.width - geometry.left - geometry.right);
  }

  pixelToTime(pixel, geometry) {
    return this.view.start + (pixel - geometry.left) / (geometry.width - geometry.left - geometry.right) * (this.view.end - this.view.start);
  }

  yToPixel(value, geometry) {
    const { minimum, maximum } = this.yAxis;
    return geometry.top + (maximum - value) / (maximum - minimum) * (geometry.height - geometry.top - geometry.bottom);
  }

  drawChart() {
    if (!this.currentResult || !this.view || !this.context) return;
    const context = this.context;
    const geometry = this.chartGeometry();
    const plotWidth = geometry.width - geometry.left - geometry.right;
    const plotHeight = geometry.height - geometry.top - geometry.bottom;
    context.clearRect(0, 0, geometry.width, geometry.height);
    context.save();
    context.font = "9px Inter, sans-serif";
    context.lineWidth = 1;

    context.strokeStyle = "#e9ece9";
    context.fillStyle = "#7d8983";
    context.textAlign = "right";
    context.textBaseline = "middle";
    const yTickCount = 5;
    const ySpan = this.yAxis.maximum - this.yAxis.minimum;
    const yDecimals = ySpan < 5 ? 2 : ySpan < 20 ? 1 : 0;
    for (let index = 0; index <= yTickCount; index += 1) {
      const value = this.yAxis.minimum + index / yTickCount * ySpan;
      const y = this.yToPixel(value, geometry);
      context.beginPath();
      context.moveTo(geometry.left, y);
      context.lineTo(geometry.width - geometry.right, y);
      context.stroke();
      context.fillText(value.toFixed(yDecimals), geometry.left - 9, y);
    }
    context.textAlign = "center";
    context.textBaseline = "top";
    const tickCount = Math.max(3, Math.min(8, Math.floor(plotWidth / 110)));
    for (let index = 0; index <= tickCount; index += 1) {
      const time = this.view.start + index / tickCount * (this.view.end - this.view.start);
      const x = this.xToPixel(time, geometry);
      context.beginPath();
      context.moveTo(x, geometry.top);
      context.lineTo(x, geometry.height - geometry.bottom);
      context.stroke();
      context.fillStyle = "#7d8983";
      context.fillText(time.toFixed(this.view.end - this.view.start < 30 ? 1 : 0), x, geometry.height - geometry.bottom + 9);
    }

    context.beginPath();
    context.rect(geometry.left, geometry.top, plotWidth, plotHeight);
    context.clip();
    if (byId("rawToggle").checked) this.drawSignal(this.currentResult.signal, "#b8bfbb", 0.75, geometry);
    this.drawSignal(this.currentResult.denoised, "#17251f", 1.45, geometry);

    const permission = this.permissionByMrn.get(this.currentMrn);
    if (Number.isFinite(permission) && permission >= this.view.start && permission <= this.view.end) {
      const x = this.xToPixel(permission, geometry);
      context.save();
      context.strokeStyle = "#17815c";
      context.lineWidth = 1.2;
      context.setLineDash([5, 5]);
      context.beginPath();
      context.moveTo(x, geometry.top);
      context.lineTo(x, geometry.height - geometry.bottom);
      context.stroke();
      context.restore();
      context.fillStyle = "#176d50";
      context.font = "700 9px Inter, sans-serif";
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(`Permission ${formatClock(permission)}`, x + 5, geometry.top + 6);
    }

    this.patientAnnotations().forEach(({ point }, index) => {
      const x = this.xToPixel(Number(point.Time), geometry);
      const y = this.yToPixel(Number(point.Pdet), geometry);
      if (x < geometry.left || x > geometry.width - geometry.right) return;
      context.fillStyle = "rgba(214, 75, 50, 0.2)";
      context.beginPath();
      context.arc(x, y, 11, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "#d64b32";
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, 7, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.fillStyle = "white";
      context.font = "800 8px Inter, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(index + 1), x, y + 0.5);
    });
    context.restore();
  }

  drawSignal(values, strokeStyle, lineWidth, geometry) {
    const context = this.context;
    const time = this.currentResult.time;
    let startIndex = Math.max(0, nearestIndex(time, this.view.start) - 1);
    let endIndex = Math.min(time.length - 1, nearestIndex(time, this.view.end) + 1);
    const visibleCount = endIndex - startIndex + 1;
    const plotWidth = geometry.width - geometry.left - geometry.right;
    const stride = Math.max(1, Math.floor(visibleCount / Math.max(plotWidth * 2, 1)));
    context.strokeStyle = strokeStyle;
    context.lineWidth = lineWidth;
    context.beginPath();
    let started = false;
    for (let index = startIndex; index <= endIndex; index += stride) {
      const value = values[index];
      if (!Number.isFinite(value)) { started = false; continue; }
      const x = this.xToPixel(time[index], geometry);
      const y = this.yToPixel(value, geometry);
      if (started) context.lineTo(x, y);
      else { context.moveTo(x, y); started = true; }
    }
    if ((endIndex - startIndex) % stride !== 0) context.lineTo(this.xToPixel(time[endIndex], geometry), this.yToPixel(values[endIndex], geometry));
    context.stroke();
  }

  pointerCoordinates(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  insidePlot(point, geometry = this.chartGeometry()) {
    return point.x >= geometry.left && point.x <= geometry.width - geometry.right && point.y >= geometry.top && point.y <= geometry.height - geometry.bottom;
  }

  onPointerDown(event) {
    const point = this.pointerCoordinates(event);
    if (!this.insidePlot(point)) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.pointerState = { x: point.x, start: this.view.start, end: this.view.end, moved: false };
    byId("chartTooltip").hidden = true;
  }

  onPointerMove(event) {
    const point = this.pointerCoordinates(event);
    if (this.pointerState) {
      const delta = point.x - this.pointerState.x;
      if (Math.abs(delta) > 3) this.pointerState.moved = true;
      if (this.pointerState.moved) {
        const geometry = this.chartGeometry();
        const secondsPerPixel = (this.pointerState.end - this.pointerState.start) / (geometry.width - geometry.left - geometry.right);
        this.setView(this.pointerState.start - delta * secondsPerPixel, this.pointerState.end - delta * secondsPerPixel);
        this.drawChart();
      }
      return;
    }
    if (!this.currentResult || !this.insidePlot(point)) {
      byId("chartTooltip").hidden = true;
      return;
    }
    const time = this.pixelToTime(point.x, this.chartGeometry());
    const index = nearestIndex(this.currentResult.time, time);
    const tooltip = byId("chartTooltip");
    tooltip.innerHTML = `<strong>${this.currentResult.time[index].toFixed(1)} s</strong> · Pdet ${this.currentResult.denoised[index].toFixed(2)}`;
    tooltip.style.left = `${point.x}px`;
    tooltip.style.top = `${Math.max(point.y, 45)}px`;
    tooltip.hidden = false;
  }

  onPointerUp(event) {
    if (!this.pointerState) return;
    const point = this.pointerCoordinates(event);
    const wasMoved = this.pointerState.moved;
    this.pointerState = null;
    if (!wasMoved && this.insidePlot(point)) {
      const time = this.pixelToTime(point.x, this.chartGeometry());
      byId("annotationTimeInput").value = time.toFixed(1);
      this.addPoint(time, byId("annotationNoteInput").value);
    }
  }

  onWheel(event) {
    if (!this.currentResult) return;
    event.preventDefault();
    const point = this.pointerCoordinates(event);
    if (!this.insidePlot(point)) return;
    const geometry = this.chartGeometry();
    const anchor = this.pixelToTime(point.x, geometry);
    const factor = Math.exp(Math.max(-1, Math.min(1, event.deltaY * 0.0015)));
    const start = anchor - (anchor - this.view.start) * factor;
    const end = anchor + (this.view.end - anchor) * factor;
    this.setView(start, end);
    this.drawChart();
  }

  setView(start, end) {
    const trace = this.traces.get(this.currentMrn);
    const fullStart = trace.time[0];
    const fullEnd = trace.time[trace.time.length - 1];
    const fullSpan = fullEnd - fullStart;
    const minimumSpan = Math.min(2, fullSpan);
    let span = Math.max(minimumSpan, Math.min(fullSpan, end - start));
    let nextStart = start;
    if (nextStart < fullStart) nextStart = fullStart;
    if (nextStart + span > fullEnd) nextStart = fullEnd - span;
    this.view = { start: nextStart, end: nextStart + span };
  }
}

new TracingAnnotatorApp();
