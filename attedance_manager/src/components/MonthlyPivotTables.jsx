import { useState, useMemo } from 'react';

/**
 * On-screen pivot tables for the Team View monthly mode. Mirrors the
 * sheets produced by the Download Excel Report (Pivot / Isolation / Leaves)
 * so users get the same picture without downloading.
 */

// Thresholds — must match teamPivotExcel.js
const EARLY_LOGOUT_MAX_HOURS = 7.75;
const OVERTIME_MIN_HOURS = 9.5;
const DAILY_TARGET_HOURS = 8;

function pad2(n) { return String(n).padStart(2, '0'); }

// Format decimal hours (e.g. 3.35) as "3hr 21min" / "3hr" / "21min" / "".
function fmtHoursDecimal(h) {
  if (!h || h <= 0) return '';
  const totalMins = Math.round(h * 60);
  if (totalMins <= 0) return '';
  const hr = Math.floor(totalMins / 60);
  const mn = totalMins % 60;
  if (hr > 0 && mn > 0) return `${hr}hr ${mn}min`;
  if (hr > 0) return `${hr}hr`;
  return `${mn}min`;
}

function dowOf(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function isWeekend(ymd) {
  const dow = dowOf(ymd);
  return dow === 0 || dow === 6;
}

function shortDay(ymd) {
  const [, , d] = ymd.split('-');
  return d;
}

function dayOfWeek(ymd) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dowOf(ymd)];
}

export default function MonthlyPivotTables({ monthlyData, year, month, holidays = [], user, onEditCell }) {
  const canEdit = user?.role === 'superadmin';
  const [view, setView] = useState('hours');

  // Index holidays by date string for quick lookup
  const holidayMap = useMemo(() => {
    const m = {};
    (holidays || []).forEach(h => { if (h?.date) m[h.date] = h.description || 'Holiday'; });
    return m;
  }, [holidays]);

  const { dates, names, lookup, workingDays, weekdays } = useMemo(() => {
    const dailyData = monthlyData?.daily_data || [];
    const dateSet = new Set();
    const daysInMonth = new Date(year, month, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${pad2(month)}-${pad2(d)}`;
      if (!isWeekend(ds)) dateSet.add(ds);
    }
    dailyData.forEach(r => { if (r?.date) dateSet.add(r.date); });
    const datesArr = Array.from(dateSet).sort();

    const nameSet = new Set();
    dailyData.forEach(r => { if (r?.name) nameSet.add(r.name); });
    const namesArr = Array.from(nameSet).sort((a, b) => a.localeCompare(b));

    const lookupMap = {};
    dailyData.forEach(r => {
      if (!r?.name || !r?.date) return;
      const mins = Number(r.active_minutes) || 0;
      const isoMins = Number(r.isolation_minutes) || 0;
      const brkMins = Number(r.break_minutes) || 0;
      lookupMap[`${r.name}|${r.date}`] = {
        hours: mins / 60,
        isolationHours: isoMins / 60,
        breakHours: brkMins / 60,
        status: r.status || null,  // Bug fix: Store status from backend
      };
    });

    // Working days = weekdays minus holidays
    let wd = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${year}-${pad2(month)}-${pad2(d)}`;
      if (!isWeekend(ds) && !holidayMap[ds]) wd++;
    }
    // Weekdays list for Leaves calc excludes both weekends AND holidays
    const weekdaysArr = datesArr.filter(ds => !isWeekend(ds) && !holidayMap[ds]);

    return { dates: datesArr, names: namesArr, lookup: lookupMap, workingDays: wd, weekdays: weekdaysArr };
  }, [monthlyData, year, month, holidayMap]);

  if (!names.length) {
    return <div style={s.empty}>No attendance data for this month.</div>;
  }

  const targetHours = workingDays * DAILY_TARGET_HOURS;

  return (
    <div>
      {/* Sub-tabs */}
      <div style={s.tabBar}>
        <button
          onClick={() => setView('hours')}
          style={{ ...s.tab, ...(view === 'hours' ? s.tabOn : {}) }}
        >
          Hours Pivot
        </button>
        <button
          onClick={() => setView('breaks')}
          style={{ ...s.tab, ...(view === 'breaks' ? s.tabOn : {}) }}
        >
          Break Time
        </button>
        <button
          onClick={() => setView('isolation')}
          style={{ ...s.tab, ...(view === 'isolation' ? s.tabOn : {}) }}
        >
          Isolation
        </button>
        <button
          onClick={() => setView('leaves')}
          style={{ ...s.tab, ...(view === 'leaves' ? s.tabOn : {}) }}
        >
          Leaves
        </button>
      </div>

      {/* Active view */}
      {view === 'hours' && (
        <HoursPivot dates={dates} names={names} lookup={lookup} targetHours={targetHours} workingDays={workingDays} holidayMap={holidayMap} canEdit={canEdit} onEditCell={onEditCell} dailyData={monthlyData?.daily_data} />
      )}
      {view === 'breaks' && (
        <BreakPivot dates={dates} names={names} lookup={lookup} holidayMap={holidayMap} />
      )}
      {view === 'isolation' && (
        <IsolationPivot dates={dates} names={names} lookup={lookup} holidayMap={holidayMap} />
      )}
      {view === 'leaves' && (
        <LeavesTable dates={dates} weekdays={weekdays} names={names} lookup={lookup} holidayMap={holidayMap} />
      )}
    </div>
  );
}

