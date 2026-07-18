export const DEFAULT_CUTOFF_HZ = 0.01;
export const DEFAULT_TRANSITION_HZ = 0.1;
export const PEAK_SNAP_WINDOW_S = 5;

const clean = (value) => String(value ?? "").replace(/^\uFEFF/, "").trim();
const normalized = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const numericValue = (value) => {
  const text = clean(value);
  return text && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : Number.NaN;
};

export function toSeconds(value) {
  const text = clean(value);
  if (!text || text.toLowerCase() === "nan") return Number.NaN;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);

  const parts = text.split(":");
  if (parts.length === 2 && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part.trim()))) {
    return Number(parts[0]) * 60 + Number(parts[1]);
  }
  if (parts.length === 3 && parts.every((part) => /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(part.trim()))) {
    return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
  }
  return Number.NaN;
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)} sec`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  return hours ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`;
}

export function parseDelimited(text, delimiter = null) {
  const source = String(text ?? "");
  const detected = delimiter || detectDelimiter(source);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === detected) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(text) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim()).slice(0, 12);
  const candidates = ["\t", ",", ";", "|"];
  let best = ",";
  let bestScore = -1;

  for (const delimiter of candidates) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter));
    const positive = counts.filter((count) => count > 0);
    if (!positive.length) continue;
    const frequency = new Map();
    for (const count of positive) frequency.set(count, (frequency.get(count) || 0) + 1);
    const modeFrequency = Math.max(...frequency.values());
    const typical = Math.max(...[...frequency.entries()].filter(([, count]) => count === modeFrequency).map(([value]) => value));
    const score = modeFrequency * 100 + typical;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

function countOutsideQuotes(line, delimiter) {
  let quoted = false;
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') i += 1;
      else quoted = !quoted;
    } else if (!quoted && line[i] === delimiter) count += 1;
  }
  return count;
}

function tracingHeaderIndex(rows) {
  const searchLimit = Math.min(rows.length, 40);
  for (let index = 0; index < searchLimit; index += 1) {
    const headers = rows[index].map(normalized);
    const hasTime = headers.some((header) => header === "time" || header === "time s" || header === "seconds");
    const hasPressure = headers.some((header) => ["pdet", "p ves", "pves", "p abd", "pabd"].includes(header));
    if (hasTime && hasPressure) return index;
  }
  return -1;
}

function columnIndex(headers, aliases) {
  const normalizedHeaders = headers.map(normalized);
  return normalizedHeaders.findIndex((header) => aliases.includes(header));
}

export function mrnFromFilename(filename) {
  const stem = String(filename).replace(/\.[^.]+$/, "");
  const match = stem.match(/\d{3,}/);
  return match ? match[0].replace(/^0+(?=\d)/, "") : clean(stem);
}

export function normalizeMrn(value) {
  const text = clean(value).replace(/\.0+$/, "");
  if (!text) return "";
  const digits = text.replace(/\s/g, "");
  return /^\d+$/.test(digits) ? digits.replace(/^0+(?=\d)/, "") : text;
}

