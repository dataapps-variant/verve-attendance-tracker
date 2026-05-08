/**
 * Team Monthly Attendance Pivot Excel export.
 *
 * Builds a 2-sheet workbook matching the "Attendance Report - Team Sales"
 * template: a raw "Data" sheet and a "Pivot" sheet where rows=members,
 * columns=dates, cells=hours, with color coding:
 *   - Orange  : 0 < hours < EARLY_LOGOUT_MAX_HOURS (early logout)
 *   - Yellow  : hours > OVERTIME_MIN_HOURS (overtime)
 *   - Red     : person's grand total < target hours for the month
 *
 * Input is the JSON response from /teams/<id>/report/monthly.
 */
import XLSX from 'xlsx-js-style';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Thresholds (mirror the Team Sales template convention)
const EARLY_LOGOUT_MAX_HOURS = 7.75; // 0 < h < 7h45m -> Orange
const OVERTIME_MIN_HOURS = 9.5;      // h > 9h30m -> Yellow
const DAILY_TARGET_HOURS = 8;        // used for red threshold on row totals

// ── Style presets ────────────────────────────────────────
const BORDER_THIN = {
  top: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
  bottom: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
  left: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
  right: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
};

const HEADER_STYLE = {
  font: { bold: true, color: { rgb: 'FFFFFFFF' }, sz: 11 },
  fill: { patternType: 'solid', fgColor: { rgb: 'FF8093B3' } },
  alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
  border: BORDER_THIN,
};

const NAME_CELL_STYLE = {
  font: { bold: true, color: { rgb: 'FF1E293B' } },
  fill: { patternType: 'solid', fgColor: { rgb: 'FFF4F6F8' } },
  alignment: { horizontal: 'left', vertical: 'center' },
  border: BORDER_THIN,
};

const NUM_CELL_STYLE = {
  alignment: { horizontal: 'center', vertical: 'center' },
  border: BORDER_THIN,
  numFmt: '0.00',
};

const BLANK_CELL_STYLE = {
  border: BORDER_THIN,
};

const ORANGE_STYLE = {
  ...NUM_CELL_STYLE,
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFF9900' } },
  font: { bold: true, color: { rgb: 'FF1E293B' } },
};

const YELLOW_STYLE = {
  ...NUM_CELL_STYLE,
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF00' } },
  font: { bold: true, color: { rgb: 'FF1E293B' } },
};

const RED_STYLE = {
  ...NUM_CELL_STYLE,
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFF6B6B' } },
  font: { bold: true, color: { rgb: 'FFFFFFFF' } },
};

const GRAND_TOTAL_STYLE = {
  font: { bold: true, color: { rgb: 'FF1E293B' } },
  fill: { patternType: 'solid', fgColor: { rgb: 'FFDFE4EC' } },
  alignment: { horizontal: 'center', vertical: 'center' },
  border: BORDER_THIN,
  numFmt: '0.00',
};

const DOW_LABEL_STYLE = {
  font: { italic: true, color: { rgb: 'FF64748B' }, sz: 9 },
  alignment: { horizontal: 'center' },
};

const HOLIDAY_LABEL_STYLE = {
  font: { bold: true, color: { rgb: 'FF4338CA' }, sz: 9 },
  alignment: { horizontal: 'center' },
  fill: { patternType: 'solid', fgColor: { rgb: 'FFE0E7FF' } },
};

const HOLIDAY_CELL_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'FFE0E7FF' } },
  font: { bold: true, color: { rgb: 'FF4338CA' } },
  alignment: { horizontal: 'center', vertical: 'center' },
  border: {
    top: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
    bottom: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
    left: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
    right: { style: 'thin', color: { rgb: 'FFBFC4CC' } },
  },
};

const NOTE_LABEL_STYLE = {
  font: { bold: true, color: { rgb: 'FF475569' } },
  alignment: { horizontal: 'left' },
};

const NOTE_VALUE_STYLE = {
  font: { color: { rgb: 'FF1E293B' } },
  alignment: { horizontal: 'left' },
};

const LEGEND_ORANGE_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFF9900' } },
  font: { bold: true, color: { rgb: 'FF1E293B' } },
  alignment: { horizontal: 'center' },
};
const LEGEND_YELLOW_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF00' } },
  font: { bold: true, color: { rgb: 'FF1E293B' } },
  alignment: { horizontal: 'center' },
};
const LEGEND_RED_STYLE = {
  fill: { patternType: 'solid', fgColor: { rgb: 'FFFF6B6B' } },
  font: { bold: true, color: { rgb: 'FFFFFFFF' } },
  alignment: { horizontal: 'center' },
};