// ─── Hours pivot ─────────────────────────────────────
function HoursPivot({ dates, names, lookup, targetHours, workingDays, holidayMap = {}, canEdit, onEditCell, dailyData = [] }) {
  const colTotals = new Array(dates.length).fill(0);
  const personTotals = {};
  names.forEach(name => {
    let total = 0;
    dates.forEach((ds, i) => {
      const h = lookup[`${name}|${ds}`]?.hours || 0;
      total += h;
      colTotals[i] += h;
    });
    personTotals[name] = total;
  });
  const grandTotal = Object.values(personTotals).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div style={s.legendBar}>
        <LegendItem color="#ffedd5" border="#fdba74" label={`Early logout (< ${EARLY_LOGOUT_MAX_HOURS}h)`} />
        <LegendItem color="#fef9c3" border="#fde047" label={`Overtime (> ${OVERTIME_MIN_HOURS}h)`} />
        <LegendItem color="#fee2e2" border="#fca5a5" label={`Total < ${targetHours}h`} />
        <LegendItem color="#e0e7ff" border="#a5b4fc" label="Holiday" />
        <span style={s.legendMeta}>Working days: <strong>{workingDays}</strong> · Target: <strong>{targetHours}h</strong></span>
      </div>

      <div style={s.tableWrap}>
        <table style={s.pivotTable}>
          <thead>
            <tr>
              <th style={s.stickyNameTh}>Name</th>
              {dates.map(ds => {
                const isHoliday = !!holidayMap[ds];
                const weekendCss = isWeekend(ds) ? s.weekendTh : {};
                const holidayCss = isHoliday ? s.holidayTh : {};
                return (
                  <th key={ds} style={{ ...s.dateTh, ...weekendCss, ...holidayCss }} title={isHoliday ? `Holiday: ${holidayMap[ds]}` : ''}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{shortDay(ds)}</div>
                    <div style={{ fontSize: 9, color: isHoliday ? '#4338ca' : '#94a3b8', fontWeight: 500 }}>
                      {isHoliday ? 'Holiday' : dayOfWeek(ds)}
                    </div>
                  </th>
                );
              })}
              <th style={s.totalTh}>Total</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name, nIdx) => {
              const total = personTotals[name];
              const below = total > 0 && total < targetHours;
              return (
                <tr key={name} style={nIdx % 2 === 0 ? s.trEven : {}}>
                  <td style={s.stickyNameTd}>{name}</td>
                  {dates.map(ds => {
                    const isHoliday = !!holidayMap[ds];
                    const h = lookup[`${name}|${ds}`]?.hours || 0;
                    const editProps = canEdit && onEditCell ? {
                      onClick: () => {
                        const dayRow = dailyData.find(r => r.name === name && r.date === ds);
                        onEditCell({
                          name,
                          first_seen_ist: dayRow?.first_seen_ist || '',
                          last_seen_ist: dayRow?.last_seen_ist || '',
                          status: dayRow?.status?.toLowerCase() || (h >= 5 ? 'present' : h >= 4 ? 'half_day' : 'absent'),
                          total_duration_mins: dayRow?.active_minutes || Math.round(h * 60),
                          break_minutes: dayRow?.break_minutes || 0,
                          isolation_minutes: dayRow?.isolation_minutes || 0,
                        }, ds);
                      },
                      style: { cursor: 'pointer' },
                      title: 'Click to edit',
                    } : {};
                    if (isHoliday) {
                      return (
                        <td key={ds} style={{ ...s.cellTd, background: '#e0e7ff', color: '#4338ca', fontWeight: 700 }} title={holidayMap[ds]}>
                          H{h > 0 ? ` ${fmtHoursDecimal(h)}` : ''}
                        </td>
                      );
                    }
                    let cellStyle = s.cellTd;
                    if (h > 0 && h < EARLY_LOGOUT_MAX_HOURS) cellStyle = { ...s.cellTd, background: '#ffedd5', color: '#9a3412', fontWeight: 600 };
                    else if (h > OVERTIME_MIN_HOURS) cellStyle = { ...s.cellTd, background: '#fef9c3', color: '#854d0e', fontWeight: 600 };
                    return (
                      <td key={ds} {...editProps} style={{ ...cellStyle, ...(editProps.style || {}) }}>
                        {h > 0 ? fmtHoursDecimal(h) : canEdit ? <span style={{ color: '#cbd5e1' }}>·</span> : ''}
                      </td>
                    );
                  })}
                  <td style={{
                    ...s.totalTd,
                    background: below ? '#fee2e2' : '#e2e8f0',
                    color: below ? '#b91c1c' : '#0f172a',
                  }}>
                    {fmtHoursDecimal(total)}
                  </td>
                </tr>
              );
            })}
            <tr style={s.grandRow}>
              <td style={{ ...s.stickyNameTd, background: '#e2e8f0', fontWeight: 800 }}>Grand Total</td>
              {colTotals.map((t, i) => (
                <td key={i} style={{ ...s.cellTd, background: '#e2e8f0', fontWeight: 700 }}>{fmtHoursDecimal(t)}</td>
              ))}
              <td style={{ ...s.totalTd, background: '#cbd5e1', fontWeight: 800 }}>{fmtHoursDecimal(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Break Time pivot ───────────────────────────────
function BreakPivot({ dates, names, lookup, holidayMap = {} }) {
  const colTotals = new Array(dates.length).fill(0);
  const personTotals = {};
  names.forEach(name => {
    let total = 0;
    dates.forEach((ds, i) => {
      const h = lookup[`${name}|${ds}`]?.breakHours || 0;
      total += h;
      colTotals[i] += h;
    });
    personTotals[name] = total;
  });
  const grandTotal = Object.values(personTotals).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div style={s.legendBar}>
        <LegendItem color="#fef9c3" border="#fde047" label="30min – 1h (normal)" />
        <LegendItem color="#ffedd5" border="#fdba74" label="1h – 2h (watch)" />
        <LegendItem color="#fee2e2" border="#fca5a5" label="> 2h (excessive)" />
        <LegendItem color="#e0e7ff" border="#a5b4fc" label="Holiday" />
        <span style={s.legendMeta}>Break = time away from breakout rooms (gaps {'>'} 5 min)</span>
      </div>

      <div style={s.tableWrap}>
        <table style={s.pivotTable}>
          <thead>
            <tr>
              <th style={s.stickyNameTh}>Name</th>
              {dates.map(ds => {
                const isHoliday = !!holidayMap[ds];
                return (
                  <th key={ds} style={{ ...s.dateTh, ...(isWeekend(ds) ? s.weekendTh : {}), ...(isHoliday ? s.holidayTh : {}) }} title={isHoliday ? `Holiday: ${holidayMap[ds]}` : ''}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{shortDay(ds)}</div>
                    <div style={{ fontSize: 9, color: isHoliday ? '#4338ca' : '#94a3b8', fontWeight: 500 }}>
                      {isHoliday ? 'Holiday' : dayOfWeek(ds)}
                    </div>
                  </th>
                );
              })}
              <th style={s.totalTh}>Total</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name, nIdx) => {
              const total = personTotals[name];
              return (
                <tr key={name} style={nIdx % 2 === 0 ? s.trEven : {}}>
                  <td style={s.stickyNameTd}>{name}</td>
                  {dates.map(ds => {
                    const isHoliday = !!holidayMap[ds];
                    const h = lookup[`${name}|${ds}`]?.breakHours || 0;
                    if (isHoliday) {
                      return (
                        <td key={ds} style={{ ...s.cellTd, background: '#e0e7ff', color: '#4338ca', fontWeight: 700 }} title={holidayMap[ds]}>
                          H
                        </td>
                      );
                    }
                    let cellStyle = s.cellTd;
                    if (h > 2) cellStyle = { ...s.cellTd, background: '#fee2e2', color: '#b91c1c', fontWeight: 700 };
                    else if (h > 1) cellStyle = { ...s.cellTd, background: '#ffedd5', color: '#9a3412', fontWeight: 600 };
                    else if (h > 0.5) cellStyle = { ...s.cellTd, background: '#fef9c3', color: '#854d0e', fontWeight: 600 };
                    return (
                      <td key={ds} style={cellStyle}>
                        {fmtHoursDecimal(h)}
                      </td>
                    );
                  })}
                  <td style={{
                    ...s.totalTd,
                    background: total > 10 ? '#fee2e2' : '#e2e8f0',
                    color: total > 10 ? '#b91c1c' : '#0f172a',
                  }}>
                    {fmtHoursDecimal(total)}
                  </td>
                </tr>
              );
            })}
            <tr style={s.grandRow}>
              <td style={{ ...s.stickyNameTd, background: '#e2e8f0', fontWeight: 800 }}>Grand Total</td>
              {colTotals.map((t, i) => (
                <td key={i} style={{ ...s.cellTd, background: '#e2e8f0', fontWeight: 700 }}>{fmtHoursDecimal(t)}</td>
              ))}
              <td style={{ ...s.totalTd, background: '#cbd5e1', fontWeight: 800 }}>{fmtHoursDecimal(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Isolation pivot ─────────────────────────────────
function IsolationPivot({ dates, names, lookup, holidayMap = {} }) {
  const colTotals = new Array(dates.length).fill(0);
  const personTotals = {};
  names.forEach(name => {
    let total = 0;
    dates.forEach((ds, i) => {
      const h = lookup[`${name}|${ds}`]?.isolationHours || 0;
      total += h;
      colTotals[i] += h;
    });
    personTotals[name] = total;
  });
  const grandTotal = Object.values(personTotals).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div style={s.legendBar}>
        <LegendItem color="#ffedd5" border="#fdba74" label="1 – 2 hours alone (watch list)" />
        <LegendItem color="#fee2e2" border="#fca5a5" label="> 2 hours alone (flag)" />
        <LegendItem color="#e0e7ff" border="#a5b4fc" label="Holiday" />
        <span style={s.legendMeta}>Isolation = participant alone in their room</span>
      </div>

      <div style={s.tableWrap}>
        <table style={s.pivotTable}>
          <thead>
            <tr>
              <th style={s.stickyNameTh}>Name</th>
              {dates.map(ds => {
                const isHoliday = !!holidayMap[ds];
                return (
                  <th key={ds} style={{ ...s.dateTh, ...(isWeekend(ds) ? s.weekendTh : {}), ...(isHoliday ? s.holidayTh : {}) }} title={isHoliday ? `Holiday: ${holidayMap[ds]}` : ''}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{shortDay(ds)}</div>
                    <div style={{ fontSize: 9, color: isHoliday ? '#4338ca' : '#94a3b8', fontWeight: 500 }}>
                      {isHoliday ? 'Holiday' : dayOfWeek(ds)}
                    </div>
                  </th>
                );
              })}
              <th style={s.totalTh}>Total</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name, nIdx) => {
              const total = personTotals[name];
              return (
                <tr key={name} style={nIdx % 2 === 0 ? s.trEven : {}}>
                  <td style={s.stickyNameTd}>{name}</td>
                  {dates.map(ds => {
                    const isHoliday = !!holidayMap[ds];
                    const h = lookup[`${name}|${ds}`]?.isolationHours || 0;
                    if (isHoliday) {
                      return (
                        <td key={ds} style={{ ...s.cellTd, background: '#e0e7ff', color: '#4338ca', fontWeight: 700 }} title={holidayMap[ds]}>
                          H
                        </td>
                      );
                    }
                    let cellStyle = s.cellTd;
                    if (h > 2) cellStyle = { ...s.cellTd, background: '#fee2e2', color: '#b91c1c', fontWeight: 700 };
                    else if (h > 1) cellStyle = { ...s.cellTd, background: '#ffedd5', color: '#9a3412', fontWeight: 600 };
                    return (
                      <td key={ds} style={cellStyle}>
                        {fmtHoursDecimal(h)}
                      </td>
                    );
                  })}
                  <td style={{
                    ...s.totalTd,
                    background: total > 5 ? '#fee2e2' : '#e2e8f0',
                    color: total > 5 ? '#b91c1c' : '#0f172a',
                  }}>
                    {fmtHoursDecimal(total)}
                  </td>
                </tr>
              );
            })}
            <tr style={s.grandRow}>
              <td style={{ ...s.stickyNameTd, background: '#e2e8f0', fontWeight: 800 }}>Grand Total</td>
              {colTotals.map((t, i) => (
                <td key={i} style={{ ...s.cellTd, background: '#e2e8f0', fontWeight: 700 }}>{fmtHoursDecimal(t)}</td>
              ))}
              <td style={{ ...s.totalTd, background: '#cbd5e1', fontWeight: 800 }}>{fmtHoursDecimal(grandTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Leaves pivot ────────────────────────────────────
// One cell per (person, weekday) showing P / L / H, matching Hours Pivot.
function LeavesTable({ dates, weekdays, names, lookup, holidayMap = {} }) {
  const holidayCount = Object.keys(holidayMap).length;
  const workingDays = weekdays.length; // weekdays excludes holidays

  // Per-person leave count (counts non-holiday weekdays where status is Absent)
  // Threshold: >= 4 hours = Present/Half Day (P), < 4 hours = Leave (L)
  const PRESENT_THRESHOLD_HOURS = 4; // Matches backend Half Day threshold (240 mins)
  const leaveCountByName = {};
  const presentCountByName = {};
  names.forEach(name => {
    let leaves = 0;
    let present = 0;
    weekdays.forEach(ds => {
      const entry = lookup[`${name}|${ds}`];
      const h = entry?.hours || 0;
      const status = entry?.status?.toLowerCase();
      // Use backend status if available, otherwise check hours threshold
      const isPresent = status ? (status === 'present' || status === 'half_day') : (h >= PRESENT_THRESHOLD_HOURS);
      if (isPresent) present++;
      else leaves++;
    });
    leaveCountByName[name] = leaves;
    presentCountByName[name] = present;
  });

  // Column totals: how many employees were on leave that day
  const colLeaveTotals = dates.map(ds => {
    if (holidayMap[ds]) return null; // holiday column
    return names.reduce((acc, name) => {
      const entry = lookup[`${name}|${ds}`];
      const h = entry?.hours || 0;
      const status = entry?.status?.toLowerCase();
      const isPresent = status ? (status === 'present' || status === 'half_day') : (h >= PRESENT_THRESHOLD_HOURS);
      return acc + (isPresent ? 0 : 1);
    }, 0);
  });

  const totalLeaves = Object.values(leaveCountByName).reduce((a, b) => a + b, 0);

  return (
    <div>
      <div style={s.legendBar}>
        <LegendItem color="#dcfce7" border="#86efac" label="Present (P)" />
        <LegendItem color="#fee2e2" border="#fca5a5" label="Leave (L)" />
        <LegendItem color="#e0e7ff" border="#a5b4fc" label="Holiday (H)" />
        <span style={s.legendMeta}>
          Working days: <strong>{workingDays}</strong>
          {holidayCount > 0 && <> · Holidays: <strong>{holidayCount}</strong></>}
        </span>
      </div>

      <div style={s.tableWrap}>
        <table style={s.pivotTable}>
          <thead>
            <tr>
              <th style={s.stickyNameTh}>Name</th>
              {dates.map(ds => {
                const isHoliday = !!holidayMap[ds];
                return (
                  <th
                    key={ds}
                    style={{ ...s.dateTh, ...(isWeekend(ds) ? s.weekendTh : {}), ...(isHoliday ? s.holidayTh : {}) }}
                    title={isHoliday ? `Holiday: ${holidayMap[ds]}` : ''}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{shortDay(ds)}</div>
                    <div style={{ fontSize: 9, color: isHoliday ? '#4338ca' : '#94a3b8', fontWeight: 500 }}>
                      {isHoliday ? 'Holiday' : dayOfWeek(ds)}
                    </div>
                  </th>
                );
              })}
              <th style={s.totalTh}>Leaves</th>
            </tr>
          </thead>
          <tbody>
            {names.map((name, nIdx) => {
              const personLeaves = leaveCountByName[name] || 0;
              const attPct = workingDays > 0
                ? Math.round((presentCountByName[name] / workingDays) * 100)
                : 0;
              const lowAtt = attPct < 80;
              return (
                <tr key={name} style={nIdx % 2 === 0 ? s.trEven : {}}>
                  <td style={s.stickyNameTd}>
                    <div style={{ fontWeight: 600 }}>{name}</div>
                    <div style={{ fontSize: 10, color: lowAtt ? '#b91c1c' : '#94a3b8', fontWeight: 500 }}>
                      {attPct}% attendance
                    </div>
                  </td>
                  {dates.map(ds => {
                    const isHoliday = !!holidayMap[ds];
                    if (isHoliday) {
                      return (
                        <td
                          key={ds}
                          style={{ ...s.cellTd, background: '#e0e7ff', color: '#4338ca', fontWeight: 700 }}
                          title={holidayMap[ds]}
                        >H</td>
                      );
                    }
                    const entry = lookup[`${name}|${ds}`];
                    const h = entry?.hours || 0;
                    const status = entry?.status?.toLowerCase();
                    // Use backend status if available, otherwise check hours threshold
                    const isPresent = status ? (status === 'present' || status === 'half_day') : (h >= PRESENT_THRESHOLD_HOURS);
                    if (isPresent) {
                      return (
                        <td
                          key={ds}
                          style={{ ...s.cellTd, background: '#dcfce7', color: '#15803d', fontWeight: 700 }}
                        >P</td>
                      );
                    }
                    return (
                      <td
                        key={ds}
                        style={{ ...s.cellTd, background: '#fee2e2', color: '#b91c1c', fontWeight: 700 }}
                      >L</td>
                    );
                  })}
                  <td style={{
                    ...s.totalTd,
                    background: personLeaves > 0 ? '#fef3c7' : '#e2e8f0',
                    color: personLeaves > 0 ? '#92400e' : '#0f172a',
                  }}>
                    {personLeaves}
                  </td>
                </tr>
              );
            })}
            <tr style={s.grandRow}>
              <td style={{ ...s.stickyNameTd, background: '#e2e8f0', fontWeight: 800 }}>Total Leaves</td>
              {dates.map((ds, i) => {
                const isHoliday = !!holidayMap[ds];
                const total = colLeaveTotals[i];
                return (
                  <td key={ds} style={{
                    ...s.cellTd,
                    background: isHoliday ? '#c7d2fe' : '#e2e8f0',
                    color: isHoliday ? '#3730a3' : '#0f172a',
                    fontWeight: 700,
                  }}>
                    {isHoliday ? 'H' : total}
                  </td>
                );
              })}
              <td style={{ ...s.totalTd, background: '#cbd5e1', fontWeight: 800 }}>{totalLeaves}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Legend ──────────────────────────────────────────
function LegendItem({ color, border, label }) {
  return (
    <span style={s.legendItem}>
      <span style={{
        width: 14,
        height: 14,
        background: color,
        border: `1px solid ${border}`,
        borderRadius: 3,
        display: 'inline-block',
      }} />
      <span style={{ fontSize: 11, color: '#475569' }}>{label}</span>
    </span>
  );
}

const s = {
  tabBar: { display: 'flex', gap: 4, background: '#f1f5f9', padding: 3, borderRadius: 8, marginBottom: 14, width: 'fit-content' },
  tab: { padding: '8px 18px', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', background: 'transparent', color: '#64748b' },
  tabOn: { background: '#0f172a', color: '#fff', fontWeight: 600 },

  legendBar: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, padding: '8px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 },
  legendItem: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  legendMeta: { fontSize: 11, color: '#64748b', marginLeft: 'auto' },

  tableWrap: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto', maxWidth: '100%' },
  pivotTable: { borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed' },
  leavesTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },

  stickyNameTh: {
    position: 'sticky', left: 0, zIndex: 2,
    padding: '10px 12px', textAlign: 'left',
    fontSize: 11, fontWeight: 600, color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid #e5e7eb', borderRight: '1px solid #e5e7eb',
    background: '#f8fafc', whiteSpace: 'nowrap', minWidth: 180,
  },
  stickyNameTd: {
    position: 'sticky', left: 0, zIndex: 1,
    padding: '8px 12px', fontSize: 12, color: '#1e293b',
    borderBottom: '1px solid #f1f5f9', borderRight: '1px solid #e5e7eb',
    background: '#fff', fontWeight: 500, whiteSpace: 'nowrap',
  },

  dateTh: {
    padding: '6px 4px', textAlign: 'center',
    borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
    minWidth: 44, width: 44,
  },
  weekendTh: { background: '#eef2f7' },
  holidayTh: { background: '#e0e7ff' },
  totalTh: {
    padding: '10px 12px', textAlign: 'center',
    fontSize: 11, fontWeight: 700, color: '#1e293b',
    background: '#cbd5e1', borderBottom: '1px solid #94a3b8',
    minWidth: 70,
  },

  th: {
    padding: '10px 14px', textAlign: 'left',
    fontSize: 11, fontWeight: 600, color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.04em',
    borderBottom: '1px solid #e5e7eb', background: '#f8fafc',
    whiteSpace: 'nowrap',
  },
  td: { padding: '10px 14px', fontSize: 12, color: '#1e293b', borderBottom: '1px solid #f1f5f9' },

  cellTd: {
    padding: '7px 4px', fontSize: 11, textAlign: 'center',
    color: '#475569', borderBottom: '1px solid #f1f5f9',
    borderRight: '1px solid #f8fafc',
  },
  totalTd: {
    padding: '7px 10px', fontSize: 12, textAlign: 'center',
    fontWeight: 700, borderBottom: '1px solid #e5e7eb',
  },

  trEven: { background: '#fafbfc' },
  grandRow: { borderTop: '2px solid #cbd5e1' },
  empty: { textAlign: 'center', padding: '40px 20px', color: '#94a3b8', fontSize: 14, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12 },
};