export function parseTracingText(text, filename = "tracing.csv") {
  const rows = parseDelimited(text);
  const headerIndex = tracingHeaderIndex(rows);
  if (headerIndex < 0) {
    throw new Error("Could not find Time and Pdet (or Pves/Pabd) columns.");
  }

  const headers = rows[headerIndex].map(clean);
  const timeIndex = columnIndex(headers, ["time", "time s", "seconds"]);
  const pdetIndex = columnIndex(headers, ["pdet", "p det"]);
  const pvesIndex = columnIndex(headers, ["pves", "p ves"]);
  const pabdIndex = columnIndex(headers, ["pabd", "p abd"]);
  if (pdetIndex < 0 && (pvesIndex < 0 || pabdIndex < 0)) {
    throw new Error("Pdet is missing and could not be calculated because Pves/Pabd are unavailable.");
  }

  const samples = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const time = toSeconds(row[timeIndex]);
    const directPdet = pdetIndex >= 0 ? numericValue(row[pdetIndex]) : Number.NaN;
    const pves = pvesIndex >= 0 ? numericValue(row[pvesIndex]) : Number.NaN;
    const pabd = pabdIndex >= 0 ? numericValue(row[pabdIndex]) : Number.NaN;
    const pdet = pdetIndex >= 0 ? directPdet : pves - pabd;
    if (Number.isFinite(time)) samples.push({ time, pdet });
  }
  samples.sort((a, b) => a.time - b.time);
  const unique = samples.filter((sample, index) => index === 0 || sample.time !== samples[index - 1].time);
  if (unique.length < 4) throw new Error("The tracing must contain at least four valid time/Pdet samples.");
  if (unique.length > 500_000) throw new Error("This browser version supports up to 500,000 valid samples per tracing.");

  const finiteIndices = unique.map((sample, index) => Number.isFinite(sample.pdet) ? index : -1).filter((index) => index >= 0);
  if (!finiteIndices.length) throw new Error("The tracing does not contain any numeric Pdet values.");
  const firstFinite = finiteIndices[0];
  const lastFinite = finiteIndices[finiteIndices.length - 1];
  for (let index = 0; index < firstFinite; index += 1) unique[index].pdet = unique[firstFinite].pdet;
  for (let index = lastFinite + 1; index < unique.length; index += 1) unique[index].pdet = unique[lastFinite].pdet;
  for (let runStart = firstFinite; runStart < lastFinite;) {
    if (Number.isFinite(unique[runStart + 1].pdet)) {
      runStart += 1;
      continue;
    }
    let runEnd = runStart + 1;
    while (runEnd <= lastFinite && !Number.isFinite(unique[runEnd].pdet)) runEnd += 1;
    const left = unique[runStart];
    const right = unique[runEnd];
    for (let index = runStart + 1; index < runEnd; index += 1) {
      const fraction = (unique[index].time - left.time) / (right.time - left.time);
      unique[index].pdet = left.pdet + fraction * (right.pdet - left.pdet);
    }
    runStart = runEnd;
  }

  return {
    mrn: mrnFromFilename(filename),
    filename,
    time: Float64Array.from(unique, (sample) => sample.time),
    pdet: Float64Array.from(unique, (sample) => sample.pdet),
    pdetSource: pdetIndex >= 0 ? "Pdet" : "Pves − Pabd",
  };
}

export function parsePermissionText(text) {
  const rows = parseDelimited(text);
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < Math.min(rows.length, 50); index += 1) {
    const candidate = rows[index].map(normalized);
    if (candidate.some((header) => header === "mrn" || header.endsWith(" mrn"))) {
      headerIndex = index;
      headers = candidate;
      break;
    }
  }
  if (headerIndex < 0) throw new Error("Could not find an MRN column in the permission file.");

  const mrnColumns = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => header === "mrn" || header.endsWith(" mrn"));
  const pairs = [];
  for (const mrnColumn of mrnColumns) {
    const candidates = headers
      .map((header, index) => ({ header, index, distance: Math.abs(index - mrnColumn.index) }))
      .filter(({ header, index, distance }) => index !== mrnColumn.index && distance <= 3 && (header.includes("permission") && header.includes("void") || header === "time" || header === "time s"))
      .sort((a, b) => {
        const aPreferred = a.index > mrnColumn.index ? 0 : 1;
        const bPreferred = b.index > mrnColumn.index ? 0 : 1;
        return aPreferred - bPreferred || a.distance - b.distance;
      });
    if (candidates.length) pairs.push([mrnColumn.index, candidates[0].index]);
  }
  if (!pairs.length) throw new Error("Could not match an MRN column to a permission-to-void time column.");

  const permissionByMrn = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    for (const [mrnIndex, timeIndex] of pairs) {
      const mrn = normalizeMrn(row[mrnIndex]);
      const seconds = toSeconds(row[timeIndex]);
      if (mrn && Number.isFinite(seconds)) permissionByMrn.set(mrn, seconds);
    }
  }
  if (!permissionByMrn.size) throw new Error("No valid MRN/time pairs were found in the permission file.");
  return permissionByMrn;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function transformRadix2(real, imag, inverse = false) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / length;
    const wLengthReal = Math.cos(angle);
    const wLengthImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let wReal = 1;
      let wImag = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * wReal - imag[odd] * wImag;
        const oddImag = real[odd] * wImag + imag[odd] * wReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = wReal * wLengthReal - wImag * wLengthImag;
        wImag = wReal * wLengthImag + wImag * wLengthReal;
        wReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function transformBluestein(inputReal, inputImag) {
  const n = inputReal.length;
  let m = 1;
  while (m < n * 2 - 1) m <<= 1;
  const aReal = new Float64Array(m);
  const aImag = new Float64Array(m);
  const bReal = new Float64Array(m);
  const bImag = new Float64Array(m);

  for (let i = 0; i < n; i += 1) {
    const angle = Math.PI * ((i * i) % (n * 2)) / n;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    aReal[i] = inputReal[i] * cos + inputImag[i] * sin;
    aImag[i] = -inputReal[i] * sin + inputImag[i] * cos;
    bReal[i] = cos;
    bImag[i] = sin;
    if (i !== 0) {
      bReal[m - i] = cos;
      bImag[m - i] = sin;
    }
  }
  transformRadix2(aReal, aImag);
  transformRadix2(bReal, bImag);
  for (let i = 0; i < m; i += 1) {
    const real = aReal[i] * bReal[i] - aImag[i] * bImag[i];
    const imag = aReal[i] * bImag[i] + aImag[i] * bReal[i];
    aReal[i] = real;
    aImag[i] = imag;
  }
  transformRadix2(aReal, aImag, true);

  const outputReal = new Float64Array(n);
  const outputImag = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const angle = Math.PI * ((i * i) % (n * 2)) / n;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    outputReal[i] = aReal[i] * cos + aImag[i] * sin;
    outputImag[i] = -aReal[i] * sin + aImag[i] * cos;
  }
  return { real: outputReal, imag: outputImag };
}