// ── Helpers ──────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

function dateFromStr(ymd) {
  // Parse 'YYYY-MM-DD' as local date (avoid TZ shift)
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dowShort(ymd) {
  const dow = dateFromStr(ymd).getDay();
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow];
}

function isWeekend(ymd) {
  const dow = dateFromStr(ymd).getDay();
  return dow === 0 || dow === 6;
}

function setCell(ws, r, c, value, style) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = { v: value };
  if (value instanceof Date) {
    cell.t = 'd';
    cell.z = 'dd-mmm';
  } else if (typeof value === 'number') {
    cell.t = 'n';
  } else if (typeof value === 'boolean') {
    cell.t = 'b';
  } else {
    cell.t = 's';
    cell.v = value == null ? '' : String(value);
  }
  if (style) cell.s = style;
  ws[addr] = cell;
}

function expandRange(ws, r, c) {
  const ref = ws['!ref'];
  const bounds = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
  if (r > bounds.e.r) bounds.e.r = r;
  if (c > bounds.e.c) bounds.e.c = c;
  if (r < bounds.s.r) bounds.s.r = r;
  if (c < bounds.s.c) bounds.s.c = c;
  ws['!ref'] = XLSX.utils.encode_range(bounds);
}

function writeCell(ws, r, c, value, style) {
  setCell(ws, r, c, value, style);
  expandRange(ws, r, c);
}

// Bug fix: Helper for correct ordinal suffix (1st, 2nd, 3rd, 4th, 21st, 22nd, etc.)
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── Main export ──────────────────────────────────────────
/**
 * @param {Object} monthlyData  - response from /teams/<id>/report/monthly
 * @param {Object} team         - {team_name, manager_name}
 * @param {number} year
 * @param {number} month (1-12)
 */
