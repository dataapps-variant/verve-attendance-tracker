import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchTeams, fetchTeamAttendanceRange } from '../utils/zoomApi';

function istDate() {
  const now = new Date();
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}

function fmtMins(m) {
  if (!m && m !== 0) return '';
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h > 0 && min > 0) return `${h}hr ${min}min`;
  if (h > 0) return `${h}hr`;
  return `${min}min`;
}

// All available columns
const ALL_COLUMNS = [
  { key: 'date', label: 'Date', always: true },
  { key: 'name', label: 'Name', always: true },
  { key: 'email', label: 'Email' },
  { key: 'status', label: 'Status' },
  { key: 'first_seen_ist', label: 'First Seen' },
  { key: 'last_seen_ist', label: 'Last Seen' },
  { key: 'active_minutes', label: 'Active (min)' },
  { key: 'break_minutes', label: 'Break (min)' },
  { key: 'isolation_minutes', label: 'Isolation (min)' },
];

// Filter operators
const OPERATORS = [
  { key: 'gt', label: '>' },
  { key: 'lt', label: '<' },
  { key: 'eq', label: '=' },
  { key: 'gte', label: '>=' },
  { key: 'lte', label: '<=' },
];

const FILTER_FIELDS = [
  { key: 'active_minutes', label: 'Active Minutes' },
  { key: 'break_minutes', label: 'Break Minutes' },
  { key: 'isolation_minutes', label: 'Isolation Minutes' },
  { key: 'status', label: 'Status' },
];

const TEMPLATES_KEY = 'report_builder_templates';

function loadTemplates() {
  try { return JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]'); }
  catch { return []; }
}

function saveTemplates(t) {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(t));
}