function fft(real, imag = new Float64Array(real.length)) {
  const n = real.length;
  if (n > 0 && (n & (n - 1)) === 0) {
    const outputReal = Float64Array.from(real);
    const outputImag = Float64Array.from(imag);
    transformRadix2(outputReal, outputImag);
    return { real: outputReal, imag: outputImag };
  }
  return transformBluestein(real, imag);
}

function ifft(real, imag) {
  const conjugateImag = Float64Array.from(imag, (value) => -value);
  const result = fft(real, conjugateImag);
  for (let i = 0; i < result.real.length; i += 1) {
    result.real[i] /= result.real.length;
    result.imag[i] /= -result.imag.length;
  }
  return result;
}

function interpolateAt(sourceTime, sourceValue, targetTime) {
  const output = new Float64Array(targetTime.length);
  let sourceIndex = 0;
  for (let i = 0; i < targetTime.length; i += 1) {
    const target = targetTime[i];
    while (sourceIndex < sourceTime.length - 2 && sourceTime[sourceIndex + 1] < target) sourceIndex += 1;
    const leftTime = sourceTime[sourceIndex];
    const rightTime = sourceTime[Math.min(sourceIndex + 1, sourceTime.length - 1)];
    const fraction = rightTime === leftTime ? 0 : Math.max(0, Math.min(1, (target - leftTime) / (rightTime - leftTime)));
    output[i] = sourceValue[sourceIndex] + fraction * (sourceValue[Math.min(sourceIndex + 1, sourceValue.length - 1)] - sourceValue[sourceIndex]);
  }
  return output;
}

