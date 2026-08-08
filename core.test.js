import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  annotationsToCsv,
  createZip,
  fftLowpassDenoise,
  parsePermissionText,
  parseTracingText,
  snapToPeak,
  toSeconds,
} from "./core.js";

test("parses numeric and clock times", () => {
  assert.equal(toSeconds("12.5"), 12.5);
  assert.equal(toSeconds("10:18.4"), 618.4);
  assert.equal(toSeconds("1:02:03.5"), 3723.5);
  assert.ok(Number.isNaN(toSeconds("not a time")));
});

test("loads the supplied tab-separated tracing", () => {
  const text = readFileSync(new URL("3514620.csv", import.meta.url), "utf8");
  const tracing = parseTracingText(text, "3514620.csv");
  assert.equal(tracing.mrn, "3514620");
  assert.equal(tracing.time.length, 19261);
  assert.equal(tracing.time[0], 0);
  assert.equal(tracing.time.at(-1), 1926);
  assert.equal(tracing.pdetSource, "Pdet");
});

test("derives Pdet from Pves and Pabd in comma-separated input", () => {
  const tracing = parseTracingText("Time,Pves,Pabd,Flow,Volume\n0,12,8,1,0\n1,14,9,2.5,3\n2,15,10,-1,4\n3,18,11,0,8\n", "MRN-001234.csv");
  assert.equal(tracing.mrn, "1234");
  assert.deepEqual([...tracing.pdet], [4, 5, 5, 7]);
  assert.deepEqual([...tracing.pves], [12, 14, 15, 18]);
  assert.deepEqual([...tracing.pabd], [8, 9, 10, 11]);
  assert.deepEqual([...tracing.flow], [1, 2.5, -1, 0]);
  assert.deepEqual([...tracing.volume], [0, 3, 4, 8]);
  assert.equal(tracing.pdetSource, "Pves − Pabd");
});

test("omits optional channel arrays when their columns are unavailable", () => {
  const tracing = parseTracingText("Time,Pdet\n0,1\n1,2\n2,3\n3,4\n", "123.csv");
  assert.equal(tracing.pves, null);
  assert.equal(tracing.pabd, null);
  assert.equal(tracing.flow, null);
  assert.equal(tracing.volume, null);
});

test("recognizes channel headers that include units", () => {
  const tracing = parseTracingText("Time (s),Pdet (cmH2O),Pves (cmH2O),Pabd (cmH2O),Flow (mL/s),Volume (mL)\n0,1,10,9,2,0\n1,2,11,9,3,2\n2,3,13,10,4,5\n3,4,15,11,2,7\n", "123.csv");
  assert.deepEqual([...tracing.flow], [2, 3, 4, 2]);
  assert.deepEqual([...tracing.volume], [0, 2, 5, 7]);
});

test("interpolates blank Pdet values like the notebook", () => {
  const tracing = parseTracingText("Time,Pdet\n0,\n1,4\n2,\n3,8\n4,\n", "5678.csv");
  assert.deepEqual([...tracing.pdet], [4, 4, 6, 8, 8]);
});

test("loads all valid permissions from the supplied wide spreadsheet export", () => {
  const text = readFileSync(new URL("Urodynamics DO 2 - Sheet1.csv", import.meta.url), "utf8");
  const permissions = parsePermissionText(text);
  assert.equal(permissions.size, 58);
  assert.equal(permissions.get("3070984"), 618.4);
  assert.equal(permissions.get("3701678"), 960.9);
});

test("browser FFT matches the notebook FFT output", () => {
  const text = readFileSync(new URL("3514620.csv", import.meta.url), "utf8");
  const tracing = parseTracingText(text, "3514620.csv");
  const result = fftLowpassDenoise(tracing.time, tracing.pdet, 0.01, 0.1);
  const notebookValues = [3.954574894161098, 3.8991544866948575, 3.8445184858035932, 3.790686590864846, 3.7376775010900416];
  notebookValues.forEach((expected, index) => assert.ok(Math.abs(result.denoised[index] - expected) < 1e-9));
  const peak = snapToPeak(result, 100, 5);
  assert.equal(peak.time, 103.7);
});

test("exports notebook-compatible annotation columns and escapes notes", () => {
  const csv = annotationsToCsv([{ MRN: "1234", Time: 10.2, Pdet: 21.5, FFT_Cutoff_Hz: 0.01, FFT_Transition_Hz: 0.1, Note: "review, later" }]);
  assert.equal(csv, "MRN,Time,Pdet,FFT_Cutoff_Hz,FFT_Transition_Hz,Note\r\n1234,10.2,21.5,0.01,0.1,\"review, later\"");
});

test("creates a standard ZIP containing nested review folders", () => {
  const zip = createZip([
    { name: "pdet_annotated_points.csv", data: "MRN,Time\r\n1234,10" },
    { name: "sure_tracings/1234.csv", data: "Time\tPdet\r\n0\t1" },
    { name: "flagged_tracings/5678.csv", data: "Time\tPdet\r\n0\t2" },
  ], new Date(2026, 0, 2, 3, 4, 6));
  const binaryText = new TextDecoder("latin1").decode(zip);
  assert.equal(new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(0, true), 0x04034b50);
  assert.ok(binaryText.includes("pdet_annotated_points.csv"));
  assert.ok(binaryText.includes("sure_tracings/1234.csv"));
  assert.ok(binaryText.includes("flagged_tracings/5678.csv"));
  assert.equal(new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint32(zip.length - 22, true), 0x06054b50);
});