export default function ReportBuilder({ user }) {
  const [teams, setTeams] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(istDate);
  const [columns, setColumns] = useState(['date', 'name', 'status', 'active_minutes', 'break_minutes', 'isolation_minutes']);
  const [filters, setFilters] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Templates
  const [templates, setTemplatesState] = useState(loadTemplates);
  const [templateName, setTemplateName] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const isManager = user?.role === 'manager';

  useEffect(() => {
    fetchTeams().then(d => {
      let list = d.teams || [];
      if (isManager && user?.name) {
        list = list.filter(t =>
          (t.manager_name || '').toLowerCase().trim() === user.name.toLowerCase().trim()
          || (t.manager_email || '').toLowerCase().trim() === (user?.email || '').toLowerCase().trim()
        );
      }
      setTeams(list);
      if (list.length > 0) setSelectedTeam(list[0].team_id);
    }).catch(console.error);
  }, [isManager, user?.name, user?.email]);

  // Toggle column
  const toggleCol = (key) => {
    const col = ALL_COLUMNS.find(c => c.key === key);
    if (col?.always) return;
    setColumns(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  // Filters
  const addFilter = () => setFilters(prev => [...prev, { field: 'active_minutes', op: 'lt', value: '300', aggregate: false, days: 0 }]);
  const removeFilter = (i) => setFilters(prev => prev.filter((_, j) => j !== i));
  const updateFilter = (i, key, val) => setFilters(prev => prev.map((f, j) => j === i ? { ...f, [key]: val } : f));

  // Generate report
  const generateReport = useCallback(async () => {
    if (!selectedTeam) return setError('Select a team');
    setLoading(true);
    setError(null);
    try {
      const d = await fetchTeamAttendanceRange(selectedTeam, startDate, endDate);
      setData(d);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [selectedTeam, startDate, endDate]);

  // Apply filters to data
  const filteredData = useMemo(() => {
    if (!data?.daily_data) return [];

    let rows = data.daily_data.map(d => {
      const active = d.active_minutes || 0;
      return {
        ...d,
        status: active >= 300 ? 'present' : active >= 240 ? 'half_day' : 'absent',
      };
    });

    // Simple filters (per-row)
    const simpleFilters = filters.filter(f => !f.aggregate);
    simpleFilters.forEach(f => {
      rows = rows.filter(r => {
        if (f.field === 'status') {
          return f.op === 'eq' ? r.status === f.value : r.status !== f.value;
        }
        const val = parseFloat(r[f.field] || 0);
        const target = parseFloat(f.value);
        switch (f.op) {
          case 'gt': return val > target;
          case 'lt': return val < target;
          case 'gte': return val >= target;
          case 'lte': return val <= target;
          case 'eq': return val === target;
          default: return true;
        }
      });
    });

    // Aggregate filters (e.g. "<5hr on more than 3 days")
    const aggFilters = filters.filter(f => f.aggregate);
    if (aggFilters.length > 0) {
      // Group by name, count matching days
      const nameGroups = {};
      data.daily_data.forEach(d => {
        if (!nameGroups[d.name]) nameGroups[d.name] = [];
        nameGroups[d.name].push(d);
      });

      const allowedNames = new Set();
      Object.entries(nameGroups).forEach(([name, dayRows]) => {
        let allPass = true;
        aggFilters.forEach(f => {
          const matchingDays = dayRows.filter(r => {
            const val = parseFloat(r[f.field] || 0);
            const target = parseFloat(f.value);
            switch (f.op) {
              case 'gt': return val > target;
              case 'lt': return val < target;
              case 'gte': return val >= target;
              case 'lte': return val <= target;
              case 'eq': return val === target;
              default: return true;
            }
          });
          if (matchingDays.length < (parseInt(f.days) || 0)) allPass = false;
        });
        if (allPass) allowedNames.add(name);
      });

      rows = rows.filter(r => allowedNames.has(r.name));
    }

    return rows;
  }, [data, filters]);

  // CSV download
  const downloadCsv = () => {
    if (filteredData.length === 0) return;
    const header = columns.map(k => ALL_COLUMNS.find(c => c.key === k)?.label || k).join(',');
    const csvRows = filteredData.map(r => columns.map(k => {
      const v = r[k] ?? '';
      return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
    }).join(','));
    const csv = header + '\n' + csvRows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report_${startDate}_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Templates
  const saveTemplate = () => {
    if (!templateName.trim()) return;
    const t = { name: templateName.trim(), columns, filters, team: selectedTeam, startDate, endDate };
    const updated = [...templates, t];
    setTemplatesState(updated);
    saveTemplates(updated);
    setTemplateName('');
  };

  const loadTemplate = (t) => {
    setColumns(t.columns || []);
    setFilters(t.filters || []);
    if (t.team) setSelectedTeam(t.team);
    setShowTemplates(false);
  };

  const deleteTemplate = (i) => {
    const updated = templates.filter((_, j) => j !== i);
    setTemplatesState(updated);
    saveTemplates(updated);
  };

  return (
    <div>
      <div style={s.header}>
        <h2 style={s.title}>Report Builder</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowTemplates(!showTemplates)} style={s.tplBtn}>
            {showTemplates ? 'Hide' : 'Templates'} ({templates.length})
          </button>
        </div>
      </div>

      {/* Saved templates */}
      {showTemplates && (
        <div style={s.tplPanel}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Saved Templates</div>
          {templates.length === 0 && <div style={{ color: '#94a3b8', fontSize: 12 }}>No saved templates</div>}
          {templates.map((t, i) => (
            <div key={i} style={s.tplRow}>
              <span style={{ fontWeight: 500, fontSize: 13 }}>{t.name}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => loadTemplate(t)} style={s.tplAction}>Load</button>
                <button onClick={() => deleteTemplate(i)} style={{ ...s.tplAction, color: '#dc2626' }}>Delete</button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="Template name..." style={s.input} />
            <button onClick={saveTemplate} style={s.saveBtn}>Save Current</button>
          </div>
        </div>
      )}

      {/* Config panel */}
      <div style={s.configPanel}>
        {/* Team + Dates */}
        <div style={s.configRow}>
          <label style={s.configLabel}>
            Team
            <select value={selectedTeam} onChange={e => setSelectedTeam(e.target.value)} style={s.select}>
              <option value="">Select team</option>
              {teams.map(t => <option key={t.team_id} value={t.team_id}>{t.team_name}</option>)}
            </select>
          </label>
          <label style={s.configLabel}>
            From
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} style={s.dateInput} />
          </label>
          <label style={s.configLabel}>
            To
            <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} style={s.dateInput} />
          </label>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button onClick={generateReport} disabled={loading} style={s.genBtn}>
              {loading ? 'Loading...' : 'Generate'}
            </button>
          </div>
        </div>

        {/* Column picker */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Columns</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {ALL_COLUMNS.map(c => (
              <button key={c.key} onClick={() => toggleCol(c.key)}
                style={{ ...s.chip, ...(columns.includes(c.key) ? s.chipOn : {}), ...(c.always ? { cursor: 'default', opacity: 0.7 } : {}) }}>
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        <div style={{ marginTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#475569' }}>Filters</div>
            <button onClick={addFilter} style={s.addFilterBtn}>+ Add Filter</button>
          </div>
          {filters.map((f, i) => (
            <div key={i} style={s.filterRow}>
              <select value={f.field} onChange={e => updateFilter(i, 'field', e.target.value)} style={s.filterSelect}>
                {FILTER_FIELDS.map(ff => <option key={ff.key} value={ff.key}>{ff.label}</option>)}
              </select>
              {f.field === 'status' ? (
                <>
                  <select value={f.op} onChange={e => updateFilter(i, 'op', e.target.value)} style={s.filterSelect}>
                    <option value="eq">is</option>
                    <option value="neq">is not</option>
                  </select>
                  <select value={f.value} onChange={e => updateFilter(i, 'value', e.target.value)} style={s.filterSelect}>
                    <option value="Present">Present</option>
                    <option value="Half Day">Half Day</option>
                    <option value="Absent">Absent</option>
                  </select>
                </>
              ) : (
                <>
                  <select value={f.op} onChange={e => updateFilter(i, 'op', e.target.value)} style={s.filterSelect}>
                    {OPERATORS.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                  </select>
                  <input type="number" value={f.value} onChange={e => updateFilter(i, 'value', e.target.value)} style={{ ...s.filterSelect, width: 80 }} placeholder="value" />
                </>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b', cursor: 'pointer' }}>
                <input type="checkbox" checked={f.aggregate || false} onChange={e => updateFilter(i, 'aggregate', e.target.checked)} />
                on more than
              </label>
              {f.aggregate && (
                <input type="number" value={f.days || 0} onChange={e => updateFilter(i, 'days', e.target.value)} style={{ ...s.filterSelect, width: 50 }} placeholder="days" />
              )}
              {f.aggregate && <span style={{ fontSize: 11, color: '#64748b' }}>days</span>}
              <button onClick={() => removeFilter(i)} style={s.removeFilterBtn}>x</button>
            </div>
          ))}
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}

      {/* Results */}
      {filteredData.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: '#64748b' }}>{filteredData.length} rows</div>
            <button onClick={downloadCsv} style={s.csvBtn}>Download CSV</button>
          </div>

          <div style={s.tableWrap}>
            <table style={s.table}>
              <thead>
                <tr>
                  {columns.map(k => {
                    const col = ALL_COLUMNS.find(c => c.key === k);
                    return <th key={k} style={s.th}>{col?.label || k}</th>;
                  })}
                </tr>
              </thead>
              <tbody>
                {filteredData.slice(0, 500).map((r, i) => (
                  <tr key={i} style={i % 2 === 0 ? s.trEven : {}}>
                    {columns.map(k => {
                      let val = r[k] ?? '-';
                      let style = s.td;
                      if (k === 'status') {
                        const st = (val || '').toLowerCase();
                        const color = st === 'present' ? '#15803d' : st === 'half_day' ? '#92400e' : '#dc2626';
                        const bg = st === 'present' ? '#dcfce7' : st === 'half_day' ? '#fef3c7' : '#fef2f2';
                        const label = st === 'present' ? 'Present' : st === 'half_day' ? 'Half Day' : 'Absent';
                        return <td key={k} style={style}><span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color }}>{label}</span></td>;
                      }
                      if (['active_minutes', 'break_minutes', 'isolation_minutes'].includes(k)) {
                        val = typeof val === 'number' ? val : parseInt(val) || 0;
                        return <td key={k} style={style}>{val}</td>;
                      }
                      return <td key={k} style={style}>{val}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredData.length > 500 && <div style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Showing first 500 rows. Download CSV for full data.</div>}
          </div>
        </div>
      )}

      {data && filteredData.length === 0 && !loading && (
        <div style={s.empty}>No rows match your filters.</div>
      )}
    </div>
  );
}

const s = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: 0 },

  tplBtn: { padding: '7px 14px', background: '#f1f5f9', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 12, cursor: 'pointer', color: '#475569' },
  tplPanel: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 },
  tplRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f1f5f9' },
  tplAction: { background: 'none', border: 'none', fontSize: 12, cursor: 'pointer', color: '#3b82f6', fontWeight: 500 },

  configPanel: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 20, marginBottom: 20 },
  configRow: { display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' },
  configLabel: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 500, color: '#475569' },
  select: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff', cursor: 'pointer' },
  dateInput: { padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 },
  input: { flex: 1, padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13 },
  genBtn: { padding: '8px 20px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  saveBtn: { padding: '7px 14px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },

  chip: { padding: '5px 12px', border: '1px solid #d1d5db', borderRadius: 16, background: '#fff', color: '#64748b', fontSize: 12, cursor: 'pointer' },
  chipOn: { background: '#0f172a', color: '#fff', borderColor: '#0f172a' },

  addFilterBtn: { background: 'none', border: 'none', color: '#3b82f6', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  filterRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' },
  filterSelect: { padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' },
  removeFilterBtn: { background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', width: 24, height: 24, borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' },

  error: { padding: '10px 14px', background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 10, fontSize: 13, marginBottom: 16 },
  empty: { textAlign: 'center', padding: '60px 20px', color: '#94a3b8', fontSize: 14 },
  csvBtn: { padding: '7px 14px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' },

  tableWrap: { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', minWidth: 600 },
  th: { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', borderBottom: '1px solid #e5e7eb', background: '#f8fafc', whiteSpace: 'nowrap' },
  td: { padding: '10px 14px', fontSize: 13, color: '#1e293b', borderBottom: '1px solid #f1f5f9' },
  trEven: { background: '#fafbfc' },
};