export function fftLowpassDenoise(time, signal, cutoffHz = DEFAULT_CUTOFF_HZ, transitionHz = DEFAULT_TRANSITION_HZ) {
  if (time.length < 4 || signal.length !== time.length) throw new Error("Need at least four paired samples for FFT denoising.");
  const differences = [];
  for (let i = 1; i < time.length; i += 1) {
    const difference = time[i] - time[i - 1];
    if (Number.isFinite(difference) && difference > 0) differences.push(difference);
  }
  const dt = median(differences);
  if (!Number.isFinite(dt) || dt <= 0) throw new Error("Time values must increase.");
  const uniformLength = Math.floor((time[time.length - 1] - time[0]) / dt + 0.5) + 1;
  if (uniformLength > 1_000_000) throw new Error("The resampled tracing would exceed 1,000,000 points.");
  const uniformTime = Float64Array.from({ length: uniformLength }, (_, index) => time[0] + index * dt);
  const uniformSignal = interpolateAt(time, signal, uniformTime);
  const mean = uniformSignal.reduce((sum, value) => sum + value, 0) / uniformLength;
  const centered = Float64Array.from(uniformSignal, (value) => value - mean);
  const spectrum = fft(centered);
  const transition = Math.max(0, Number(transitionHz));
  const cutoff = Math.max(0, Number(cutoffHz));

  for (let index = 0; index < uniformLength; index += 1) {
    const mirroredIndex = index <= uniformLength / 2 ? index : uniformLength - index;
    const frequency = mirroredIndex / (uniformLength * dt);
    let weight = 1;
    if (transition === 0) {
      if (frequency > cutoff) weight = 0;
    } else if (frequency >= cutoff + transition) {
      weight = 0;
    } else if (frequency > cutoff) {
      weight = 0.5 * (1 + Math.cos(Math.PI * (frequency - cutoff) / transition));
    }
    spectrum.real[index] *= weight;
    spectrum.imag[index] *= weight;
  }
  const inverse = ifft(spectrum.real, spectrum.imag);
  const denoisedUniform = Float64Array.from(inverse.real, (value) => value + mean);
  const denoised = interpolateAt(uniformTime, denoisedUniform, time);
  return { time, signal, denoised, dt, nyquistHz: 0.5 / dt };
}

export function nearestIndex(sortedValues, target) {
  let low = 0;
  let high = sortedValues.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sortedValues[middle] < target) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(sortedValues[low - 1] - target) <= Math.abs(sortedValues[low] - target)) return low - 1;
  return low;
}

export function snapToPeak(result, requestedTime, windowSeconds = PEAK_SNAP_WINDOW_S) {
  const centerIndex = nearestIndex(result.time, requestedTime);
  let bestIndex = centerIndex;
  let bestValue = result.denoised[centerIndex];
  for (let index = centerIndex; index >= 0 && result.time[index] >= requestedTime - windowSeconds; index -= 1) {
    if (result.denoised[index] > bestValue) {
      bestValue = result.denoised[index];
      bestIndex = index;
    }
  }
  for (let index = centerIndex + 1; index < result.time.length && result.time[index] <= requestedTime + windowSeconds; index += 1) {
    if (result.denoised[index] > bestValue) {
      bestValue = result.denoised[index];
      bestIndex = index;
    }
  }
  return { time: result.time[bestIndex], pdet: result.denoised[bestIndex], index: bestIndex };
}

export function annotationsToCsv(points) {
  const columns = ["MRN", "Time", "Pdet", "FFT_Cutoff_Hz", "FFT_Transition_Hz", "Note"];
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = points.map((point) => columns.map((column) => escape(point[column])).join(","));
  return [columns.join(","), ...rows].join("\r\n");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function zipDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function concatenateBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function createZip(entries, modifiedAt = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = zipDateTime(modifiedAt);
  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(String(entry.name).replace(/^\/+/, ""));
    const data = typeof entry.data === "string"
      ? encoder.encode(entry.data)
      : entry.data instanceof Uint8Array ? entry.data : Uint8Array.from(entry.data);
    if (!nameBytes.length || nameBytes.length > 0xffff) throw new Error("ZIP entry names must contain 1–65,535 UTF-8 bytes.");
    const checksum = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, time);
    writeUint16(localView, 12, date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(nameBytes, 30);
    localChunks.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, time);
    writeUint16(centralView, 14, date);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const localData = concatenateBytes(localChunks);
  const centralData = concatenateBytes(centralChunks);
  if (entries.length > 0xffff || localData.length + centralData.length > 0xffffffff) {
    throw new Error("The review is too large for a standard ZIP file.");
  }
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralData.length);
  writeUint32(endView, 16, localData.length);
  writeUint16(endView, 20, 0);
  return concatenateBytes([localData, centralData, endRecord]);
}