export function downloadTeamPivotExcel(monthlyData, team, year, month) {
  const teamName = monthlyData?.team_name || team?.team_name || 'Team';
  const managerName = team?.manager_name || monthlyData?.manager_name || '';
  const dailyData = Array.isArray(monthlyData?.daily_data) ? monthlyData.daily_data : [];

  // Holidays — date -> description
  // Bug fix: Use ?? instead of || to preserve empty string descriptions
  const holidayMap = {};
  (monthlyData?.holidays || []).forEach(h => {
    if (h?.date) holidayMap[h.date] = h.description ?? 'Holiday';
  });

  // ── Build the list of dates (weekdays in month + any date that has data) ──
  const dateSet = new Set();
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad2(month)}-${pad2(d)}`;
    if (!isWeekend(ds)) dateSet.add(ds);
  }
  dailyData.forEach(r => { if (r?.date) dateSet.add(r.date); });
  const dates = Array.from(dateSet).sort();

  // ── Unique participant names ──
  const nameSet = new Set();
  dailyData.forEach(r => { if (r?.name) nameSet.add(r.name); });
  const names = Array.from(nameSet).sort((a, b) => a.localeCompare(b));

  // ── Lookup: name|date -> minutes ──
  const lookup = {};
  dailyData.forEach(r => {
    if (!r?.name || !r?.date) return;
    const mins = Number(r.active_minutes) || 0;
    const isoMins = Number(r.isolation_minutes) || 0;
    const brkMins = Number(r.break_minutes) || 0;
    lookup[`${r.name}|${r.date}`] = {
      minutes: mins,
      hours: mins / 60,
      isolationMinutes: isoMins,
      isolationHours: isoMins / 60,
      breakMinutes: brkMins,
      breakHours: brkMins / 60,
      first: r.first_seen_ist || '',
      last: r.last_seen_ist || '',
    };
  });

  // Count working days (Mon-Fri, minus holidays) in the full month
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${pad2(month)}-${pad2(d)}`;
    if (!isWeekend(ds) && !holidayMap[ds]) workingDays++;
  }
  const holidayCount = Object.keys(holidayMap).length;
  const targetHoursExclBreaks = workingDays * DAILY_TARGET_HOURS;
  const targetHoursInclBreaks = workingDays * 9;

  // ════════════════════════════════════════════════════════
  // SHEET 1 — "Data" (raw rows, one per person per date)
  // ════════════════════════════════════════════════════════
  const dataWs = {};
  const dataHeaders = [
    'Name', 'Login Date', 'Login Time', 'Logout date', 'Logout Time',
    'Total number of minutes', 'Hours', 'Entity', 'Manager Name'
  ];
  dataHeaders.forEach((h, i) => writeCell(dataWs, 0, i, h, HEADER_STYLE));

  const sortedRows = [...dailyData]
    .filter(r => r?.name && r?.date)
    .sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date));

  sortedRows.forEach((r, i) => {
    const row = i + 1;
    const mins = Number(r.active_minutes) || 0;
    const hours = Number((mins / 60).toFixed(4));
    const dateObj = dateFromStr(r.date);
    writeCell(dataWs, row, 0, r.name, { ...NUM_CELL_STYLE, alignment: { horizontal: 'left' } });
    const dateStyle = { ...NUM_CELL_STYLE, numFmt: 'yyyy-mm-dd' };
    writeCell(dataWs, row, 1, dateObj, dateStyle);
    writeCell(dataWs, row, 2, r.first_seen_ist || '', NUM_CELL_STYLE);
    writeCell(dataWs, row, 3, dateObj, dateStyle);
    writeCell(dataWs, row, 4, r.last_seen_ist || '', NUM_CELL_STYLE);
    writeCell(dataWs, row, 5, mins, { ...NUM_CELL_STYLE, numFmt: '0' });
    writeCell(dataWs, row, 6, hours, NUM_CELL_STYLE);
    writeCell(dataWs, row, 7, teamName, { ...NUM_CELL_STYLE, alignment: { horizontal: 'left' } });
    writeCell(dataWs, row, 8, managerName, { ...NUM_CELL_STYLE, alignment: { horizontal: 'left' } });
  });

  dataWs['!cols'] = [
    { wch: 24 }, { wch: 13 }, { wch: 11 }, { wch: 13 }, { wch: 11 },
    { wch: 22 }, { wch: 10 }, { wch: 18 }, { wch: 20 },
  ];

  // ════════════════════════════════════════════════════════
  // SHEET 2 — "Pivot" (rows=names, cols=dates, cells=hours)
  // ════════════════════════════════════════════════════════
  const pivotWs = {};

  // Row 0 — day-of-week / Holiday labels over date columns
  dates.forEach((ds, i) => {
    const dow = dateFromStr(ds).getDay();
    const isHoliday = !!holidayMap[ds];
    if (isHoliday) {
      writeCell(pivotWs, 0, 2 + i, 'Holiday', HOLIDAY_LABEL_STYLE);
    } else if (dow === 0) {
      writeCell(pivotWs, 0, 2 + i, 'Sunday', DOW_LABEL_STYLE);
    } else if (dow === 6) {
      writeCell(pivotWs, 0, 2 + i, 'Saturday', DOW_LABEL_STYLE);
    } else {
      writeCell(pivotWs, 0, 2 + i, '', DOW_LABEL_STYLE);
    }
  });

  // Row 1 — title pair "SUM of Hours | Login Date"
  writeCell(pivotWs, 1, 0, 'SUM of Hours', {
    font: { bold: true, color: { rgb: 'FF64748B' }, sz: 10 },
    alignment: { horizontal: 'left' },
  });
  writeCell(pivotWs, 1, 1, 'Login Date', {
    font: { bold: true, color: { rgb: 'FF64748B' }, sz: 10 },
    alignment: { horizontal: 'left' },
  });

  // Row 2 — column header: Name | (blank) | date1 | date2 | ... | Grand Total
  writeCell(pivotWs, 2, 0, 'Name', HEADER_STYLE);
  writeCell(pivotWs, 2, 1, '', HEADER_STYLE);
  dates.forEach((ds, i) => {
    writeCell(pivotWs, 2, 2 + i, dateFromStr(ds), { ...HEADER_STYLE, numFmt: 'dd-mmm' });
  });
  const grandTotalCol = 2 + dates.length;
  writeCell(pivotWs, 2, grandTotalCol, 'Grand Total', HEADER_STYLE);

  // Rows 3+ — one per member
  const personRowStart = 3;
  const colTotals = new Array(dates.length).fill(0);

  names.forEach((name, nIdx) => {
    const r = personRowStart + nIdx;
    writeCell(pivotWs, r, 0, name, NAME_CELL_STYLE);
    writeCell(pivotWs, r, 1, '', BLANK_CELL_STYLE);

    let personTotal = 0;
    dates.forEach((ds, dIdx) => {
      const entry = lookup[`${name}|${ds}`];
      const col = 2 + dIdx;
      const isHoliday = !!holidayMap[ds];
      if (isHoliday) {
        writeCell(pivotWs, r, col, 'H', HOLIDAY_CELL_STYLE);
        return;
      }
      if (entry && entry.hours > 0) {
        const h = Number(entry.hours.toFixed(2));
        let style = NUM_CELL_STYLE;
        if (entry.hours < EARLY_LOGOUT_MAX_HOURS) style = ORANGE_STYLE;
        else if (entry.hours > OVERTIME_MIN_HOURS) style = YELLOW_STYLE;
        writeCell(pivotWs, r, col, h, style);
        personTotal += entry.hours;
        colTotals[dIdx] += entry.hours;
      } else {
        writeCell(pivotWs, r, col, '', BLANK_CELL_STYLE);
      }
    });

    const totalRounded = Number(personTotal.toFixed(2));
    const totalStyle = personTotal > 0 && personTotal < targetHoursExclBreaks
      ? RED_STYLE
      : GRAND_TOTAL_STYLE;
    writeCell(pivotWs, r, grandTotalCol, totalRounded, totalStyle);
  });

  // Grand Total row
  const grandRow = personRowStart + names.length;
  writeCell(pivotWs, grandRow, 0, 'Grand Total', GRAND_TOTAL_STYLE);
  writeCell(pivotWs, grandRow, 1, '', GRAND_TOTAL_STYLE);
  let grandSum = 0;
  colTotals.forEach((t, i) => {
    const ds = dates[i];
    if (holidayMap[ds]) {
      writeCell(pivotWs, grandRow, 2 + i, 'H', HOLIDAY_CELL_STYLE);
      return;
    }
    const v = Number(t.toFixed(2));
    grandSum += t;
    writeCell(pivotWs, grandRow, 2 + i, v, GRAND_TOTAL_STYLE);
  });
  writeCell(pivotWs, grandRow, grandTotalCol, Number(grandSum.toFixed(2)), GRAND_TOTAL_STYLE);

  // Notes section (2 blank rows below)
  const noteStart = grandRow + 2;
  const monthName = MONTH_NAMES[month - 1];
  const reportPeriod = `1st to ${ordinal(daysInMonth)} ${monthName} ${year}`;

  writeCell(pivotWs, noteStart,     0, 'Note:', NOTE_LABEL_STYLE);
  writeCell(pivotWs, noteStart,     1, 'Report is from', NOTE_LABEL_STYLE);
  writeCell(pivotWs, noteStart,     2, reportPeriod, NOTE_VALUE_STYLE);

  writeCell(pivotWs, noteStart + 1, 1, 'Working day', NOTE_LABEL_STYLE);
  writeCell(pivotWs, noteStart + 1, 2,
    holidayCount > 0 ? `${workingDays} (after ${holidayCount} holiday${holidayCount > 1 ? 's' : ''})` : workingDays,
    NOTE_VALUE_STYLE);

  writeCell(pivotWs, noteStart + 2, 1, 'Hours including breaks', NOTE_LABEL_STYLE);
  writeCell(pivotWs, noteStart + 2, 2, targetHoursInclBreaks, { ...NOTE_VALUE_STYLE, numFmt: '0' });

  writeCell(pivotWs, noteStart + 3, 1, 'Hours excluding breaks', NOTE_LABEL_STYLE);
  writeCell(pivotWs, noteStart + 3, 2, targetHoursExclBreaks, { ...NOTE_VALUE_STYLE, numFmt: '0' });

  writeCell(pivotWs, noteStart + 4, 1, 'Orange', LEGEND_ORANGE_STYLE);
  writeCell(pivotWs, noteStart + 4, 2, `Early Logouts (< ${EARLY_LOGOUT_MAX_HOURS} h)`, NOTE_VALUE_STYLE);

  writeCell(pivotWs, noteStart + 5, 1, 'Yellow', LEGEND_YELLOW_STYLE);
  writeCell(pivotWs, noteStart + 5, 2, `Overtime (> ${OVERTIME_MIN_HOURS} h)`, NOTE_VALUE_STYLE);

  writeCell(pivotWs, noteStart + 6, 1, 'Red', LEGEND_RED_STYLE);
  writeCell(pivotWs, noteStart + 6, 2, `Less than ${targetHoursExclBreaks} hours total`, NOTE_VALUE_STYLE);

  writeCell(pivotWs, noteStart + 7, 1, 'H', HOLIDAY_LABEL_STYLE);
  writeCell(pivotWs, noteStart + 7, 2, 'Holiday (not counted as working day or leave)', NOTE_VALUE_STYLE);

  // Column widths for the pivot
  const pivotCols = [{ wch: 24 }, { wch: 4 }];
  dates.forEach(() => pivotCols.push({ wch: 9 }));
  pivotCols.push({ wch: 12 });
  pivotWs['!cols'] = pivotCols;

  // Freeze the header rows and first column
  // Bug fix: Use correct xlsx-js-style API for freeze panes
  pivotWs['!views'] = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];

  // ════════════════════════════════════════════════════════
  // SHEET 3 — "Isolation" (pivot of isolation hours per person per day)
  // ════════════════════════════════════════════════════════
  const isoWs = {};

  // Row 0 — day-of-week / Holiday labels
  dates.forEach((ds, i) => {
    const dow = dateFromStr(ds).getDay();
    if (holidayMap[ds]) {
      writeCell(isoWs, 0, 2 + i, 'Holiday', HOLIDAY_LABEL_STYLE);
    } else if (dow === 0) {
      writeCell(isoWs, 0, 2 + i, 'Sunday', DOW_LABEL_STYLE);
    } else if (dow === 6) {
      writeCell(isoWs, 0, 2 + i, 'Saturday', DOW_LABEL_STYLE);
    } else {
      writeCell(isoWs, 0, 2 + i, '', DOW_LABEL_STYLE);
    }
  });

  // Row 1 — title pair
  writeCell(isoWs, 1, 0, 'Isolation Hours', {
    font: { bold: true, color: { rgb: 'FF64748B' }, sz: 10 },
    alignment: { horizontal: 'left' },
  });
  writeCell(isoWs, 1, 1, '(alone in room)', {
    font: { italic: true, color: { rgb: 'FF94A3B8' }, sz: 9 },
    alignment: { horizontal: 'left' },
  });

  // Row 2 — header: Name | (blank) | date1 | ... | Grand Total
  writeCell(isoWs, 2, 0, 'Name', HEADER_STYLE);
  writeCell(isoWs, 2, 1, '', HEADER_STYLE);
  dates.forEach((ds, i) => {
    writeCell(isoWs, 2, 2 + i, dateFromStr(ds), { ...HEADER_STYLE, numFmt: 'dd-mmm' });
  });
  const isoGrandCol = 2 + dates.length;
  writeCell(isoWs, 2, isoGrandCol, 'Total (h)', HEADER_STYLE);

  // Per-person rows
  const isoColTotals = new Array(dates.length).fill(0);
  names.forEach((name, nIdx) => {
    const r = 3 + nIdx;
    writeCell(isoWs, r, 0, name, NAME_CELL_STYLE);
    writeCell(isoWs, r, 1, '', BLANK_CELL_STYLE);

    let personTotal = 0;
    dates.forEach((ds, dIdx) => {
      const entry = lookup[`${name}|${ds}`];
      const col = 2 + dIdx;
      if (holidayMap[ds]) {
        writeCell(isoWs, r, col, 'H', HOLIDAY_CELL_STYLE);
        return;
      }
      const isoH = entry?.isolationHours || 0;
      if (isoH > 0) {
        const h = Number(isoH.toFixed(2));
        // Red if > 2h, Orange if > 1h, normal otherwise
        let style = NUM_CELL_STYLE;
        if (isoH > 2) style = RED_STYLE;
        else if (isoH > 1) style = ORANGE_STYLE;
        writeCell(isoWs, r, col, h, style);
        personTotal += isoH;
        isoColTotals[dIdx] += isoH;
      } else {
        writeCell(isoWs, r, col, '', BLANK_CELL_STYLE);
      }
    });

    // Person total
    const totalRounded = Number(personTotal.toFixed(2));
    const totalStyle = personTotal > 5 ? RED_STYLE : GRAND_TOTAL_STYLE;
    writeCell(isoWs, r, isoGrandCol, totalRounded, totalStyle);
  });

  // Grand Total row
  // Bug fix: Write 'H' for holiday columns (matching Pivot sheet behavior)
  const isoGrandRow = 3 + names.length;
  writeCell(isoWs, isoGrandRow, 0, 'Grand Total', GRAND_TOTAL_STYLE);
  writeCell(isoWs, isoGrandRow, 1, '', GRAND_TOTAL_STYLE);
  let isoGrandSum = 0;
  isoColTotals.forEach((t, i) => {
    const ds = dates[i];
    const isHoliday = !!holidayMap[ds];
    if (isHoliday) {
      writeCell(isoWs, isoGrandRow, 2 + i, 'H', { ...GRAND_TOTAL_STYLE, font: { bold: true, color: { rgb: 'FF4338CA' } } });
    } else {
      const v = Number(t.toFixed(2));
      isoGrandSum += t;
      writeCell(isoWs, isoGrandRow, 2 + i, v, GRAND_TOTAL_STYLE);
    }
  });
  writeCell(isoWs, isoGrandRow, isoGrandCol, Number(isoGrandSum.toFixed(2)), GRAND_TOTAL_STYLE);

  // Legend
  const isoNoteStart = isoGrandRow + 2;
  writeCell(isoWs, isoNoteStart,     0, 'Note:', NOTE_LABEL_STYLE);
  writeCell(isoWs, isoNoteStart,     1, 'Isolation = participant alone in their room', NOTE_VALUE_STYLE);
  writeCell(isoWs, isoNoteStart + 1, 1, 'Orange', LEGEND_ORANGE_STYLE);
  writeCell(isoWs, isoNoteStart + 1, 2, '1 – 2 hours alone (watch list)', NOTE_VALUE_STYLE);
  writeCell(isoWs, isoNoteStart + 2, 1, 'Red', LEGEND_RED_STYLE);
  writeCell(isoWs, isoNoteStart + 2, 2, '> 2 hours alone (flag)', NOTE_VALUE_STYLE);

  // Column widths
  const isoCols = [{ wch: 24 }, { wch: 4 }];
  dates.forEach(() => isoCols.push({ wch: 9 }));
  isoCols.push({ wch: 12 });
  isoWs['!cols'] = isoCols;
  isoWs['!views'] = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];

  // ════════════════════════════════════════════════════════
  // SHEET 4 — "Break Time" (pivot of break hours per person per day)
  // ════════════════════════════════════════════════════════
  const breakWs = {};

  // Row 0 — day-of-week / Holiday labels
  dates.forEach((ds, i) => {
    const dow = dateFromStr(ds).getDay();
    if (holidayMap[ds]) {
      writeCell(breakWs, 0, 2 + i, 'Holiday', HOLIDAY_LABEL_STYLE);
    } else if (dow === 0) {
      writeCell(breakWs, 0, 2 + i, 'Sunday', DOW_LABEL_STYLE);
    } else if (dow === 6) {
      writeCell(breakWs, 0, 2 + i, 'Saturday', DOW_LABEL_STYLE);
    } else {
      writeCell(breakWs, 0, 2 + i, '', DOW_LABEL_STYLE);
    }
  });

  // Row 1 — title pair
  writeCell(breakWs, 1, 0, 'Break Time', {
    font: { bold: true, color: { rgb: 'FF64748B' }, sz: 10 },
    alignment: { horizontal: 'left' },
  });
  writeCell(breakWs, 1, 1, '(gaps > 5 min)', {
    font: { italic: true, color: { rgb: 'FF94A3B8' }, sz: 9 },
    alignment: { horizontal: 'left' },
  });

  // Row 2 — header: Name | (blank) | date1 | ... | Grand Total
  writeCell(breakWs, 2, 0, 'Name', HEADER_STYLE);
  writeCell(breakWs, 2, 1, '', HEADER_STYLE);
  dates.forEach((ds, i) => {
    writeCell(breakWs, 2, 2 + i, dateFromStr(ds), { ...HEADER_STYLE, numFmt: 'dd-mmm' });
  });
  const breakGrandCol = 2 + dates.length;
  writeCell(breakWs, 2, breakGrandCol, 'Total (h)', HEADER_STYLE);

  // Per-person rows
  const breakColTotals = new Array(dates.length).fill(0);
  names.forEach((name, nIdx) => {
    const r = 3 + nIdx;
    writeCell(breakWs, r, 0, name, NAME_CELL_STYLE);
    writeCell(breakWs, r, 1, '', BLANK_CELL_STYLE);

    let personTotal = 0;
    dates.forEach((ds, dIdx) => {
      const entry = lookup[`${name}|${ds}`];
      const col = 2 + dIdx;
      if (holidayMap[ds]) {
        writeCell(breakWs, r, col, 'H', HOLIDAY_CELL_STYLE);
        return;
      }
      const brkH = entry?.breakHours || 0;
      if (brkH > 0) {
        const h = Number(brkH.toFixed(2));
        // Red if > 2h, Orange if > 1h, normal otherwise
        let style = NUM_CELL_STYLE;
        if (brkH > 2) style = RED_STYLE;
        else if (brkH > 1) style = ORANGE_STYLE;
        writeCell(breakWs, r, col, h, style);
        personTotal += brkH;
        breakColTotals[dIdx] += brkH;
      } else {
        writeCell(breakWs, r, col, '', BLANK_CELL_STYLE);
      }
    });

    // Person total
    const totalRounded = Number(personTotal.toFixed(2));
    const totalStyle = personTotal > 10 ? RED_STYLE : GRAND_TOTAL_STYLE;
    writeCell(breakWs, r, breakGrandCol, totalRounded, totalStyle);
  });

  // Grand Total row
  const breakGrandRow = 3 + names.length;
  writeCell(breakWs, breakGrandRow, 0, 'Grand Total', GRAND_TOTAL_STYLE);
  writeCell(breakWs, breakGrandRow, 1, '', GRAND_TOTAL_STYLE);
  let breakGrandSum = 0;
  breakColTotals.forEach((t, i) => {
    const ds = dates[i];
    const isHoliday = !!holidayMap[ds];
    if (isHoliday) {
      writeCell(breakWs, breakGrandRow, 2 + i, 'H', { ...GRAND_TOTAL_STYLE, font: { bold: true, color: { rgb: 'FF4338CA' } } });
    } else {
      const v = Number(t.toFixed(2));
      breakGrandSum += t;
      writeCell(breakWs, breakGrandRow, 2 + i, v, GRAND_TOTAL_STYLE);
    }
  });
  writeCell(breakWs, breakGrandRow, breakGrandCol, Number(breakGrandSum.toFixed(2)), GRAND_TOTAL_STYLE);

  // Legend
  const breakNoteStart = breakGrandRow + 2;
  writeCell(breakWs, breakNoteStart,     0, 'Note:', NOTE_LABEL_STYLE);
  writeCell(breakWs, breakNoteStart,     1, 'Break = gaps > 5 min between snapshots', NOTE_VALUE_STYLE);
  writeCell(breakWs, breakNoteStart + 1, 1, 'Orange', LEGEND_ORANGE_STYLE);
  writeCell(breakWs, breakNoteStart + 1, 2, '1 – 2 hours break (watch list)', NOTE_VALUE_STYLE);
  writeCell(breakWs, breakNoteStart + 2, 1, 'Red', LEGEND_RED_STYLE);
  writeCell(breakWs, breakNoteStart + 2, 2, '> 2 hours break (flag)', NOTE_VALUE_STYLE);

  // Column widths
  const breakCols = [{ wch: 24 }, { wch: 4 }];
  dates.forEach(() => breakCols.push({ wch: 9 }));
  breakCols.push({ wch: 12 });
  breakWs['!cols'] = breakCols;
  breakWs['!views'] = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];

  // ════════════════════════════════════════════════════════
  // SHEET 5 — "Leaves" (absent weekdays per person)
  // ════════════════════════════════════════════════════════
  const leaveWs = {};

  // Build weekdays list (Mon-Fri, excluding holidays)
  const weekdays = dates.filter(ds => !isWeekend(ds) && !holidayMap[ds]);

  // Headers
  writeCell(leaveWs, 0, 0, 'Name', HEADER_STYLE);
  writeCell(leaveWs, 0, 1, 'Working Days', HEADER_STYLE);
  writeCell(leaveWs, 0, 2, 'Days Present', HEADER_STYLE);
  writeCell(leaveWs, 0, 3, 'Leave Days', HEADER_STYLE);
  writeCell(leaveWs, 0, 4, 'Attendance %', HEADER_STYLE);
  writeCell(leaveWs, 0, 5, 'Leave Dates', HEADER_STYLE);

  let totalLeaves = 0;
  names.forEach((name, nIdx) => {
    const r = nIdx + 1;
    let present = 0;
    const absentDates = [];
    weekdays.forEach(ds => {
      const entry = lookup[`${name}|${ds}`];
      // Bug fix: Use same threshold as on-screen Leaves tab (4 hours = Half Day or better)
      // Also check backend status if available
      const status = entry?.status?.toLowerCase();
      const isPresent = status ? (status === 'present' || status === 'half_day') : (entry && entry.hours >= 4);
      if (isPresent) {
        present++;
      } else {
        absentDates.push(ds);
      }
    });
    const leaveCount = absentDates.length;
    totalLeaves += leaveCount;
    const attPct = weekdays.length > 0
      ? Math.round((present / weekdays.length) * 100)
      : 0;

    writeCell(leaveWs, r, 0, name, NAME_CELL_STYLE);
    writeCell(leaveWs, r, 1, weekdays.length, { ...NUM_CELL_STYLE, numFmt: '0' });
    writeCell(leaveWs, r, 2, present, { ...NUM_CELL_STYLE, numFmt: '0' });

    // Leave days — shaded yellow if any leaves
    const leaveStyle = leaveCount > 0
      ? { ...NUM_CELL_STYLE, numFmt: '0', fill: { patternType: 'solid', fgColor: { rgb: 'FFFEF3C7' } }, font: { bold: true, color: { rgb: 'FF92400E' } } }
      : { ...NUM_CELL_STYLE, numFmt: '0' };
    writeCell(leaveWs, r, 3, leaveCount, leaveStyle);

    // Attendance % — red if below 80%
    const pctStyle = attPct < 80
      ? { ...NUM_CELL_STYLE, numFmt: '0"%"', fill: { patternType: 'solid', fgColor: { rgb: 'FFFEE2E2' } }, font: { bold: true, color: { rgb: 'FFB91C1C' } } }
      : { ...NUM_CELL_STYLE, numFmt: '0"%"' };
    writeCell(leaveWs, r, 4, attPct, pctStyle);

    // List of absent dates
    const absentStr = absentDates.length > 0
      ? absentDates.map(d => d.slice(5)).join(', ')  // drop year prefix
      : '—';
    writeCell(leaveWs, r, 5, absentStr, {
      ...BLANK_CELL_STYLE,
      alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
      font: { sz: 10, color: { rgb: 'FF64748B' } },
    });
  });

  // Grand Total row
  const leaveTotalRow = names.length + 1;
  writeCell(leaveWs, leaveTotalRow, 0, 'Total', GRAND_TOTAL_STYLE);
  writeCell(leaveWs, leaveTotalRow, 1, weekdays.length * names.length, { ...GRAND_TOTAL_STYLE, numFmt: '0' });
  writeCell(leaveWs, leaveTotalRow, 2, (weekdays.length * names.length) - totalLeaves, { ...GRAND_TOTAL_STYLE, numFmt: '0' });
  writeCell(leaveWs, leaveTotalRow, 3, totalLeaves, { ...GRAND_TOTAL_STYLE, numFmt: '0' });
  writeCell(leaveWs, leaveTotalRow, 4, '', GRAND_TOTAL_STYLE);
  writeCell(leaveWs, leaveTotalRow, 5, '', GRAND_TOTAL_STYLE);

  leaveWs['!cols'] = [
    { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 60 },
  ];
  leaveWs['!views'] = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  // ════════════════════════════════════════════════════════
  // Assemble and download
  // ════════════════════════════════════════════════════════
  const wb = XLSX.utils.book_new();
  const mon3 = monthName.slice(0, 3);
  XLSX.utils.book_append_sheet(wb, pivotWs,  `${mon3} ${year} Pivot`);
  XLSX.utils.book_append_sheet(wb, isoWs,    `${mon3} ${year} Isolation`);
  XLSX.utils.book_append_sheet(wb, breakWs,  `${mon3} ${year} Break Time`);
  XLSX.utils.book_append_sheet(wb, leaveWs,  `${mon3} ${year} Leaves`);
  XLSX.utils.book_append_sheet(wb, dataWs,   `${mon3} ${year} Data`);

  const safeTeam = teamName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const filename = `Attendance_Report_${safeTeam}_${monthName}_${year}.xlsx`;
  XLSX.writeFile(wb, filename);
}
